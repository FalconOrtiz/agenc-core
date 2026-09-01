export type SerializedUtf8SizeResult =
  | {
      readonly status: "measured";
      readonly bytes: number;
    }
  | {
      readonly status: "unserializable";
      readonly bytes: 0;
      readonly reason:
        | "json_stringify_returned_undefined"
        | "json_stringify_threw";
    };

/** Measure the compact JSON representation used by rollout persistence. */
export function measureSerializedUtf8Bytes(
  value: unknown,
): SerializedUtf8SizeResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return {
      status: "unserializable",
      bytes: 0,
      reason: "json_stringify_threw",
    };
  }
  if (serialized === undefined) {
    return {
      status: "unserializable",
      bytes: 0,
      reason: "json_stringify_returned_undefined",
    };
  }
  return {
    status: "measured",
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/** Preserve the index's zero fallback while keeping failure typed upstream. */
export function serializedUtf8BytesOrZero(value: unknown): number {
  return measureSerializedUtf8Bytes(value).bytes;
}
