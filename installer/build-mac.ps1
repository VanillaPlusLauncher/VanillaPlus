# Builds Amethyx for macOS on Windows: Amethyx-<version>-mac-arm64.zip (Apple Silicon) and
# Amethyx-<version>-mac-x64.zip (Intel), each with Amethyx.app inside.
#   1. downloads Electron for macOS from its GitHub releases and checks it,
#   2. packs src\ into app.asar (with the version and the keys, like build.ps1),
#   3. draws the icon (.icns) and rewrites Electron.app into Amethyx.app (tools\mac_bundle.py),
#   4. signs it ad hoc with rcodesign (tools\mac_sign.py).
# The app is not signed by Apple: on the first start macOS refuses it once, then System Settings →
# Privacy & Security → "Open Anyway" opens it (no Terminal).
#
# Without -Version the build is numbered like build.ps1's (version.ps1: "-beta.N"; -Release: plain).
#
# -Publish puts the zips on the launcher's site right after (publish-site.ps1; the platform comes
# from the file name, "-mac-arm64" / "-mac-x64").
#
# Usage: .\build-mac.ps1 [-Version 1.7.0 | -Release] [-Output <folder>] [-Arch arm64,x64] [-Publish] [-Notes "…"]
param(
  [string]$Version = '',
  [string]$Output = '',
  [string[]]$Arch = @('arm64', 'x64'),
  [switch]$Release,
  [switch]$Publish,
  [string]$Notes = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) { $Version = & (Join-Path $PSScriptRoot 'version.ps1') -Release:$Release }
if (-not $Output) { $Output = Join-Path $root 'build' }
if (-not (Test-Path (Join-Path $root 'src\node_modules\adm-zip'))) { throw 'Нет зависимостей: выполните `npm install --omit=dev` в папке src.' }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Нужен Python 3.' }
New-Item -ItemType Directory -Force $Output | Out-Null

# 1. Electron for macOS (the same version as the Windows build), checked against SHASUMS256.txt.
$electronVersion = '44.9.0'
$base = "https://github.com/electron/electron/releases/download/v$electronVersion"
$cache = Join-Path $env:TEMP "amethyx-electron-mac-$electronVersion"
New-Item -ItemType Directory -Force $cache | Out-Null
$sums = Join-Path $cache 'SHASUMS256.txt'
if (-not (Test-Path $sums)) { Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile $sums -UseBasicParsing }

# 2. app.asar from a copy of src (no Minecraft cache; version and keys set like build.ps1).
$copy = Join-Path $env:TEMP "amethyx-src-mac-$Version"
Remove-Item $copy -Recurse -Force -ErrorAction SilentlyContinue
robocopy (Join-Path $root 'src') $copy /E /XD mc-ui /NFL /NDL /NJH /NJS /NP | Out-Null
$package = Join-Path $copy 'package.json'
$text = [IO.File]::ReadAllText($package) -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`""
[IO.File]::WriteAllText($package, $text, (New-Object Text.UTF8Encoding $false))
$keys = @{}
$cfKey = $env:AMETHYX_CURSEFORGE_KEY
$cfKeyFile = Join-Path $PSScriptRoot 'curseforge.key'
if (-not $cfKey -and (Test-Path $cfKeyFile)) { $cfKey = (Get-Content $cfKeyFile -Raw).Trim() }
if ($cfKey) { $keys.curseforge = $cfKey }
$elyFile = Join-Path $PSScriptRoot 'ely-oauth.json'
$elyId = $env:AMETHYX_ELY_CLIENT_ID
$elySecret = $env:AMETHYX_ELY_CLIENT_SECRET
if (-not $elyId -and (Test-Path $elyFile)) {
  $ely = Get-Content $elyFile -Raw | ConvertFrom-Json
  $elyId = "$($ely.clientId)".Trim()
  $elySecret = "$($ely.clientSecret)".Trim()
}
if ($elyId -and $elySecret) { $keys.elyClientId = $elyId; $keys.elyClientSecret = $elySecret }
if ($keys.Count) { [IO.File]::WriteAllText((Join-Path $copy 'src\build-keys.json'), ($keys | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false)) }
else { Remove-Item (Join-Path $copy 'src\build-keys.json') -Force -ErrorAction SilentlyContinue }
$asar = Join-Path $env:TEMP "amethyx-mac-$Version.asar"
python -I (Join-Path $PSScriptRoot 'tools\asar.py') pack $copy $asar | Out-Null
if (-not (Test-Path $asar)) { throw 'app.asar не собран.' }

# 3. The icon: the pixel X on a dark amethyst rounded square, like macOS app icons.
Add-Type -AssemblyName System.Drawing
$iconWork = Join-Path $env:TEMP 'amethyx-mac-icon'
New-Item -ItemType Directory -Force $iconWork | Out-Null
$mark = [System.Drawing.Image]::FromFile((Join-Path $root 'src\assets\branding\amethyx-mark.png'))
$pngs = @()
foreach ($size in 128, 256, 512, 1024) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = 'AntiAlias'
  $inset = [int]($size * 0.1)
  $side = $size - 2 * $inset
  $radius = [int]($side * 0.225)
  $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
  $shape.AddArc($inset, $inset, 2 * $radius, 2 * $radius, 180, 90)
  $shape.AddArc($inset + $side - 2 * $radius, $inset, 2 * $radius, 2 * $radius, 270, 90)
  $shape.AddArc($inset + $side - 2 * $radius, $inset + $side - 2 * $radius, 2 * $radius, 2 * $radius, 0, 90)
  $shape.AddArc($inset, $inset + $side - 2 * $radius, 2 * $radius, 2 * $radius, 90, 90)
  $shape.CloseFigure()
  $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Point]::new(0, $inset)), ([System.Drawing.Point]::new(0, $inset + $side)), ([System.Drawing.Color]::FromArgb(255, 42, 26, 66)), ([System.Drawing.Color]::FromArgb(255, 14, 10, 22))
  $g.FillPath($fill, $shape)
  # The X is pixel art: scaled without smoothing so its pixels stay sharp.
  $g.InterpolationMode = 'NearestNeighbor'
  $g.PixelOffsetMode = 'Half'
  $markSide = [int]($side * 0.72)
  $g.DrawImage($mark, [int](($size - $markSide) / 2), [int](($size - $markSide) / 2), $markSide, $markSide)
  $g.Dispose()
  $png = Join-Path $iconWork "icon-$size.png"
  $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  $pngs += $png
}
$mark.Dispose()
$icns = Join-Path $iconWork 'amethyx.icns'
python -I (Join-Path $PSScriptRoot 'tools\make_icns.py') $icns @pngs

# 4. rcodesign (apple-codesign, open source) signs the app ad hoc: without it macOS calls the
#    changed app "damaged" and only Terminal opens it; signed, "Open Anyway" in Privacy & Security does.
$rcVersion = '0.29.0'
$rcZipName = "apple-codesign-$rcVersion-x86_64-pc-windows-msvc.zip"
$rcSha = '54bb500e2da7a8de02fcae0f331d1cac6e6d7173b4281042ff9c528ba3159aaa'
$rcCache = Join-Path $env:TEMP "amethyx-rcodesign-$rcVersion"
$rcodesign = Join-Path $rcCache "apple-codesign-$rcVersion-x86_64-pc-windows-msvc\rcodesign.exe"
if (-not (Test-Path $rcodesign)) {
  New-Item -ItemType Directory -Force $rcCache | Out-Null
  $rcZip = Join-Path $rcCache $rcZipName
  Invoke-WebRequest "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/$rcVersion/$rcZipName" -OutFile $rcZip -UseBasicParsing
  $actual = (Get-FileHash $rcZip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $rcSha) { throw "Контрольная сумма rcodesign не совпала ($actual)." }
  Expand-Archive $rcZip $rcCache -Force
}

foreach ($a in $Arch) {
  $zipName = "electron-v$electronVersion-darwin-$a.zip"
  $download = Join-Path $cache $zipName
  $expected = ((Get-Content $sums | Where-Object { $_ -match "\*?$([regex]::Escape($zipName))$" }) -split '\s+')[0]
  if (-not (Test-Path $download) -or (Get-FileHash $download -Algorithm SHA256).Hash.ToLower() -ne $expected) {
    Write-Output "Загрузка Electron $electronVersion для macOS ($a)…"
    Invoke-WebRequest "$base/$zipName" -OutFile $download -UseBasicParsing
  }
  $actual = (Get-FileHash $download -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw "Контрольная сумма Electron ($a) не совпала ($actual)." }
  $out = Join-Path $Output "Amethyx-$Version-mac-$a.zip"
  python -I (Join-Path $PSScriptRoot 'tools\mac_bundle.py') $download $asar $icns $Version $out
  if ($LASTEXITCODE -ne 0) { throw "mac_bundle.py завершился с кодом $LASTEXITCODE" }
  # A short work folder: the paths inside Electron.app are long.
  python -I (Join-Path $PSScriptRoot 'tools\mac_sign.py') $rcodesign $out (Join-Path $env:TEMP "amxs-$a")
  if ($LASTEXITCODE -ne 0) { throw "mac_sign.py завершился с кодом $LASTEXITCODE" }
  Write-Output $out
  if ($Publish) { & (Join-Path $PSScriptRoot 'publish-site.ps1') -File $out -Latest -Notes $Notes }
}
