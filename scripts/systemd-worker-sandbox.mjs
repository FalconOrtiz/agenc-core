import path from "node:path";

export const LOCAL_GATE_AGGREGATE_SLICE = "system-agencgate.slice";
export const LOCAL_GATE_AGGREGATE_CGROUP = "/system.slice/system-agencgate.slice";
export const LOCAL_GATE_AGGREGATE_LIMITS = Object.freeze({
  cpuMax: "800000 100000",
  memoryHigh: "12884901888",
  memoryMax: "17179869184",
  memorySwapMax: "0",
  memoryZswapMax: "0",
  pidsMax: "4096",
});
export const LOCAL_GATE_DOCKER_LIMITS = Object.freeze({
  cpuMax: "800000 100000",
  memoryHigh: "15032385536",
  memoryMax: "17179869184",
  memorySwapMax: "0",
  memoryZswapMax: "0",
  pidsMax: "12288",
});
export const LOCAL_GATE_COMBINED_LIMITS = Object.freeze({
  cpuMax: "1600000 100000",
  memoryHigh: "27917287424",
  memoryMax: "34359738368",
  memorySwapMax: "0",
  memoryZswapMax: "0",
  pidsMax: "16384",
});

function frozenSystemdProperty(property, values = []) {
  return Object.freeze({
    property,
    values: Object.freeze([...values]),
  });
}

export const SYSTEMD_HARDENING_BASELINE = Object.freeze({
  type: frozenSystemdProperty("Type", ["exec"]),
  exitType: frozenSystemdProperty("ExitType", ["main"]),
  killMode: frozenSystemdProperty("KillMode", ["control-group"]),
  sendSigkill: frozenSystemdProperty("SendSIGKILL", ["yes"]),
  timeoutStopSec: frozenSystemdProperty("TimeoutStopSec", ["30s"]),
  runtimeMaxSec: frozenSystemdProperty("RuntimeMaxSec"),
  restart: frozenSystemdProperty("Restart", ["no"]),
  bindsTo: frozenSystemdProperty("BindsTo"),
  partOf: frozenSystemdProperty("PartOf"),
  loadCredentialEncrypted: frozenSystemdProperty("LoadCredentialEncrypted"),
  noNewPrivileges: frozenSystemdProperty("NoNewPrivileges", ["yes"]),
  capabilityBoundingSet: frozenSystemdProperty("CapabilityBoundingSet", [""]),
  ambientCapabilities: frozenSystemdProperty("AmbientCapabilities", [""]),
  supplementaryGroups: frozenSystemdProperty("SupplementaryGroups"),
  protectSystem: frozenSystemdProperty("ProtectSystem", ["strict"]),
  protectHome: frozenSystemdProperty("ProtectHome", ["yes"]),
  temporaryFileSystems: frozenSystemdProperty("TemporaryFileSystem"),
  privateTmp: frozenSystemdProperty("PrivateTmp", ["yes"]),
  privateDevices: frozenSystemdProperty("PrivateDevices", ["yes"]),
  privateIpc: frozenSystemdProperty("PrivateIPC", ["yes"]),
  protectHostname: frozenSystemdProperty("ProtectHostname", ["yes"]),
  keyringMode: frozenSystemdProperty("KeyringMode", ["private"]),
  protectKernelTunables: frozenSystemdProperty("ProtectKernelTunables", ["yes"]),
  protectKernelModules: frozenSystemdProperty("ProtectKernelModules", ["yes"]),
  protectKernelLogs: frozenSystemdProperty("ProtectKernelLogs", ["yes"]),
  protectControlGroups: frozenSystemdProperty("ProtectControlGroups", ["yes"]),
  protectClock: frozenSystemdProperty("ProtectClock", ["yes"]),
  protectProc: frozenSystemdProperty("ProtectProc", ["invisible"]),
  procSubset: frozenSystemdProperty("ProcSubset", ["pid"]),
  privateNetwork: frozenSystemdProperty("PrivateNetwork"),
  ipAddressDeny: frozenSystemdProperty("IPAddressDeny"),
  restrictAddressFamilies: frozenSystemdProperty(
    "RestrictAddressFamilies",
    ["AF_UNIX AF_INET AF_INET6"],
  ),
  restrictNamespaces: frozenSystemdProperty("RestrictNamespaces", ["yes"]),
  restrictSuidSgid: frozenSystemdProperty("RestrictSUIDSGID", ["yes"]),
  lockPersonality: frozenSystemdProperty("LockPersonality", ["yes"]),
  restrictRealtime: frozenSystemdProperty("RestrictRealtime", ["yes"]),
  systemCallArchitectures: frozenSystemdProperty(
    "SystemCallArchitectures",
    ["native"],
  ),
  tasksMax: frozenSystemdProperty("TasksMax", ["64"]),
  cpuQuota: frozenSystemdProperty("CPUQuota", ["100%"]),
  memoryMax: frozenSystemdProperty("MemoryMax", ["512M"]),
  memorySwapMax: frozenSystemdProperty("MemorySwapMax", ["0"]),
  oomPolicy: frozenSystemdProperty("OOMPolicy", ["kill"]),
  limitFsize: frozenSystemdProperty("LimitFSIZE", ["16M"]),
  limitCore: frozenSystemdProperty("LimitCORE", ["0"]),
  limitNofile: frozenSystemdProperty("LimitNOFILE", ["1024"]),
  umask: frozenSystemdProperty("UMask", ["0077"]),
  runTemporaryFileSystems: frozenSystemdProperty("TemporaryFileSystem"),
  readOnlyPaths: frozenSystemdProperty("ReadOnlyPaths"),
  inaccessiblePaths: frozenSystemdProperty("InaccessiblePaths"),
  inaccessibleDockerPaths: frozenSystemdProperty("InaccessiblePaths", [
    "-/var/run/docker.sock",
    "-/run/docker.sock",
  ]),
  inaccessibleControlPaths: frozenSystemdProperty("InaccessiblePaths", [
    "-/run/dbus/system_bus_socket",
    "-/run/systemd/private",
  ]),
  readWritePaths: frozenSystemdProperty("ReadWritePaths"),
  bindReadOnlyPaths: frozenSystemdProperty("BindReadOnlyPaths"),
});

const SYSTEMD_HARDENING_BASELINE_SLOT_ORDER = Object.freeze(
  Object.keys(SYSTEMD_HARDENING_BASELINE),
);
const systemdPathSlotIndex =
  SYSTEMD_HARDENING_BASELINE_SLOT_ORDER.indexOf("readOnlyPaths");
const SYSTEMD_WORKER_HARDENING_SLOT_ORDER = Object.freeze([
  ...SYSTEMD_HARDENING_BASELINE_SLOT_ORDER.slice(0, systemdPathSlotIndex),
  "readOnlyPaths",
  "inaccessibleControlPaths",
  "inaccessiblePaths",
  "readWritePaths",
  "inaccessibleDockerPaths",
  "bindReadOnlyPaths",
]);

export const SYSTEMD_HARDENING_PROFILE_OVERRIDE_KEYS = Object.freeze({
  worker: Object.freeze([
    "runtimeMaxSec",
    "bindsTo",
    "partOf",
    "supplementaryGroups",
    "protectHome",
    "temporaryFileSystems",
    "privateTmp",
    "privateNetwork",
    "ipAddressDeny",
    "restrictAddressFamilies",
    "tasksMax",
    "cpuQuota",
    "memoryMax",
    "limitFsize",
    "limitNofile",
    "runTemporaryFileSystems",
    "inaccessiblePaths",
    "inaccessibleDockerPaths",
    "readWritePaths",
    "bindReadOnlyPaths",
  ]),
  publisher: Object.freeze([
    "runtimeMaxSec",
    "bindsTo",
    "partOf",
    "loadCredentialEncrypted",
    "supplementaryGroups",
  ]),
  "context-seed-credential": Object.freeze([
    "runtimeMaxSec",
    "bindsTo",
    "partOf",
    "loadCredentialEncrypted",
    "supplementaryGroups",
    "readOnlyPaths",
    "inaccessiblePaths",
  ]),
});

const SYSTEMD_HARDENING_PROFILE_REQUIRED_KEYS = Object.freeze({
  worker: Object.freeze(
    SYSTEMD_HARDENING_PROFILE_OVERRIDE_KEYS.worker.filter(
      (key) => key !== "inaccessibleDockerPaths",
    ),
  ),
  publisher: SYSTEMD_HARDENING_PROFILE_OVERRIDE_KEYS.publisher,
  "context-seed-credential":
    SYSTEMD_HARDENING_PROFILE_OVERRIDE_KEYS["context-seed-credential"],
});

const SYSTEMD_HARDENING_PROFILE_SLOT_ORDER = Object.freeze({
  worker: SYSTEMD_WORKER_HARDENING_SLOT_ORDER,
  publisher: SYSTEMD_HARDENING_BASELINE_SLOT_ORDER,
  "context-seed-credential": SYSTEMD_HARDENING_BASELINE_SLOT_ORDER,
});

export function buildSystemdHardeningProperties(profileName, overrides) {
  if (!Object.hasOwn(SYSTEMD_HARDENING_PROFILE_OVERRIDE_KEYS, profileName)) {
    throw new TypeError(`unknown systemd hardening profile: ${String(profileName)}`);
  }
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError(`systemd ${profileName} hardening overrides must be an object`);
  }
  const allowedKeys = SYSTEMD_HARDENING_PROFILE_OVERRIDE_KEYS[profileName];
  const requiredKeys = SYSTEMD_HARDENING_PROFILE_REQUIRED_KEYS[profileName];
  for (const key of Object.keys(overrides)) {
    if (!allowedKeys.includes(key)) {
      throw new TypeError(`systemd ${profileName} profile cannot override ${key}`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(overrides, key)) {
      throw new TypeError(`systemd ${profileName} profile requires override ${key}`);
    }
  }

  const normalizedOverrides = Object.create(null);
  for (const [key, values] of Object.entries(overrides)) {
    if (
      !Array.isArray(values) ||
      values.some((value) =>
        typeof value !== "string" || value.includes("\0") || /[\r\n]/u.test(value))
    ) {
      throw new TypeError(`systemd ${profileName} override ${key} is invalid`);
    }
    normalizedOverrides[key] = Object.freeze([...values]);
  }
  Object.freeze(normalizedOverrides);

  return Object.freeze(
    SYSTEMD_HARDENING_PROFILE_SLOT_ORDER[profileName].flatMap((key) => {
      const slot = SYSTEMD_HARDENING_BASELINE[key];
      const values = Object.hasOwn(normalizedOverrides, key)
        ? normalizedOverrides[key]
        : slot.values;
      return values.map((value) => `${slot.property}=${value}`);
    }),
  );
}

export function assertCgroupResourceProfile(records, expected) {
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    throw new TypeError("cgroup resource records are invalid");
  }
  const comparisons = [
    ["cpu.max", "cpuMax"],
    ["memory.high", "memoryHigh"],
    ["memory.max", "memoryMax"],
    ["memory.swap.max", "memorySwapMax"],
    ["memory.zswap.max", "memoryZswapMax"],
    ["pids.max", "pidsMax"],
  ];
  for (const [recordName, expectedName] of comparisons) {
    if (records[recordName] !== expected[expectedName]) {
      throw new Error(
        `cgroup ${recordName} is ${String(records[recordName])}; expected ${expected[expectedName]}`,
      );
    }
  }
  const controllers = new Set(String(records["cgroup.subtree_control"] ?? "").trim().split(/\s+/u));
  for (const controller of ["cpu", "memory", "pids"]) {
    if (!controllers.has(controller)) {
      throw new Error(`cgroup subtree does not delegate ${controller}`);
    }
  }
}

export function assertCgroupAncestorCapacity(records, minimum) {
  const numericAtLeast = (name, expectedName, value) => {
    if (value === "max") return;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || BigInt(value) < BigInt(minimum[expectedName])) {
      throw new Error(`ancestor cgroup ${name} is below the reviewed local-gate capacity`);
    }
  };
  numericAtLeast("memory.high", "memoryHigh", records["memory.high"]);
  numericAtLeast("memory.max", "memoryMax", records["memory.max"]);
  numericAtLeast("pids.max", "pidsMax", records["pids.max"]);
  const cpu = /^(max|[1-9][0-9]*) ([1-9][0-9]*)$/u.exec(records["cpu.max"] ?? "");
  const expectedCpu = /^([1-9][0-9]*) ([1-9][0-9]*)$/u.exec(minimum.cpuMax);
  if (
    cpu === null ||
    expectedCpu === null ||
    (cpu[1] !== "max" && BigInt(cpu[1]) * BigInt(expectedCpu[2]) <
      BigInt(expectedCpu[1]) * BigInt(cpu[2]))
  ) {
    throw new Error("ancestor cgroup CPU capacity is below the reviewed local-gate capacity");
  }
}

export function assertDockerCgroupPlacement({
  dockerUid,
  userManager,
  dockerService,
}) {
  if (!Number.isSafeInteger(dockerUid) || dockerUid <= 0) {
    throw new TypeError("Docker cgroup UID is invalid");
  }
  const userSlice = `/user.slice/user-${dockerUid}.slice`;
  const userManagerCgroup = `${userSlice}/user@${dockerUid}.service`;
  if (
    userManager?.ActiveState !== "active" ||
    userManager?.ControlGroup !== userManagerCgroup ||
    userManager?.Delegate !== "yes"
  ) {
    throw new Error("dedicated Docker user manager is outside its active delegated user slice");
  }
  const controllers = new Set(String(userManager.DelegateControllers ?? "").trim().split(/\s+/u));
  for (const controller of ["cpu", "memory", "pids"]) {
    if (!controllers.has(controller)) {
      throw new Error(`dedicated Docker user manager does not delegate ${controller}`);
    }
  }
  if (
    dockerService?.ActiveState !== "active" ||
    !/^[1-9][0-9]*$/u.test(String(dockerService.MainPID ?? "")) ||
    typeof dockerService.ControlGroup !== "string" ||
    !dockerService.ControlGroup.startsWith(`${userManagerCgroup}/`) ||
    !dockerService.ControlGroup.endsWith("/docker.service")
  ) {
    throw new Error("rootless Docker daemon is outside the capped dedicated user slice");
  }
}

function assertSafeUnitName(value) {
  if (typeof value !== "string" || !/^agenc-local-gate-[a-z0-9-]{1,128}$/u.test(value)) {
    throw new TypeError("transient worker unit name is invalid");
  }
  return value;
}

function assertParentUnit(value) {
  if (
    typeof value !== "string" ||
    !/^agenc-local-gate-(?:dispatcher|publish)@(main|pr-[1-9][0-9]{0,9})\.service$/u.test(value)
  ) {
    throw new TypeError("transient worker parent unit is invalid");
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    !/^\/(?:[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*)?$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a safe absolute path`);
  }
  return value;
}

function assertEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("worker environment must be an object");
  }
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        /[\r\n]/u.test(value)
      ) {
        throw new TypeError(`worker environment entry is invalid: ${name}`);
      }
      return `--setenv=${name}=${value}`;
    });
}

export function buildSystemdWorkerCommand({
  unitName,
  parentUnit,
  uid,
  gid,
  cwd,
  environment,
  command,
  args = [],
  readWritePaths = [],
  inaccessiblePaths = [],
  dockerAccess = false,
  dockerSocketPath,
  networkAccess = false,
  collect = false,
  runtimeMaxSeconds,
  memoryMax = "16G",
  cpuQuota = "800%",
  tasksMax = 4096,
}) {
  assertSafeUnitName(unitName);
  assertParentUnit(parentUnit);
  assertPositiveInteger(uid, "worker UID");
  assertPositiveInteger(gid, "worker GID");
  assertAbsolutePath(cwd, "worker cwd");
  assertAbsolutePath(command, "worker command");
  if (!Array.isArray(args) || args.some((value) =>
    typeof value !== "string" || value.includes("\0") || /[\r\n]/u.test(value))) {
    throw new TypeError("worker command arguments are invalid");
  }
  if (
    !Array.isArray(readWritePaths) ||
    readWritePaths.some((value) => {
      assertAbsolutePath(value, "worker writable path");
      return false;
    })
  ) {
    throw new TypeError("worker writable paths are invalid");
  }
  if (
    !Array.isArray(inaccessiblePaths) ||
    inaccessiblePaths.some((value) => {
      assertAbsolutePath(value, "worker inaccessible path");
      return false;
    })
  ) {
    throw new TypeError("worker inaccessible paths are invalid");
  }
  assertPositiveInteger(runtimeMaxSeconds, "worker runtime bound");
  assertPositiveInteger(tasksMax, "worker task bound");
  if (typeof collect !== "boolean") throw new TypeError("worker collection flag is invalid");
  if (typeof networkAccess !== "boolean") throw new TypeError("worker network flag is invalid");
  if (dockerAccess && networkAccess) {
    throw new TypeError("Docker and direct network access are mutually exclusive");
  }
  if (dockerAccess) {
    const expectedSocket = `/run/user/${uid}/docker.sock`;
    if (dockerSocketPath !== expectedSocket) {
      throw new TypeError(`Docker worker socket must be ${expectedSocket}`);
    }
  } else if (dockerSocketPath !== undefined) {
    throw new TypeError("non-Docker worker cannot receive a Docker socket");
  }
  if (typeof memoryMax !== "string" || !/^[1-9][0-9]*[MG]$/u.test(memoryMax)) {
    throw new TypeError("worker memory bound is invalid");
  }
  if (typeof cpuQuota !== "string" || !/^[1-9][0-9]*%$/u.test(cpuQuota)) {
    throw new TypeError("worker CPU quota is invalid");
  }

  const properties = buildSystemdHardeningProperties("worker", {
    runtimeMaxSec: [`${runtimeMaxSeconds}s`],
    bindsTo: [parentUnit],
    partOf: [parentUnit],
    supplementaryGroups: [String(gid)],
    protectHome: [dockerAccess ? "tmpfs" : "yes"],
    temporaryFileSystems: [
      "/tmp:rw,nosuid,nodev,size=512M,nr_inodes=65536,mode=1777",
      "/var/tmp:rw,nosuid,nodev,size=128M,nr_inodes=16384,mode=1777",
    ],
    privateTmp: [],
    privateNetwork: networkAccess ? [] : ["yes"],
    ipAddressDeny: networkAccess ? [] : ["any"],
    restrictAddressFamilies: [
      networkAccess ? "AF_UNIX AF_INET AF_INET6" : "AF_UNIX",
    ],
    tasksMax: [String(tasksMax)],
    cpuQuota: [cpuQuota],
    memoryMax: [memoryMax],
    limitFsize: ["128M"],
    limitNofile: ["4096"],
    runTemporaryFileSystems: networkAccess ? [] : ["/run:ro"],
    inaccessiblePaths: [...inaccessiblePaths],
    inaccessibleDockerPaths: dockerAccess
      ? []
      : ["-/var/run/docker.sock", "-/run/docker.sock"],
    readWritePaths: [...readWritePaths],
    bindReadOnlyPaths: dockerAccess ? [dockerSocketPath] : [],
  });

  return Object.freeze({
    unitName: `${unitName}.service`,
    command: "/usr/bin/systemd-run",
    args: Object.freeze([
      "--system",
      `--slice=${LOCAL_GATE_AGGREGATE_SLICE}`,
      "--no-ask-password",
      "--expand-environment=no",
      "--quiet",
      "--wait",
      ...(collect ? ["--collect"] : []),
      "--pipe",
      "--service-type=exec",
      `--unit=${unitName}`,
      `--uid=${uid}`,
      `--gid=${gid}`,
      `--working-directory=${cwd}`,
      ...properties.map((value) => `--property=${value}`),
      ...assertEnvironment(environment),
      "--",
      command,
      ...args,
    ]),
  });
}

export const JOB_FILESYSTEM_MAX_BYTES = 16 * 1024 * 1024 * 1024;
export const JOB_FILESYSTEM_MAX_INODES = 1_000_000;

export function buildSystemdJobMountCommand({ jobId, parentUnit, mountPath }) {
  if (typeof jobId !== "string" || !/^[0-9a-f]{32}$/u.test(jobId)) {
    throw new TypeError("job filesystem ID is invalid");
  }
  assertParentUnit(parentUnit);
  assertAbsolutePath(mountPath, "job filesystem mount path");
  return Object.freeze({
    source: `agenc-local-gate-job-${jobId}`,
    command: "/usr/bin/systemd-mount",
    args: Object.freeze([
      "--no-ask-password",
      "--quiet",
      "--collect",
      `--property=BindsTo=${parentUnit}`,
      `--property=PartOf=${parentUnit}`,
      `--property=Slice=${LOCAL_GATE_AGGREGATE_SLICE}`,
      `--options=rw,nosuid,nodev,size=16G,nr_inodes=${JOB_FILESYSTEM_MAX_INODES},mode=0711`,
      "--tmpfs",
      `agenc-local-gate-job-${jobId}`,
      mountPath,
    ]),
  });
}

export function buildSystemdJobUnmountCommand(mountPath) {
  assertAbsolutePath(mountPath, "job filesystem mount path");
  return Object.freeze({
    command: "/usr/bin/systemd-mount",
    args: Object.freeze([
      "--no-ask-password",
      "--quiet",
      "--umount",
      mountPath,
    ]),
  });
}

export function buildSystemdPublisherCommand({
  jobId,
  subjectLabel,
  parentUnit,
  nodePath,
  scriptPath,
  credentialPath,
  cwd,
}) {
  if (typeof jobId !== "string" || !/^[0-9a-f]{32}$/u.test(jobId)) {
    throw new TypeError("transient publisher job ID is invalid");
  }
  if (subjectLabel !== "main" && !/^pr-[1-9][0-9]{0,9}$/u.test(subjectLabel)) {
    throw new TypeError("transient publisher subject is invalid");
  }
  assertParentUnit(parentUnit);
  for (const [value, label] of [
    [nodePath, "publisher Node executable"],
    [scriptPath, "publisher script"],
    [credentialPath, "publisher encrypted credential"],
    [cwd, "publisher working directory"],
  ]) {
    assertAbsolutePath(value, label);
  }
  const unitName = `agenc-local-gate-publisher-${jobId}`;
  const properties = buildSystemdHardeningProperties("publisher", {
    runtimeMaxSec: ["300s"],
    bindsTo: [parentUnit],
    partOf: [parentUnit],
    loadCredentialEncrypted: [
      `github-app-private-key:${credentialPath}`,
    ],
    supplementaryGroups: ["0"],
  });
  return Object.freeze({
    unitName: `${unitName}.service`,
    command: "/usr/bin/systemd-run",
    args: Object.freeze([
      "--system",
      `--slice=${LOCAL_GATE_AGGREGATE_SLICE}`,
      "--no-ask-password",
      "--expand-environment=no",
      "--quiet",
      "--wait",
      "--collect",
      "--pipe",
      "--service-type=exec",
      `--unit=${unitName}`,
      "--uid=0",
      "--gid=0",
      `--working-directory=${cwd}`,
      ...properties.map((value) => `--property=${value}`),
      "--setenv=HOME=/nonexistent",
      "--setenv=LANG=C.UTF-8",
      "--setenv=LC_ALL=C.UTF-8",
      "--setenv=NODE_OPTIONS=",
      "--setenv=PATH=/usr/bin:/bin",
      "--setenv=TZ=UTC",
      "--",
      nodePath,
      scriptPath,
      "--publish",
      subjectLabel,
      jobId,
    ]),
  });
}
