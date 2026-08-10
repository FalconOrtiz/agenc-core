import { execaSync } from 'execa'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
  getUsername,
} from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData } from './index.js'

/**
 * `secret-tool` is not installed on every desktop that exposes a working
 * freedesktop Secret Service. Python's small `secretstorage` binding gives us
 * a second native-vault path without placing credentials in argv or the
 * environment. `-I` prevents user-controlled Python import paths from being
 * consulted. The script's stdout is captured by the caller and never logged.
 */
const PYTHON_SECRET_STORAGE_SCRIPT = String.raw`
import sys

try:
    import secretstorage

    operation, service_name, account_name = sys.argv[1:4]
    bus = secretstorage.dbus_init()
    collection = secretstorage.get_default_collection(bus)
    # secretstorage returns False when unlock succeeds and True when the user
    # dismisses the prompt. Re-check the object as well so a backend that did
    # not actually unlock cannot be treated as usable.
    if collection.is_locked():
        dismissed = collection.unlock(timeout=15)
        if dismissed or collection.is_locked():
            raise RuntimeError("Secret Service collection is locked")

    attributes = {"service": service_name, "account": account_name}
    if operation == "read":
        items = list(collection.search_items(attributes))
        if not items:
            raise SystemExit(1)
        item = items[0]
        if item.is_locked():
            dismissed = item.unlock(timeout=15)
            if dismissed or item.is_locked():
                raise RuntimeError("Secret Service item is locked")
        sys.stdout.buffer.write(item.get_secret())
    elif operation == "update":
        payload = sys.stdin.buffer.read()
        if not payload:
            raise RuntimeError("Missing credential payload")
        collection.create_item(
            service_name,
            attributes,
            payload,
            replace=True,
            content_type="application/json",
        )
    elif operation == "delete":
        for item in collection.search_items(attributes):
            item.delete()
    else:
        raise RuntimeError("Unknown Secret Service operation")
except SystemExit:
    raise
except Exception:
    raise SystemExit(70)
`

function pythonSecretService(
  operation: 'read' | 'update' | 'delete',
  serviceName: string,
  username: string,
  input?: string,
) {
  return execaSync(
    'python3',
    [
      '-I',
      '-c',
      PYTHON_SECRET_STORAGE_SCRIPT,
      operation,
      serviceName,
      username,
    ],
    {
      ...(input === undefined ? {} : { input }),
      reject: false,
      timeout: 20_000,
    },
  )
}

function secretTool(args: string[], input?: string) {
  try {
    return execaSync('secret-tool', args, {
      ...(input === undefined ? {} : { input }),
      reject: false,
      timeout: 20_000,
    })
  } catch {
    return undefined
  }
}

/**
 * Linux-specific secure storage implementation using the secret-tool CLI.
 * secret-tool interacts with the Secret Service API (GNOME Keyring, KWallet, etc.).
 */
export const linuxSecretStorage: SecureStorage = {
  name: 'libsecret',
  read(): SecureStorageData | null {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      // secret-tool lookup service [service] account [account]
      const result = secretTool([
        'lookup',
        'service',
        serviceName,
        'account',
        username,
      ])

      if (result?.exitCode === 0 && result.stdout) {
        return jsonParse(result.stdout)
      }
      const pythonResult = pythonSecretService('read', serviceName, username)
      if (pythonResult.exitCode === 0 && pythonResult.stdout) {
        return jsonParse(pythonResult.stdout)
      }
    } catch {
      // fall through
    }
    return null
  },
  async readAsync(): Promise<SecureStorageData | null> {
    // Reusing sync implementation for simplicity as it wraps a CLI call
    return this.read()
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const payload = jsonStringify(data)
      // secret-tool store --label=[label] service [service] account [account]
      // The payload is passed via stdin
      const result = secretTool(
        [
          'store',
          '--label',
          serviceName,
          'service',
          serviceName,
          'account',
          username,
        ],
        payload,
      )
      if (result?.exitCode === 0) return { success: true }

      const pythonResult = pythonSecretService(
        'update',
        serviceName,
        username,
        payload,
      )
      return { success: pythonResult.exitCode === 0 }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      // secret-tool clear service [service] account [account]
      const result = secretTool([
        'clear',
        'service',
        serviceName,
        'account',
        username,
      ])
      if (result?.exitCode === 0) return true
      return (
        pythonSecretService('delete', serviceName, username).exitCode === 0
      )
    } catch {
      return false
    }
  },
}
