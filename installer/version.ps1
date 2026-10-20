# The version of a build: src\package.json's version, plus "-beta.N" for test builds (N = number of
# commits, so it grows with every change). -Release gives the plain version.
# Usage: .\version.ps1 [-Release]
param([switch]$Release)
$root = Split-Path -Parent $PSScriptRoot
$base = (Get-Content (Join-Path $root 'src\package.json') -Raw | ConvertFrom-Json).version
if ($Release) { return $base }
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = Join-Path $env:TEMP 'rldev\git\x\cmd\git.exe' }
if (-not (Test-Path $git)) { Write-Warning 'git не найден: сборка без номера беты.'; return $base }
$count = & $git -C $root rev-list --count HEAD 2>$null
if ($LASTEXITCODE -ne 0 -or -not $count) { return $base }
"$base-beta.$($count.Trim())"
