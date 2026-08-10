import { describe, expect, test, vi } from "vitest";

import {
  migratePlainTextStorageToNative,
  type SecureStorage,
  type SecureStorageData,
} from "../../../src/utils/secureStorage/index.js";

function storage(
  name: string,
  initial: SecureStorageData | null,
  options: { write?: boolean; readAfterWrite?: SecureStorageData | null; delete?: boolean } = {},
): SecureStorage & {
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  let value = initial;
  return {
    name,
    read: () => value,
    readAsync: async () => value,
    update: vi.fn((next: SecureStorageData) => {
      if (options.write === false) return { success: false };
      value = options.readAfterWrite ?? next;
      return { success: true };
    }),
    delete: vi.fn(() => {
      if (options.delete === false) return false;
      value = null;
      return true;
    }),
  };
}

describe("plaintext-to-native credential migration", () => {
  const credentials = {
    xaiOauth: {
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
    },
    pluginSecrets: { example: { token: "plugin-secret" } },
  };

  test("writes the full authoritative blob, verifies it, then deletes plaintext", () => {
    const native = storage("libsecret", null);
    const plaintext = storage("plaintext", credentials);
    const authoritative = storage("combined", credentials);
    const result = migratePlainTextStorageToNative({
      native,
      plaintext,
      authoritative,
      withLock: (operation) => operation(),
    });
    expect(result).toEqual({
      success: true,
      migrated: true,
      alreadySecure: false,
      storage: "libsecret",
    });
    expect(native.update).toHaveBeenCalledWith(credentials);
    expect(plaintext.delete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("secret-access");
    expect(JSON.stringify(result)).not.toContain("plugin-secret");
  });

  test("retains plaintext when the native write fails", () => {
    const native = storage("libsecret", null, { write: false });
    const plaintext = storage("plaintext", credentials);
    const result = migratePlainTextStorageToNative({
      native,
      plaintext,
      authoritative: storage("combined", credentials),
      withLock: (operation) => operation(),
    });
    expect(result).toMatchObject({
      success: false,
      reason: "native_write_failed",
    });
    expect(plaintext.delete).not.toHaveBeenCalled();
  });

  test("retains plaintext when exact read-back verification fails", () => {
    const native = storage("libsecret", null, {
      readAfterWrite: { xaiOauth: { accessToken: "different" } },
    });
    const plaintext = storage("plaintext", credentials);
    const result = migratePlainTextStorageToNative({
      native,
      plaintext,
      authoritative: storage("combined", credentials),
      withLock: (operation) => operation(),
    });
    expect(result).toMatchObject({
      success: false,
      reason: "readback_mismatch",
    });
    expect(plaintext.delete).not.toHaveBeenCalled();
  });

  test("reports deletion failure after a verified secure write", () => {
    const native = storage("libsecret", null);
    const plaintext = storage("plaintext", credentials, { delete: false });
    const result = migratePlainTextStorageToNative({
      native,
      plaintext,
      authoritative: storage("combined", credentials),
      withLock: (operation) => operation(),
    });
    expect(result).toMatchObject({
      success: false,
      reason: "plaintext_delete_failed",
    });
    expect(native.update).toHaveBeenCalledTimes(1);
  });

  test("removes a stale native copy when plaintext changes during migration", () => {
    const changed = {
      ...credentials,
      pluginSecrets: { example: { token: "newer-plugin-secret" } },
    };
    const native = storage("libsecret", null);
    let reads = 0;
    const plaintext: SecureStorage = {
      name: "plaintext",
      read: () => (reads++ === 0 ? credentials : changed),
      readAsync: async () => changed,
      update: () => ({ success: true }),
      delete: () => true,
    };
    const result = migratePlainTextStorageToNative({
      native,
      plaintext,
      authoritative: storage("combined", credentials),
      withLock: (operation) => operation(),
    });
    expect(result).toMatchObject({ success: false, reason: "plaintext_changed" });
    expect(native.delete).toHaveBeenCalledTimes(1);
    expect(native.read()).toBeNull();
  });

  test("is a no-op when no plaintext fallback exists", () => {
    const native = storage("libsecret", credentials);
    const plaintext = storage("plaintext", null);
    const result = migratePlainTextStorageToNative({
      native,
      plaintext,
      authoritative: native,
      withLock: (operation) => operation(),
    });
    expect(result).toEqual({
      success: true,
      migrated: false,
      alreadySecure: true,
      storage: "libsecret",
    });
    expect(native.update).not.toHaveBeenCalled();
    expect(plaintext.delete).not.toHaveBeenCalled();
  });
});
