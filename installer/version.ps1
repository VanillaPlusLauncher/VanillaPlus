# The version of a build, written short: src\package.json's "1.7.0" is "1.7" (a patch stays:
# "1.7.1"). Test builds add "-beta.N": N counts the changes (commits) since the version in
# package.json was last set, so it goes 1, 2, 3… for every version and starts again with the next
# one. -Release gives the version without the beta tail.
# Usage: .\version.ps1 [-Release]
param([switch]$Release)
$root = Split-Path -Parent $PSScriptRoot
$full = (Get-Content (Join-Path $root 'src\package.json') -Raw | ConvertFrom-Json).version
$base = $full -replace '^(\d+\.\d+)\.0$', '$1'
if ($Release) { return $base }
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = Join-Path $env:TEMP 'rldev\git\x\cmd\git.exe' }
if (-not (Test-Path $git)) { Write-Warning 'git не найден: сборка без номера беты.'; return $base }
# The commit that last changed the "version" line of package.json.
$since = & $git -C $root log -1 --format=%H -G '"version"' -- src/package.json 2>$null
$count = if ($since) { & $git -C $root rev-list --count "$since..HEAD" 2>$null } else { & $git -C $root rev-list --count HEAD 2>$null }
if ($LASTEXITCODE -ne 0 -or -not $count) { return $base }
"$base-beta.$("$count".Trim())"
