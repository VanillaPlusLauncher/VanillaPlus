# Builds the launcher folder and its installer.
#   1. copies the Electron runtime (build\Amethyx without app.asar) to a staging folder,
#   2. packs src\ into resources\app.asar there (tools\asar.py),
#   3. compiles installer\Amethyx.iss into build\Amethyx-Setup-<version>.exe.
# A staging folder is used so the build works while build\Amethyx is open.
#
# The Minecraft files in src\assets\mc-ui (a local cache) are never packed: the launcher downloads
# them from Mojang on its first start.
#
# Usage: .\build.ps1 [-Iscc <path to ISCC.exe>] [-Version 1.3.1] [-Output <folder>]
param(
  [string]$Iscc = '',
  [string]$Version = '',
  [string]$Output = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'build\Amethyx'
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'src\package.json') -Raw | ConvertFrom-Json).version }
if (-not $Output) { $Output = Join-Path $root 'build' }
if (-not $Iscc) {
  $Iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $Iscc) { throw 'Не найден Inno Setup 6 (ISCC.exe). Укажите путь: -Iscc <путь>.' }
}

# A fresh clone has no runtime yet: Electron is downloaded from its GitHub releases and checked.
$electronVersion = '44.9.0'
if (-not (Test-Path (Join-Path $runtime 'Amethyx.exe'))) {
  $zipName = "electron-v$electronVersion-win32-x64.zip"
  $base = "https://github.com/electron/electron/releases/download/v$electronVersion"
  $download = Join-Path $env:TEMP $zipName
  Write-Output "Загрузка Electron $electronVersion…"
  Invoke-WebRequest "$base/$zipName" -OutFile $download -UseBasicParsing
  $sums = Join-Path $env:TEMP "electron-v$electronVersion-SHASUMS256.txt"
  Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile $sums -UseBasicParsing
  $expected = ((Get-Content $sums | Where-Object { $_ -match "\*?$([regex]::Escape($zipName))$" }) -split '\s+')[0]
  $actual = (Get-FileHash $download -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw "Контрольная сумма Electron не совпала ($actual)." }
  New-Item -ItemType Directory -Force $runtime | Out-Null
  Expand-Archive $download $runtime -Force
  Move-Item (Join-Path $runtime 'electron.exe') (Join-Path $runtime 'Amethyx.exe') -Force
  Remove-Item (Join-Path $runtime 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path (Join-Path $root 'src\node_modules\adm-zip'))) { throw 'Нет зависимостей: выполните `npm install --omit=dev` в папке src.' }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Нужен Python 3 (для упаковки app.asar).' }

$stage = Join-Path $env:TEMP "amethyx-stage-$Version"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
Get-ChildItem $runtime | Where-Object { $_.Name -ne 'resources' } | Copy-Item -Destination $stage -Recurse
New-Item -ItemType Directory -Force (Join-Path $stage 'resources') | Out-Null
Get-ChildItem (Join-Path $runtime 'resources') | Where-Object { $_.Name -notlike 'app.asar*' } | Copy-Item -Destination (Join-Path $stage 'resources') -Recurse

# A copy of src is packed: without the Minecraft cache, and with the version set when -Version is given.
$source = Join-Path $root 'src'
$copy = Join-Path $env:TEMP "amethyx-src-$Version"
Remove-Item $copy -Recurse -Force -ErrorAction SilentlyContinue
robocopy $source $copy /E /XD mc-ui /NFL /NDL /NJH /NJS /NP | Out-Null
$package = Join-Path $copy 'package.json'
$text = [IO.File]::ReadAllText($package) -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`""
[IO.File]::WriteAllText($package, $text, (New-Object Text.UTF8Encoding $false))
$source = $copy
# The launcher's CurseForge API key, when there is one: from AMETHYX_CURSEFORGE_KEY or
# installer\curseforge.key (ignored by git). It goes only into the built app, never into the repository.
$cfKey = $env:AMETHYX_CURSEFORGE_KEY
$cfKeyFile = Join-Path $PSScriptRoot 'curseforge.key'
if (-not $cfKey -and (Test-Path $cfKeyFile)) { $cfKey = (Get-Content $cfKeyFile -Raw).Trim() }
# The launcher's Ely.by application (sign-in on the Ely.by site): installer\ely-oauth.json
# ({ "clientId": "...", "clientSecret": "..." }, ignored by git) or AMETHYX_ELY_CLIENT_ID / _SECRET.
$elyId = $env:AMETHYX_ELY_CLIENT_ID
$elySecret = $env:AMETHYX_ELY_CLIENT_SECRET
$elyFile = Join-Path $PSScriptRoot 'ely-oauth.json'
if (-not $elyId -and (Test-Path $elyFile)) {
  $ely = Get-Content $elyFile -Raw | ConvertFrom-Json
  $elyId = "$($ely.clientId)".Trim()
  $elySecret = "$($ely.clientSecret)".Trim()
}
$keys = @{}
if ($cfKey) { $keys.curseforge = $cfKey }
if ($elyId -and $elySecret) { $keys.elyClientId = $elyId; $keys.elyClientSecret = $elySecret }
if ($keys.Count) {
  [IO.File]::WriteAllText((Join-Path $copy 'src\build-keys.json'), ($keys | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  if ($cfKey) { Write-Output 'Ключ CurseForge встроен в сборку.' }
  if ($keys.elyClientId) { Write-Output 'Приложение Ely.by встроено в сборку.' }
} else {
  Remove-Item (Join-Path $copy 'src\build-keys.json') -Force -ErrorAction SilentlyContinue
}
python -I (Join-Path $PSScriptRoot 'tools\asar.py') pack $source (Join-Path $stage 'resources\app.asar') | Out-Null
if (-not (Test-Path (Join-Path $stage 'resources\app.asar'))) { throw 'app.asar не собран.' }

# Icon and file details of Amethyx.exe (Explorer, taskbar, "Properties"), set with Electron's
# rcedit. The download is checked against a pinned SHA-256 (the same file as in npm's "rcedit").
$rcedit = Join-Path $env:TEMP 'rcedit-x64-2.0.0.exe'
$rceditSha256 = '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a'
if (-not (Test-Path $rcedit) -or (Get-FileHash $rcedit -Algorithm SHA256).Hash.ToLower() -ne $rceditSha256) {
  Invoke-WebRequest 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' -OutFile $rcedit -UseBasicParsing
  if ((Get-FileHash $rcedit -Algorithm SHA256).Hash.ToLower() -ne $rceditSha256) { Remove-Item $rcedit; throw 'Контрольная сумма rcedit не совпала.' }
}
$numericVersion = ($Version -replace '[^\d.].*$', '')
& $rcedit (Join-Path $stage 'Amethyx.exe') --set-icon (Join-Path $PSScriptRoot 'art\setup.ico') `
  --set-file-version $numericVersion --set-product-version $numericVersion `
  --set-version-string ProductName 'Amethyx Launcher' --set-version-string FileDescription 'Amethyx Launcher' `
  --set-version-string CompanyName 'Amethyx' --set-version-string LegalCopyright 'GPL-3.0' `
  --set-version-string OriginalFilename 'Amethyx.exe' --set-version-string InternalName 'Amethyx'
if ($LASTEXITCODE -ne 0) { throw "rcedit завершился с кодом $LASTEXITCODE" }
& $Iscc /Q "/DSourceDir=$stage" "/DAppVersion=$Version" "/O$Output" (Join-Path $PSScriptRoot 'Amethyx.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC завершился с кодом $LASTEXITCODE" }
# The runnable folder gets the same app (skipped while the launcher is open from there).
try {
  Copy-Item (Join-Path $stage 'resources\app.asar') (Join-Path $runtime 'resources\app.asar') -Force -ErrorAction Stop
  Copy-Item (Join-Path $stage 'Amethyx.exe') (Join-Path $runtime 'Amethyx.exe') -Force -ErrorAction Stop
} catch {
  Write-Warning "build\Amethyx не обновлён: закройте лаунчер, запущенный оттуда."
}
Write-Output (Join-Path $Output "Amethyx-Setup-$Version.exe")
