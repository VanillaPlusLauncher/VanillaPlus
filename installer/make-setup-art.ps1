# Pictures of the installer's own screens (Amethyx.iss draws its window from them, no Windows controls):
#   1. the parts of art-src\setup-ui.html (panels, buttons, the name, the bar) at 1x, 2x and 3x into
#      art\setup-*.png and their places into art\setup-layout.iss — drawn by a launcher build (it has
#      Electron), started with its own empty profile and folder, never the real ones;
#   2. the backgrounds: one panorama face of several Minecraft versions, cut to the window's shape,
#      into art\setup-pano-*.png. They are the game's own pictures, so they are not kept in git
#      (.gitignore): they are made from the launcher's panorama cache when missing.
# Usage: .\make-setup-art.ps1 [-Launcher <Amethyx.exe>] [-Panoramas <mc-ui\panoramas>] [-PanoramasOnly]
param(
  [string]$Launcher = '',
  [string]$Panoramas = "$env:APPDATA\Amethyx\mc-ui\panoramas",
  [switch]$PanoramasOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$art = Join-Path $PSScriptRoot 'art'
if (-not $Launcher) { $Launcher = Join-Path $root 'build\Amethyx\Amethyx.exe' }

# --- 2. Backgrounds ----------------------------------------------------------------------------
# Bright scenes first; the installer picks one at random each time it starts.
$versions = @('26.1', '1.21.9', '1.21.6', '26.3', '1.20')
$made = 0
foreach ($version in $versions) {
  $face = Join-Path $Panoramas "$version\panorama_0.png"
  if (-not (Test-Path $face)) { continue }
  $made++
  $src = [System.Drawing.Image]::FromFile($face)
  # The window is 760 × 460: the same shape cut from the face at its own size, a little below the middle.
  $w = $src.Width; $h = [int]($w * 460 / 760)
  $y = [int](($src.Height - $h) * 0.62)
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dim = New-Object System.Drawing.Imaging.ColorMatrix
  $dim.Matrix00 = 0.85; $dim.Matrix11 = 0.85; $dim.Matrix22 = 0.85
  $attrs = New-Object System.Drawing.Imaging.ImageAttributes
  $attrs.SetColorMatrix($dim)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), 0, $y, $w, $h, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
  $bmp.Save((Join-Path $art "setup-pano-$made.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $src.Dispose()
}
if ($made -eq 0) { throw "Нет панорам в ${Panoramas}: откройте лаунчер один раз или укажите папку -Panoramas." }
# Leftovers of an earlier run with more panoramas.
Get-ChildItem $art -Filter 'setup-pano-*.png' | Where-Object { [int]($_.BaseName -replace '\D', '') -gt $made } | Remove-Item
"Фонов: $made"
if ($PanoramasOnly) { return }

# --- 1. Screens --------------------------------------------------------------------------------
if (-not (Test-Path $Launcher)) { throw "Нет сборки лаунчера: $Launcher" }
$font = Join-Path $env:TEMP 'Tiny5-Regular.ttf'
$fontSha256 = 'eb4206abc0c73e9fe4fe93c034ea270578859c40a7e740c6207322413c5c4c91'
if (-not (Test-Path $font) -or (Get-FileHash $font -Algorithm SHA256).Hash.ToLower() -ne $fontSha256) {
  curl.exe -sSL -o $font 'https://fonts.gstatic.com/s/tiny5/v3/KFOpCnmCvdGT7hw-.ttf'
  if ((Get-FileHash $font -Algorithm SHA256).Hash.ToLower() -ne $fontSha256) { Remove-Item $font; throw 'Контрольная сумма Tiny5 не совпала.' }
}
# A short folder: Chromium does not open pages under very long paths.
$work = Join-Path $env:TEMP 'amethyx-setup-art'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work, "$work\profile" | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'art-src\setup-ui.html') $work
Copy-Item $font "$work\Tiny5.ttf"
Copy-Item (Join-Path $art 'logo-source.png') "$work\logo.png"
# The launcher starts with an empty profile of its own and a game folder inside it.
$settings = @{ gameDirectory = "$work\game"; social = @{ online = $false } } | ConvertTo-Json
[IO.File]::WriteAllText("$work\profile\settings.json", $settings, (New-Object Text.UTF8Encoding $false))
$env:SETUP_UI_PAGE = "$work\setup-ui.html"
$env:SETUP_UI_OUT = $art
$env:AMETHYX_MAIN_SCRIPT = Join-Path $PSScriptRoot 'art-src\render-setup-ui.js'
$p = Start-Process $Launcher -ArgumentList "--user-data-dir=`"$work\profile`"" -PassThru
if (-not $p.WaitForExit(120000)) { $p.Kill(); throw 'Лаунчер не закончил рисовать за 2 минуты.' }
Remove-Item Env:AMETHYX_MAIN_SCRIPT
$log = Join-Path $PSScriptRoot 'art-src\render-setup-ui.js.out.txt'
if (Test-Path $log) { Get-Content $log; Remove-Item $log }
if (-not (Test-Path (Join-Path $art 'setup-layout.iss'))) { throw 'Экраны не нарисованы.' }
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
'Экраны установщика готовы.'
