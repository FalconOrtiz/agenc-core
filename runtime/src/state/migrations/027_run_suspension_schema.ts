import type { SqlMigration } from "./types.js";

export const RUN_SUSPENSION_SCHEMA_VERSION = 27;

/**
 * Rebuildable projection of canonical same-epoch daemon suspension boundaries.
 * The rollout remains authoritative; this table makes startup selection and
 * idempotent crash-window replay bounded.
 */
export const runSuspensionSchemaMigration: SqlMigration = {
  version: RUN_SUSPENSION_SCHEMA_VERSION,
  name: "run_suspension_schema",
  sql: `
CREATE TABLE IF NOT EXISTS run_suspensions (
  run_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  suspension_event_id TEXT NOT NULL,
  suspension_sequence INTEGER NOT NULL,
  reason TEXT NOT NULL,
  suspended_at TEXT NOT NULL,
  resume_event_id TEXT,
  resume_sequence INTEGER,
  resume_reason TEXT,
  resumed_at TEXT,
  activation_event_id TEXT,
  activation_sequence INTEGER,
  activated_at TEXT,
  PRIMARY KEY (run_id, suspension_event_id),
  FOREIGN KEY (run_id, epoch)
    REFERENCES run_lifecycle_epochs(run_id, epoch) ON DELETE RESTRICT,
  CHECK (length(run_id) > 0),
  CHECK (epoch > 0),
  CHECK (length(suspension_event_id) > 0),
  CHECK (suspension_sequence > 0),
  CHECK (reason = 'daemon_shutdown_idle'),
  CHECK (length(suspended_at) > 0),
  CHECK (
    (resume_event_id IS NULL AND resume_sequence IS NULL
      AND resume_reason IS NULL AND resumed_at IS NULL
      AND activation_event_id IS NULL AND activation_sequence IS NULL
      AND activated_at IS NULL)
    OR
    (resume_event_id IS NOT NULL AND length(resume_event_id) > 0
      AND resume_sequence IS NOT NULL AND resume_sequence > suspension_sequence
      AND resume_reason IN ('daemon_startup_restore', 'explicit_continue')
      AND resumed_at IS NOT NULL AND length(resumed_at) > 0)
  ),
  CHECK (
    (activation_event_id IS NULL AND activation_sequence IS NULL
      AND activated_at IS NULL)
    OR
    (activation_event_id IS NOT NULL AND length(activation_event_id) > 0
      AND activation_sequence IS NOT NULL
      AND activation_sequence > resume_sequence
      AND activated_at IS NOT NULL AND length(activated_at) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_suspensions_resume_event
  ON run_suspensions(run_id, resume_event_id)
  WHERE resume_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_suspensions_unresolved_epoch
  ON run_suspensions(run_id, epoch)
  WHERE resume_event_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_suspensions_activation_event
  ON run_suspensions(run_id, activation_event_id)
  WHERE activation_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_run_suspensions_current
  ON run_suspensions(run_id, epoch DESC, suspension_sequence DESC);

CREATE TABLE IF NOT EXISTS run_runtime_settings (
  run_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  settings_event_id TEXT NOT NULL,
  settings_sequence INTEGER NOT NULL,
  previous_settings_event_id TEXT,
  rollback_of_settings_event_id TEXT,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  pre_plan_mode TEXT,
  auto_mode_active INTEGER NOT NULL,
  bypass_permissions_workspace TEXT,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  profile TEXT,
  reasoning_effort TEXT,
  model_verbosity TEXT,
  service_tier TEXT,
  hooks_disabled INTEGER NOT NULL,
  PRIMARY KEY (run_id, settings_event_id),
  FOREIGN KEY (run_id, epoch)
    REFERENCES run_lifecycle_epochs(run_id, epoch) ON DELETE RESTRICT,
  CHECK (length(run_id) > 0),
  CHECK (epoch > 0),
  CHECK (length(settings_event_id) > 0),
  CHECK (settings_sequence > 0),
  CHECK (previous_settings_event_id IS NULL OR length(previous_settings_event_id) > 0),
  CHECK (rollback_of_settings_event_id IS NULL OR length(rollback_of_settings_event_id) > 0),
  CHECK (reason IN ('initial', 'permission_mode_changed', 'model_provider_changed', 'config_applied', 'hooks_changed', 'compensating_rollback')),
  CHECK (length(changed_at) > 0),
  CHECK (permission_mode IN ('default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto', 'unattended')),
  CHECK (pre_plan_mode IS NULL OR pre_plan_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto', 'unattended')),
  CHECK ((permission_mode = 'plan' AND pre_plan_mode IS NOT NULL) OR (permission_mode <> 'plan' AND pre_plan_mode IS NULL)),
  CHECK (auto_mode_active IN (0, 1)),
  CHECK ((permission_mode = 'auto' AND auto_mode_active = 1) OR permission_mode = 'plan' OR (permission_mode NOT IN ('auto', 'plan') AND auto_mode_active = 0)),
  CHECK (((permission_mode = 'bypassPermissions' OR pre_plan_mode = 'bypassPermissions') AND bypass_permissions_workspace IS NOT NULL AND length(bypass_permissions_workspace) > 0) OR ((permission_mode <> 'bypassPermissions' AND (pre_plan_mode IS NULL OR pre_plan_mode <> 'bypassPermissions')) AND bypass_permissions_workspace IS NULL)),
  CHECK (length(trim(model)) > 0 AND length(model) <= 1024),
  CHECK (length(trim(provider)) > 0 AND length(provider) <= 256),
  CHECK (profile IS NULL OR (length(trim(profile)) > 0 AND length(profile) <= 256)),
  CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'none')),
  CHECK (model_verbosity IS NULL OR model_verbosity IN ('low', 'medium', 'high')),
  CHECK (service_tier IS NULL OR service_tier IN ('fast', 'priority', 'flex')),
  CHECK (hooks_disabled IN (0, 1)),
  CHECK ((reason = 'initial' AND previous_settings_event_id IS NULL AND rollback_of_settings_event_id IS NULL) OR reason <> 'initial'),
  CHECK ((reason = 'compensating_rollback' AND rollback_of_settings_event_id IS NOT NULL) OR (reason <> 'compensating_rollback' AND rollback_of_settings_event_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_runtime_settings_sequence
  ON run_runtime_settings(run_id, settings_sequence);

CREATE INDEX IF NOT EXISTS idx_run_runtime_settings_current
  ON run_runtime_settings(run_id, epoch DESC, settings_sequence DESC);
`,
};
