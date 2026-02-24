# Electron Internal Runbook

This runbook is command-first. Pass/fail truth comes from process `exit code` and generated JSON evidence under `.sisyphus/evidence/`.

## Preconditions

1. Run from repo root.
2. Install desktop dependencies first:

```bash
npm --prefix apps/desktop ci
```

3. Backend default for MVP is `pipeline` (contract requirement).
4. If local host does not provide `pwsh`, execute Windows commands on a Windows runner/host.

## Evidence Collection Rules

1. Keep all outputs under `.sisyphus/evidence/`.
2. For smoke runs, preserve generated files such as:
   - `.sisyphus/evidence/task-10-smoke-unpackaged-summary.json`
   - `.sisyphus/evidence/task-10-smoke-packaged-mac-summary.json`
   - `.sisyphus/evidence/task-10-smoke-packaged-win-summary.json`
3. For each command, capture stdout/stderr to a matching log file in `.sisyphus/evidence/`.
4. A command is passing only when exit code is `0` and expected evidence file exists.

## How to run gates

Prepare deterministic evidence output before running any gate commands:

```bash
mkdir -p .sisyphus/evidence
set -o pipefail
```

On Windows hosts/runners:

```powershell
New-Item -ItemType Directory -Force -Path .sisyphus/evidence | Out-Null
```

Use the exact Gate A/B/C/D command blocks in `docs/en/electron_release_gates.md` so required gate logs are generated via `tee`/`Tee-Object` with stderr included.

## Unpackaged Verification Flow

1. Typecheck:

```bash
npm --prefix apps/desktop run typecheck
```

2. Tests:

```bash
npm --prefix apps/desktop run test
```

3. Unpackaged smoke:

```bash
npm --prefix apps/desktop run smoke:unpackaged
```

4. Verify smoke evidence:

```bash
test -f .sisyphus/evidence/task-10-smoke-unpackaged-summary.json
```

## Packaged Verification Flow

### macOS

1. Dry-run packaging script:

```bash
bash scripts/desktop/build-mac.sh --dry-run
```

2. Packaged smoke on macOS host:

```bash
bash apps/desktop/scripts/smoke-packaged-mac.sh
```

3. Verify smoke evidence:

```bash
test -f .sisyphus/evidence/task-10-smoke-packaged-mac-summary.json
```

### Windows

1. Dry-run packaging script (Windows host/runner):

```powershell
pwsh -File scripts/desktop/build-win.ps1 -DryRun
```

2. Packaged smoke on Windows host/runner:

```powershell
pwsh -File apps/desktop/scripts/smoke-packaged-win.ps1
```

3. Verify smoke evidence:

```powershell
Test-Path .sisyphus/evidence/task-10-smoke-packaged-win-summary.json
```

## Incident Triage (Deterministic)

Use the contract as source of truth: `exit code + result.json + deterministic errorCode`.

1. Locate failing run evidence in `.sisyphus/evidence/` and associated `result.json` in output directory.
2. Map `errorCode` exactly:
   - `E_INVALID_INPUT`: invalid input path/options
   - `E_ENGINE_FAILED`: engine failure/abnormal termination
   - `E_CANCELLED`: cancellation path
   - `E_TIMEOUT`: timeout path
   - `E_OUTPUT_UNWRITABLE`: output directory create/write failure
3. Confirm exit code mapping:
   - `0`: succeeded
   - `1`: failed (general)
   - `2`: invalid input
   - `3`: output unwritable
   - `4`: cancelled
   - `5`: timeout
4. Reject conclusions based only on human log interpretation; logs are supplemental.

## Rollback and Version Recall

Use this procedure when release gates fail or post-release regression is reported.

1. Freeze rollout: stop sharing current build immediately.
2. Identify last stable version from release manifest/history and internal share record.
3. Re-publish only the last stable package set and its checksum manifest.
4. Re-run minimal validation on recalled build:

```bash
npm --prefix apps/desktop run smoke:unpackaged
bash apps/desktop/scripts/smoke-packaged-mac.sh
```

```powershell
pwsh -File apps/desktop/scripts/smoke-packaged-win.ps1
```

5. Store rollback evidence under `.sisyphus/evidence/rollback-<version>/`.
6. Open incident note with root cause category (`build`, `runtime`, `engine`, `environment`) and linked evidence paths.

## Release Decision Rule

Do not release unless all gates in `docs/en/electron_release_gates.md` pass with command exit code `0` and required evidence files present.
