import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { getAgenCConfigHomeDir } from '../envUtils.js'
import { lockSync } from '../lockfile.js'
import { getSecureStorage } from './index.js'
import type { SecureStorage, SecureStorageData } from './index.js'

function withSharedCredentialLock<T>(operation: () => T): T {
  const configDir = getAgenCConfigHomeDir()
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const release = lockSync(configDir, {
    lockfilePath: join(configDir, '.credential-storage-mutation.lock'),
    stale: 10 * 60_000,
  })
  try {
    return operation()
  } finally {
    release()
  }
}

/**
 * Atomic shared credential-blob mutation. Kept in a small module so tests that
 * replace the platform storage adapter still exercise caller merge logic.
 */
export function mutateSecureStorage(
  mutate: (current: SecureStorageData) => SecureStorageData | null,
  options?: { storage?: SecureStorage },
): { success: boolean; warning?: string } {
  try {
    return withSharedCredentialLock(() => {
      const storage = options?.storage ?? getSecureStorage()
      const current = storage.read() || {}
      const next = mutate(current)
      return next === null ? { success: true } : storage.update(next)
    })
  } catch {
    return {
      success: false,
      warning: 'Credential storage is busy; no credentials were changed.',
    }
  }
}
