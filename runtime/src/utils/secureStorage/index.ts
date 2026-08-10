import { isDeepStrictEqual } from 'node:util'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { getAgenCConfigHomeDir } from '../envUtils.js'
import { lockSync } from '../lockfile.js'
import { createFallbackStorage } from './fallbackStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { linuxSecretStorage } from './linuxSecretStorage.js'
import { windowsCredentialStorage } from './windowsCredentialStorage.js'
import { plainTextStorage } from './plainTextStorage.js'

export interface SecureStorageData {
  githubModels?: {
    accessToken: string
    oauthAccessToken?: string
  }
  gemini?: {
    accessToken: string
  }
  agenc?: {
    apiKey?: string
    accessToken: string
    refreshToken?: string
    idToken?: string
    accountId?: string
    profileId?: string
    lastRefreshAt?: number
    lastRefreshFailureAt?: number
  }
  /** AgenC AI subscription OAuth tokens (separate surface from the base API key blob). */
  agencAiOauth?: {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scopes?: string[]
    subscriptionType?: string | null
    rateLimitTier?: string | null
  }
  mcpOAuth?: Record<
    string,
    {
      serverName: string
      serverUrl: string
      accessToken: string
      refreshToken?: string
      expiresAt: number
      scope?: string
      clientId?: string
      clientSecret?: string
      discoveryState?: {
        authorizationServerUrl: string
        resourceMetadataUrl?: string
      }
      stepUpScope?: string
    }
  >
  mcpOAuthClientConfig?: Record<string, { clientSecret: string }>
  mcpXaaIdp?: Record<string, { idToken: string; expiresAt: number }>
  mcpXaaIdpConfig?: Record<string, { clientSecret: string }>
  trustedDeviceToken?: string
  pluginSecrets?: Record<string, Record<string, string>>
  /** xAI OAuth (Sign in with X / Grok subscription) tokens. */
  xaiOauth?: {
    accessToken: string
    refreshToken?: string
    idToken?: string
    expiresAt?: number
    tokenEndpoint?: string
    accountLabel?: string
    lastRefreshAt?: number
    quarantinedAt?: number
    quarantineReason?: string
  }
}

export interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}

const unavailableSecureStorage: SecureStorage = {
  name: 'unavailable-secure-storage',
  read: () => null,
  readAsync: async () => null,
  update: () => ({
    success: false,
    warning:
      'Secure storage is unavailable on this platform without plaintext fallback.',
  }),
  delete: () => true,
}

/**
 * Get the appropriate secure storage implementation for the current platform.
 * Prefers native OS vaults (Keychain, libsecret, Credential Locker) with a plaintext fallback.
 */
export function getSecureStorage(options?: {
  allowPlainTextFallback?: boolean
}): SecureStorage {
  const allowPlainTextFallback = options?.allowPlainTextFallback ?? true

  if (process.platform === 'darwin') {
    return allowPlainTextFallback
      ? createFallbackStorage(macOsKeychainStorage, plainTextStorage)
      : macOsKeychainStorage
  }

  if (process.platform === 'linux') {
    return allowPlainTextFallback
      ? createFallbackStorage(linuxSecretStorage, plainTextStorage)
      : linuxSecretStorage
  }

  if (process.platform === 'win32') {
    return allowPlainTextFallback
      ? createFallbackStorage(windowsCredentialStorage, plainTextStorage)
      : windowsCredentialStorage
  }

  return allowPlainTextFallback ? plainTextStorage : unavailableSecureStorage
}

export type SecureStorageMigrationResult =
  | {
      success: true
      migrated: boolean
      alreadySecure: boolean
      storage: string
    }
  | {
      success: false
      migrated: false
      alreadySecure: false
      storage: string
      reason:
        | 'migration_locked'
        | 'storage_conflict'
        | 'native_write_failed'
        | 'readback_mismatch'
        | 'plaintext_changed'
        | 'plaintext_delete_failed'
    }

type MigrationOperation = () => SecureStorageMigrationResult

const CREDENTIAL_LOCK_STALE_MS = 10 * 60_000

/**
 * Serialize read-modify-write operations on the shared credential blob.
 * Native vault commands are synchronous on several platforms, so the stale
 * window must exceed their complete worst-case sequence rather than relying
 * on an event-loop heartbeat.
 */
export function withCredentialMutationLock<T>(operation: () => T): T {
  const configDir = getAgenCConfigHomeDir()
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const release = lockSync(configDir, {
    lockfilePath: join(configDir, '.credential-storage-mutation.lock'),
    stale: CREDENTIAL_LOCK_STALE_MS,
  })
  try {
    return operation()
  } finally {
    release()
  }
}

function withCredentialMigrationLock(operation: MigrationOperation) {
  const configDir = getAgenCConfigHomeDir()
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  // Lock ordering is refresh -> shared mutation. Refresh persists a rotated
  // grant while holding the refresh lock, so migration must use the same order
  // to avoid deadlock with a concurrent token exchange.
  const releaseRefresh = lockSync(join(configDir, '.xai-oauth-refresh'), {
    realpath: false,
    stale: CREDENTIAL_LOCK_STALE_MS,
  })
  try {
    return withCredentialMutationLock(operation)
  } finally {
    try {
      releaseRefresh()
    } catch {
      // A stale lock is recoverable; do not misreport a completed migration.
    }
  }
}

/**
 * Move the authoritative shared credential blob into the platform-native
 * vault. The plaintext file is removed only after an exact read-back check.
 * Callers receive status only; credential fields never cross this boundary.
 */
export function migratePlainTextStorageToNative(options?: {
  native?: SecureStorage
  plaintext?: SecureStorage
  authoritative?: SecureStorage
  withLock?: (operation: MigrationOperation) => SecureStorageMigrationResult
}): SecureStorageMigrationResult {
  const withLock = options?.withLock ?? withCredentialMigrationLock
  try {
    return withLock(() => migratePlainTextStorageToNativeUnlocked(options))
  } catch {
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: options?.native?.name ?? 'native-secure-storage',
      reason: 'migration_locked',
    }
  }
}

function migratePlainTextStorageToNativeUnlocked(options?: {
  native?: SecureStorage
  plaintext?: SecureStorage
  authoritative?: SecureStorage
}): SecureStorageMigrationResult {
  const native =
    options?.native ?? getSecureStorage({ allowPlainTextFallback: false })
  const plaintext = options?.plaintext ?? plainTextStorage
  const authoritativeStorage = options?.authoritative ?? getSecureStorage()
  const plaintextBefore = plaintext.read()
  const authoritative = authoritativeStorage.read()

  if (plaintextBefore === null) {
    const nativeData = native.read()
    return {
      success: true,
      migrated: false,
      alreadySecure: nativeData !== null,
      storage: nativeData !== null ? native.name : 'none',
    }
  }
  const nativeBefore = native.read()
  if (
    nativeBefore !== null &&
    !isDeepStrictEqual(nativeBefore, plaintextBefore)
  ) {
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: native.name,
      reason: 'storage_conflict',
    }
  }
  if (authoritative === null) {
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: native.name,
      reason: 'native_write_failed',
    }
  }
  if (!isDeepStrictEqual(authoritative, plaintextBefore)) {
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: native.name,
      reason: 'storage_conflict',
    }
  }
  const write = native.update(authoritative)
  if (!write.success) {
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: native.name,
      reason: 'native_write_failed',
    }
  }
  const verified = native.read()
  if (!isDeepStrictEqual(verified, authoritative)) {
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: native.name,
      reason: 'readback_mismatch',
    }
  }
  if (!isDeepStrictEqual(plaintext.read(), plaintextBefore)) {
    // A concurrent writer changed the still-authoritative plaintext after the
    // native copy was made. Remove the stale native copy before returning, or
    // fallback reads would prefer it and shadow the newer credentials.
    if (!native.delete() || native.read() !== null) {
      return {
        success: false,
        migrated: false,
        alreadySecure: false,
        storage: native.name,
        reason: 'readback_mismatch',
      }
    }
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: native.name,
      reason: 'plaintext_changed',
    }
  }
  if (!plaintext.delete()) {
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: native.name,
      reason: 'plaintext_delete_failed',
    }
  }
  if (plaintext.read() !== null) {
    return {
      success: false,
      migrated: false,
      alreadySecure: false,
      storage: native.name,
      reason: 'plaintext_delete_failed',
    }
  }
  return {
    success: true,
    migrated: true,
    alreadySecure: false,
    storage: native.name,
  }
}
