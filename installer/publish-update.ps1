# Prepares a launcher update: writes build\latest.json for the installer in build\.
#
# The launcher reads latest.json (Settings -> Updates -> address) and downloads the installer it
# names. With GitHub Releases, upload both files to a release; the stable address of the newest
# latest.json is then https://github.com/<owner>/<repo>/releases/latest/download/latest.json
#
# Usage:
#   .\publish-update.ps1 -Repo owner/repo -Notes "Что нового"            # only writes latest.json
#   .\publish-update.ps1 -Repo owner/repo -Notes "Что нового" -Publish   # also creates the release with gh
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Notes = '',
  # build\VanillaPlus-Setup-<version>.exe (from build.ps1) by default.
  [string]$Installer = '',
  [switch]$Publish
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'src\package.json') -Raw | ConvertFrom-Json).version
$installer = if ($Installer) { $Installer } else { Join-Path $root "build\VanillaPlus-Setup-$version.exe" }
if (-not (Test-Path $installer)) { throw "Нет установщика $installer — сначала соберите его: .\build.ps1" }

$tag = "v$version"
$name = Split-Path -Leaf $installer
$feed = [ordered]@{
  version   = $version
  date      = (Get-Date -Format 'yyyy-MM-dd')
  notes     = $Notes
  installer = [ordered]@{
    url    = "https://github.com/$Repo/releases/download/$tag/$name"
    sha256 = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
    size   = (Get-Item $installer).Length
  }
}
$latest = Join-Path (Split-Path -Parent $installer) 'latest.json'
[IO.File]::WriteAllText($latest, ($feed | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
Write-Output "latest.json: $latest"
Write-Output "Адрес для лаунчера: https://github.com/$Repo/releases/latest/download/latest.json"

if ($Publish) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Для -Publish нужен GitHub CLI (gh).' }
  gh release create $tag $installer $latest --repo $Repo --title "Vanilla+ Launcher $version" --notes $Notes
}
