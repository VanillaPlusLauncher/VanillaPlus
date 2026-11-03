# Builds the two archives the owner uploads to the hosting (ispmanager → unzip with replace):
#   site-update.zip — the site's code, without downloads/ and the videos (an ordinary update);
#   site-files.zip  — everything, downloads/ and the trailer videos too (a fresh hosting).
# Public .js/.css/.html lose their comments in the package (the repo keeps them), and the pages'
# ?v=<hash> links are stamped again after that. Both zips go to the Desktop folder "Amethyx для сайта".
# -WithLoop also puts the hero loop video (assets/video/trailer-loop*) into site-update.
# Usage (from anywhere): .\installer\site\build-package.ps1 [-WithLoop]
param([switch]$WithLoop)
$ErrorActionPreference = 'Stop'
$sp = $PSScriptRoot
Set-Location (Resolve-Path "$sp\..\..")
$node = "$env:TEMP\rldev\node\node-v24.22.0-win-x64\node.exe"
$pkg = "$env:TEMP\rldev\sitepkg"
$out = "$env:TEMP\rldev"
# The Desktop folder "Amethyx для сайта" (found by its old archive: Windows PowerShell reads this file as ANSI)
$desk = (Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Directory -Filter 'Amethyx *' | Where-Object { Test-Path "$($_.FullName)\site-update.zip" } | Select-Object -First 1).FullName
if (-not $desk) { throw 'Desktop folder not found' }

& "$sp\stamp-assets.ps1" -Site website
# cloud/test holds the server's tests: never on the hosting.
$xd = @('downloads', 'data', (Join-Path (Resolve-Path website).Path 'cloud\test'))
robocopy website $pkg /MIR /XD @xd /XF loader-demo.html README.md /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy $LASTEXITCODE" }
& $node "$sp\strip-comments.mjs" $pkg | Out-Null
& "$sp\stamp-assets.ps1" -Site $pkg | Out-Null
foreach ($f in 'script.js', 'geode.js', 'admin\admin.js') { & $node --check "$pkg\$f"; if ($LASTEXITCODE) { throw "syntax $f" } }

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function Zip($name, $filter, $extraRoot) {
  $zip = "$out\$name"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  $z = [IO.Compression.ZipFile]::Open($zip, 'Create')
  $add = {
    param($root)
    Get-ChildItem $root -Recurse -File -Force | ForEach-Object {
      $rel = $_.FullName.Substring($root.Length + 1) -replace '\\', '/'
      if (& $filter $rel) {
        $level = if ($rel -match '\.(mp4|webp|png|jpg|zip|exe|dmg)$') { 'NoCompression' } else { 'Optimal' }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $_.FullName, $rel, $level) | Out-Null
      }
    }
  }
  & $add $pkg
  if ($extraRoot) { & $add $extraRoot }
  $z.Dispose()
  Copy-Item $zip $desk -Force
  '{0} {1:N1} MB' -f $name, ((Get-Item $zip).Length / 1MB)
}

$loop = [bool]$WithLoop
Zip 'site-update.zip' { param($r) -not ($r -like 'assets/video/*') -or ($loop -and $r -like 'assets/video/trailer-loop*') }
$old = 'assets/video/amethyx-promo.mp4', 'assets/video/background.mp4', 'assets/video/promo-poster.webp'
$dl = (Resolve-Path website).Path + '\downloads'
Zip 'site-files.zip' { param($r) $old -notcontains $r } $null
# downloads/ go into the full archive under their own folder
$z = [IO.Compression.ZipFile]::Open("$out\site-files.zip", 'Update')
Get-ChildItem $dl -Recurse -File | ForEach-Object {
  $rel = 'downloads/' + ($_.FullName.Substring($dl.Length + 1) -replace '\\', '/')
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $_.FullName, $rel, 'NoCompression') | Out-Null
}
$z.Dispose()
Copy-Item "$out\site-files.zip" $desk -Force
'site-files.zip {0:N1} MB (with downloads)' -f ((Get-Item "$out\site-files.zip").Length / 1MB)
