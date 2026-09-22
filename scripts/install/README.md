# Standalone installer source

`runtime-installer.cjs` contains the JavaScript program shared by
`install.sh` and `install.ps1`. Edit that file when shared installer
behavior changes. The JavaScript between the generated program markers in the
two platform wrappers must not be edited by hand.

Regenerate both wrappers after changing the canonical program or one of its
embedded launcher modules:

```sh
node scripts/sync-installer-sqlite-lock.mjs --write
```

The default mode and `--check` are read-only. Both exit with a nonzero status
when the canonical program or either wrapper is stale:

```sh
node scripts/sync-installer-sqlite-lock.mjs
node scripts/sync-installer-sqlite-lock.mjs --check
```

Generated files use UTF-8 without a byte-order mark and LF line endings. The
generator leaves the shell and PowerShell bootstrap code outside the marked
program unchanged.

Check both platform parsers before committing installer changes:

```sh
sh -n scripts/install/install.sh
pwsh -NoLogo -NoProfile -Command \
  "\$null = [scriptblock]::Create((Get-Content -Raw scripts/install/install.ps1))"
```
