import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";

export class BoundedRegularFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedRegularFileError";
  }
}

interface RegularFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** @internal Deterministic race seam for the synchronous reader contract. */
export interface BoundedRegularFileSyncTestHooks {
  readonly afterRead?: () => void;
}

/** @internal Deterministic race seam for the asynchronous reader contract. */
export interface BoundedRegularFileAsyncTestHooks {
  readonly afterRead?: () => Promise<void> | void;
}

export function readBoundedRegularFileSync(
  path: string,
  maxBytes: number,
  hooks: BoundedRegularFileSyncTestHooks = {},
): string {
  assertMaxBytes(maxBytes);
  let descriptor: number | undefined;
  let value: string | undefined;
  let primaryError: unknown;
  try {
    const before = lstatSync(path, { bigint: true });
    assertRegularFile(before);
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const afterOpen = lstatSync(path, { bigint: true });
    assertSameRegularFile(before, opened, afterOpen);
    value = readBoundedDescriptorSync(descriptor, maxBytes);
    hooks.afterRead?.();
    const afterRead = fstatSync(descriptor, { bigint: true });
    const pathAfterRead = lstatSync(path, { bigint: true });
    assertSameRegularFile(before, opened, afterOpen, afterRead, pathAfterRead);
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  throwReadOrCloseError(primaryError, closeError);
  return value ?? "";
}

export async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  hooks: BoundedRegularFileAsyncTestHooks = {},
): Promise<string> {
  assertMaxBytes(maxBytes);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let value: string | undefined;
  let primaryError: unknown;
  try {
    const before = await lstat(path, { bigint: true });
    assertRegularFile(before);
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    const afterOpen = await lstat(path, { bigint: true });
    assertSameRegularFile(before, opened, afterOpen);
    value = await readBoundedHandle(handle, maxBytes);
    await hooks.afterRead?.();
    const afterRead = await handle.stat({ bigint: true });
    const pathAfterRead = await lstat(path, { bigint: true });
    assertSameRegularFile(before, opened, afterOpen, afterRead, pathAfterRead);
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  throwReadOrCloseError(primaryError, closeError);
  return value ?? "";
}

function readBoundedDescriptorSync(
  descriptor: number,
  maxBytes: number,
): string {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      length,
      buffer.length - length,
      null,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  assertWithinBound(length, maxBytes);
  return buffer.subarray(0, length).toString("utf8");
}

async function readBoundedHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      buffer.length - length,
      null,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  assertWithinBound(length, maxBytes);
  return buffer.subarray(0, length).toString("utf8");
}

function assertMaxBytes(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 16_777_216
  ) {
    throw new TypeError("bounded regular-file byte limit is invalid");
  }
}

function assertWithinBound(length: number, maxBytes: number): void {
  if (length > maxBytes) {
    throw new BoundedRegularFileError(`regular file exceeds ${maxBytes} bytes`);
  }
}

function assertRegularFile(identity: RegularFileIdentity): void {
  if (!identity.isFile() || identity.isSymbolicLink()) {
    throw new BoundedRegularFileError(
      "lifecycle metadata is not a regular non-link file",
    );
  }
}

function assertSameRegularFile(
  ...identities: readonly RegularFileIdentity[]
): void {
  const first = identities[0];
  if (first === undefined) {
    throw new TypeError("regular-file identity proof requires a snapshot");
  }
  for (const identity of identities) assertRegularFile(identity);
  if (
    identities.some((identity) => !sameRegularFileSnapshot(first, identity))
  ) {
    throw new BoundedRegularFileError(
      "lifecycle metadata file identity changed while reading",
    );
  }
}

function sameRegularFileSnapshot(
  left: RegularFileIdentity,
  right: RegularFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function throwReadOrCloseError(
  primaryError: unknown,
  closeError: unknown,
): void {
  if (primaryError !== undefined) {
    if (closeError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "bounded regular-file read and descriptor cleanup both failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (closeError !== undefined) throw closeError;
}
