#!/usr/bin/env pwsh

[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Resolve-Path (Join-Path $ScriptDir '../..')
$DesktopDir = Join-Path $RootDir 'apps/desktop'
$OutputDir = Join-Path $DesktopDir 'release'
$ManifestDir = Join-Path $RootDir 'dist'
$ManifestPath = Join-Path $ManifestDir 'manifest.json'
$PackageJsonPath = Join-Path $DesktopDir 'package.json'
$Version = (Get-Content -Raw -Path $PackageJsonPath | ConvertFrom-Json).version

if ($DryRun) {
  Write-Host "[dry-run] Would execute: npm --prefix `"$DesktopDir`" run build:win"
  Write-Host "[dry-run] Expected artifact pattern: $OutputDir/*.exe"
  Write-Host "[dry-run] Would write manifest to: $ManifestPath"

  $preview = [ordered]@{
    version = $Version
    generatedAt = '<ISO-8601>'
    artifacts = @(
      [ordered]@{
        platform = 'win'
        filename = '<artifact>.exe'
        sha256 = '<sha256>'
      }
    )
  }

  Write-Host "[dry-run] Manifest preview:"
  $preview | ConvertTo-Json -Depth 5
  exit 0
}

npm --prefix "$DesktopDir" run build:win
if ($LASTEXITCODE -ne 0) {
  throw "build:win failed with exit code $LASTEXITCODE"
}

$artifacts = @(Get-ChildItem -Path $OutputDir -Filter '*.exe' -File)
if ($artifacts.Count -eq 0) {
  throw "No Windows artifact found in $OutputDir (expected at least one .exe)."
}

if (-not (Test-Path -Path $ManifestDir)) {
  New-Item -ItemType Directory -Path $ManifestDir | Out-Null
}

$existingArtifacts = @()
if (Test-Path -Path $ManifestPath) {
  $existing = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
  if ($null -ne $existing.artifacts) {
    $existingArtifacts = @($existing.artifacts | Where-Object { $_.platform -ne 'win' })
  }
}

$newArtifacts = foreach ($artifact in $artifacts) {
  $hash = (Get-FileHash -Path $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  [ordered]@{
    platform = 'win'
    filename = $artifact.Name
    sha256 = $hash
  }
}

$manifest = [ordered]@{
  version = $Version
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  artifacts = @($existingArtifacts + $newArtifacts)
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding utf8
Write-Host "Manifest written: $ManifestPath"
