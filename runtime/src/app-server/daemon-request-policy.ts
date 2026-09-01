export const AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV =
  "AGENC_DAEMON_REQUEST_TIMEOUT_MS";

/** Largest delay Node can schedule without clamping it to one millisecond. */
export const MAX_DAEMON_REQUEST_TIMEOUT_MS = 2_147_483_647;

declare const daemonRequestTimeoutMsBrand: unique symbol;

export type DaemonRequestTimeoutMs = number & {
  readonly [daemonRequestTimeoutMsBrand]: true;
};

export function resolveAgenCDaemonRequestTimeoutMs(
  env: NodeJS.ProcessEnv,
  defaultTimeoutMs: number,
): DaemonRequestTimeoutMs {
  const configured = env[AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV]?.trim();
  if (configured === undefined || configured.length === 0) {
    return asDaemonRequestTimeoutMs(defaultTimeoutMs, "default timeout");
  }
  if (!/^[1-9]\d*$/u.test(configured)) {
    throw invalidDaemonRequestTimeoutError();
  }
  return asDaemonRequestTimeoutMs(Number(configured), "configured timeout");
}

function asDaemonRequestTimeoutMs(
  value: number,
  source: string,
): DaemonRequestTimeoutMs {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_DAEMON_REQUEST_TIMEOUT_MS
  ) {
    if (source === "configured timeout") {
      throw invalidDaemonRequestTimeoutError();
    }
    throw new Error(
      `${source} must be an integer between 1 and ${MAX_DAEMON_REQUEST_TIMEOUT_MS}`,
    );
  }
  return value as DaemonRequestTimeoutMs;
}

function invalidDaemonRequestTimeoutError(): Error {
  return new Error(
    `${AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV} must be a positive integer no greater than ${MAX_DAEMON_REQUEST_TIMEOUT_MS}`,
  );
}
