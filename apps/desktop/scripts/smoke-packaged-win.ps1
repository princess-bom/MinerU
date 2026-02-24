#!/usr/bin/env pwsh

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'smoke-packaged-win.ps1 must run on Windows'
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = Resolve-Path (Join-Path $ScriptDir '..')
$ReleaseDir = Join-Path $DesktopDir 'release'
$RunnerPath = Join-Path $ScriptDir 'smoke-unpackaged.cjs'

if (-not (Test-Path -Path $ReleaseDir)) {
  throw "Missing release directory: $ReleaseDir"
}

if (-not (Test-Path -Path $RunnerPath)) {
  throw "Missing smoke runner: $RunnerPath"
}

$appExecutable = Get-ChildItem -Path $ReleaseDir -Recurse -File -Filter '*.exe' |
  Where-Object { $_.FullName -match 'win-unpacked' -and $_.Name -notmatch 'unins' } |
  Select-Object -First 1

if ($null -eq $appExecutable) {
  throw "No win-unpacked executable found under $ReleaseDir"
}

node "$RunnerPath" --mode packaged --label packaged-win --executable "$($appExecutable.FullName)"
if ($LASTEXITCODE -ne 0) {
  throw "Packaged smoke failed with exit code $LASTEXITCODE"
}
