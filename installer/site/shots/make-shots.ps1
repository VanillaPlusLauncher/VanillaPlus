# Re-shoots the site's screenshots: website\assets\shots\<shot>.webp (Russian) and <shot>-en.webp
# (English), then re-stamps the links in website\index.html.
#   .\installer\site\shots\make-shots.ps1                 all six shots in both languages
#   .\installer\site\shots\make-shots.ps1 -Only home,mods  just these
#   -Out <folder>  WebP files somewhere else to look at first (the site's links are not stamped then)
# Everything runs in a made-up profile under -Work (never the player's own data): the player
# Amethyst_Alex, five instances (Fabric 26.3 gets real mods from Modrinth on the first run), demo
# friends from demo-friends.js. The launcher is the current src\ packed into a copy of
# build\Amethyx whose window renders off-screen, so nothing shows on the screen.
# Each language is shot in its own start: cards that were drawn in one language keep its relative
# dates ("3 weeks ago") after a switch.
param(
  [string]$Work = (Join-Path $env:TEMP 'amethyx-siteshots'),
  [string]$Only = '',
  [string]$Out = '',
  [int]$Port = 8797,
  # Node from PATH, ffmpeg from the shared tools folder (%USERPROFILE%\Tools).
  [string]$Node = '',
  [string]$Ffmpeg = (Join-Path $env:USERPROFILE 'Tools\ffmpeg\bin\ffmpeg.exe')
)
$ErrorActionPreference = 'Stop'
if (-not $Node) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node) { throw 'Нужен Node.js 24 (node в PATH).' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'build\Amethyx'
foreach ($need in @($Node, $Ffmpeg, (Join-Path $runtime 'Amethyx.exe'))) {
  if (-not (Test-Path $need)) { throw "Не найдено: $need" }
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Нужен Python 3 (для упаковки app.asar).' }
$utf8 = New-Object Text.UTF8Encoding($false)
$ud = Join-Path $Work 'profile'
$game = Join-Path $Work 'game'
$stage = Join-Path $Work 'stage'
$src = Join-Path $Work 'src'
$png = Join-Path $Work 'png'
$scripts = Join-Path $Work 'scripts'
foreach ($dir in @($ud, $game, $png, $scripts)) { New-Item -ItemType Directory -Force $dir | Out-Null }

# --- The profile: settings with its own game folder, five instances -------------------------------
$settings = [ordered]@{
  gameDirectory = $game
  selectedInstanceId = 'Create Skyline'
  instanceView = 'grid'
  contentSource = 'modrinth'
  ui = [ordered]@{ accent = 'amethyst'; background = 'panorama'; language = 'en'; font = 'pixel'; sidebar = 'labels'; cards = 'tile'; style = 'soft'; icons = 'color'; animations = $true; sparks = $true; scale = 100; blur = $true }
  sounds = [ordered]@{ enabled = $false; music = $false }
  updates = [ordered]@{ autoCheck = $false; autoDownload = $false; autoInstall = $false; feedUrl = '' }
  social = [ordered]@{ skinsInMods = $true; online = $true; shareActivity = $true; serverUrl = "http://127.0.0.1:$Port"; overlay = $true; overlayKey = 'Shift+Tab' }
}
[IO.File]::WriteAllText((Join-Path $ud 'settings.json'), ($settings | ConvertTo-Json -Depth 5), $utf8)

$now = [DateTime]::UtcNow
$instances = @(
  @{ id = 'Create Skyline'; name = 'Create: Skyline'; icon = 'block:copper_block'; mc = '1.21.1'; loader = 'neoforge'; lv = '21.1.264'; ago = 50; hours = 5 },
  @{ id = 'Survival+'; name = 'Survival+'; icon = 'block:oak_log'; mc = '1.21.1'; loader = 'fabric'; lv = '0.20.1'; ago = 120; hours = 12 },
  @{ id = 'Fabric 26.3'; name = 'Fabric 26.3'; icon = 'block:grass_block'; mc = '26.3'; loader = 'fabric'; lv = '0.20.1'; ago = 1140; hours = 0.0333 },
  @{ id = 'Shaders & Chill'; name = 'Shaders & Chill'; icon = 'block:amethyst_block'; mc = '1.21.4'; loader = 'fabric'; lv = '0.20.1'; ago = 1560; hours = 3 },
  @{ id = 'Hardcore Vanilla'; name = 'Hardcore Vanilla'; icon = 'block:tnt'; mc = '26.3'; loader = 'vanilla'; lv = $null; ago = 4800; hours = 7 }
)
$instancesDir = Join-Path $game 'instances'
New-Item -ItemType Directory -Force $instancesDir | Out-Null
$marker = Join-Path $instancesDir '.instances-v2'
if (-not (Test-Path $marker)) { [IO.File]::WriteAllText($marker, '', $utf8) }
foreach ($i in $instances) {
  $dir = Join-Path $instancesDir $i.id
  New-Item -ItemType Directory -Force (Join-Path $dir 'mods') | Out-Null
  $json = [ordered]@{
    id = $i.id; name = $i.name; group = ''; icon = $i.icon; minecraft = $i.mc
    loader = [ordered]@{ type = $i.loader; version = $i.lv }
    versionId = $null
    createdAt = $now.AddDays(-3).ToString('o')
    lastPlayedAt = $now.AddMinutes(-$i.ago).ToString('o')
    playTimeMs = [long]($i.hours * 3600000)
    notes = ''; overrides = @{}; source = $null
  }
  [IO.File]::WriteAllText((Join-Path $dir 'instance.json'), ($json | ConvertTo-Json -Depth 5), $utf8)
}
$mods = Join-Path $instancesDir 'Fabric 26.3\mods'
if (-not (Get-ChildItem $mods -Filter *.jar -ErrorAction SilentlyContinue)) {
  Write-Output 'Загрузка модов для сборки Fabric 26.3…'
  & $Node (Join-Path $PSScriptRoot 'mods.mjs') $mods '26.3' 22 | Out-Null
}

# --- The launcher: current src\ in a copy of the runtime, its window off-screen -------------------
Write-Output 'Сборка копии лаунчера для съёмки…'
Remove-Item $stage, $src -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage 'resources') | Out-Null
Get-ChildItem $runtime | Where-Object { $_.Name -ne 'resources' } | Copy-Item -Destination $stage -Recurse
Get-ChildItem (Join-Path $runtime 'resources') | Where-Object { $_.Name -notlike 'app.asar*' } | Copy-Item -Destination (Join-Path $stage 'resources') -Recurse
# No keys in this copy: the shots need none (mods come from Modrinth).
robocopy (Join-Path $repo 'src') $src /E /XD mc-ui /XF build-keys.json /NFL /NDL /NJH /NJS /NP | Out-Null
$windowJs = Join-Path $src 'src\main\window.js'
$text = [IO.File]::ReadAllText($windowJs)
$patched = $text.Replace('show: false,', 'show: false, skipTaskbar: true,').Replace('sandbox: false,', 'sandbox: false, offscreen: true,').Replace("window.once('ready-to-show', () => window.show());", '// Screenshots: never shown (off-screen).')
if ($patched -notmatch 'offscreen: true' -or $patched -notmatch 'skipTaskbar: true' -or $patched -match "ready-to-show', \(\) => window\.show") {
  throw 'window.js изменился: не получилось включить съёмку без окна (поправьте замены в make-shots.ps1).'
}
[IO.File]::WriteAllText($windowJs, $patched, $utf8)
python -I (Join-Path $repo 'installer\tools\asar.py') pack $src (Join-Path $stage 'resources\app.asar') | Out-Null
if (-not (Test-Path (Join-Path $stage 'resources\app.asar'))) { throw 'app.asar не собран.' }
# The capture script runs from -Work: its log (<script>.out.txt) is written next to it.
Copy-Item (Join-Path $PSScriptRoot 'capture.js') (Join-Path $scripts 'capture.js') -Force

# --- Shooting ---------------------------------------------------------------------------------------
$skins = Join-Path $ud 'mc-ui\skins'
$server = Start-Process -FilePath $Node -ArgumentList @("`"$(Join-Path $PSScriptRoot 'demo-friends.js')`"", "`"$skins`"", $Port) -WindowStyle Hidden -PassThru
try {
  Get-ChildItem $png -Filter *.png -ErrorAction SilentlyContinue | Remove-Item -Force
  foreach ($language in @('en', 'ru')) {
    Write-Output "Съёмка: $language…"
    $env:AMETHYX_MAIN_SCRIPT = Join-Path $scripts 'capture.js'
    $env:AMETHYX_UPDATE_FEED = 'http://127.0.0.1:8799/latest.json'
    $env:TT_OUT = $png
    $env:SHOTS_LANGS = $language
    $env:SHOTS_ONLY = $Only
    $flags = @("--user-data-dir=`"$ud`"", '--force-device-scale-factor=1', '--disable-gpu-vsync',
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding')
    $launcher = Start-Process -FilePath (Join-Path $stage 'Amethyx.exe') -ArgumentList $flags -PassThru
    if (-not $launcher.WaitForExit(600000)) {
      Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
      throw "Съёмка ($language) не закончилась за 10 минут."
    }
    $log = [IO.File]::ReadAllText("$($env:AMETHYX_MAIN_SCRIPT).out.txt", [Text.Encoding]::UTF8)
    Write-Output $log
    if ($log -notmatch 'MAIN SCRIPT OK') { throw "Съёмка ($language) не удалась." }
  }
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  foreach ($name in 'AMETHYX_MAIN_SCRIPT', 'AMETHYX_UPDATE_FEED', 'TT_OUT', 'SHOTS_LANGS', 'SHOTS_ONLY') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}

# --- WebP for the site, then fresh ?v= stamps ----------------------------------------------------------
$siteShots = Join-Path $repo 'website\assets\shots'
$shots = if ($Out) { $Out } else { $siteShots }
New-Item -ItemType Directory -Force $shots | Out-Null
foreach ($file in Get-ChildItem $png -Filter *.png) {
  if ($file.BaseName -notmatch '^(?<shot>[a-z]+)-(?<lang>en|ru)$') { continue }
  $target = if ($Matches.lang -eq 'ru') { "$($Matches.shot).webp" } else { "$($Matches.shot)-en.webp" }
  & $Ffmpeg -v error -y -i $file.FullName -c:v libwebp -quality 82 -compression_level 6 (Join-Path $shots $target)
  if ($LASTEXITCODE -ne 0) { throw "WebP не получился: $target" }
  Write-Output "$target  $([math]::Round((Get-Item (Join-Path $shots $target)).Length / 1KB)) KB"
}
if (-not $Out) {
  Push-Location $repo
  try { & (Join-Path $repo 'installer\site\stamp-assets.ps1') } finally { Pop-Location }
}
Write-Output "Готово. Снимки в PNG: $png"
