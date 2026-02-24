# Electron Release Gates (Internal)

All gates are command-verifiable. A gate passes only when every listed command exits `0` and every required evidence file exists under `.sisyphus/evidence/`.

## How to run gates

```bash
mkdir -p .sisyphus/evidence
set -o pipefail
```

Use PowerShell on Windows hosts/runners:

```powershell
New-Item -ItemType Directory -Force -Path .sisyphus/evidence | Out-Null
```

## Gate A - Static and Unit Baseline

### Commands

```bash
npm --prefix apps/desktop run typecheck 2>&1 | tee .sisyphus/evidence/gate-a-typecheck.log
npm --prefix apps/desktop run test 2>&1 | tee .sisyphus/evidence/gate-a-test.log
test -s .sisyphus/evidence/gate-a-typecheck.log
test -s .sisyphus/evidence/gate-a-test.log
```

### Evidence

- `.sisyphus/evidence/gate-a-typecheck.log`
- `.sisyphus/evidence/gate-a-test.log`

### Pass Criteria

- Both commands return exit code `0`.
- Both evidence log files exist and are non-empty.

## Gate B - Unpackaged Functional Smoke

### Commands

```bash
npm --prefix apps/desktop run smoke:unpackaged 2>&1 | tee .sisyphus/evidence/gate-b-smoke-unpackaged.log
test -s .sisyphus/evidence/gate-b-smoke-unpackaged.log
test -f .sisyphus/evidence/task-10-smoke-unpackaged-summary.json
```

### Evidence

- `.sisyphus/evidence/gate-b-smoke-unpackaged.log`
- `.sisyphus/evidence/task-10-smoke-unpackaged-summary.json`

### Pass Criteria

- Smoke command returns exit code `0`.
- Gate log exists and is non-empty.
- Summary JSON exists.
- Summary JSON reports status `passed`.

## Gate C - Packaged Build Script Dry-Run

### Commands

```bash
bash scripts/desktop/build-mac.sh --dry-run 2>&1 | tee .sisyphus/evidence/gate-c-build-mac-dry-run.log
test -s .sisyphus/evidence/gate-c-build-mac-dry-run.log
```

```powershell
pwsh -File scripts/desktop/build-win.ps1 -DryRun 2>&1 | Tee-Object -FilePath .sisyphus/evidence/gate-c-build-win-dry-run.log
if (-not (Test-Path .sisyphus/evidence/gate-c-build-win-dry-run.log)) { throw "Missing gate-c-build-win-dry-run.log" }
```

### Evidence

- `.sisyphus/evidence/gate-c-build-mac-dry-run.log`
- `.sisyphus/evidence/gate-c-build-win-dry-run.log`

### Pass Criteria

- Both dry-run commands return exit code `0`.
- Both logs exist and contain the expected "Would execute" line.
- If `pwsh` is unavailable locally, run the Windows command on a Windows host/runner and store the produced log artifact under the same evidence path.

## Gate D - Packaged Runtime Smoke (Platform Hosts)

### Commands

```bash
bash apps/desktop/scripts/smoke-packaged-mac.sh 2>&1 | tee .sisyphus/evidence/gate-d-smoke-packaged-mac.log
test -s .sisyphus/evidence/gate-d-smoke-packaged-mac.log
test -f .sisyphus/evidence/task-10-smoke-packaged-mac-summary.json
```

```powershell
pwsh -File apps/desktop/scripts/smoke-packaged-win.ps1 2>&1 | Tee-Object -FilePath .sisyphus/evidence/gate-d-smoke-packaged-win.log
if (-not (Test-Path .sisyphus/evidence/gate-d-smoke-packaged-win.log)) { throw "Missing gate-d-smoke-packaged-win.log" }
if (-not (Test-Path .sisyphus/evidence/task-10-smoke-packaged-win-summary.json)) { throw "Missing packaged win summary JSON" }
```

### Evidence

- `.sisyphus/evidence/gate-d-smoke-packaged-mac.log`
- `.sisyphus/evidence/task-10-smoke-packaged-mac-summary.json`
- `.sisyphus/evidence/gate-d-smoke-packaged-win.log`
- `.sisyphus/evidence/task-10-smoke-packaged-win-summary.json`

### Pass Criteria

- macOS and Windows packaged smoke both return exit code `0`.
- Both gate logs exist.
- Both summary JSON files exist and report status `passed`.
- Windows smoke is executed on Windows host/runner when local `pwsh` is unavailable.

## Release Gate Execution Order

1. Gate A
2. Gate B
3. Gate C
4. Gate D

Stop on first failed gate. Do not promote a build with any failed gate.

## Rollback Trigger from Gate Failures

If any gate fails after a build has already been circulated internally:

1. Mark build as blocked.
2. Recall current build links.
3. Re-issue last stable version.
4. Attach failed gate evidence paths in incident record.
