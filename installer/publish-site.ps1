# Puts a built installer (or a macOS zip) on the launcher's site through its admin API: in pieces
# (the hosting limits one request), checked by SHA-256 at the end. With -Latest the site's
# "Download" buttons and update feeds (updates/latest.json, updates/beta.json) take it at once.
#
# The token comes from the admin panel ("Токены", amx_…) and stays on this computer: the
# AMETHYX_SITE_TOKEN variable or installer\site-token.txt (ignored by git). It is never printed.
#
# -Version overrides the version the site reads from the file name (for an old build whose name
# says too little, say "1.7-alpha" for the first 1.7.0 test build).
#
# Usage: .\publish-site.ps1 -File <Amethyx-Setup-1.7-beta.28.exe> [-Channel beta|release]
#          [-Latest] [-Version 1.7-alpha] [-Notes "что нового"] [-Site https://launcher.x-world.plus]
param(
  [Parameter(Mandatory)] [string]$File,
  [ValidateSet('', 'beta', 'release')] [string]$Channel = '',
  [switch]$Latest,
  [string]$Version = '',
  [string]$Notes = '',
  [string]$Site = 'https://launcher.x-world.plus'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$token = $env:AMETHYX_SITE_TOKEN
$tokenFile = Join-Path $PSScriptRoot 'site-token.txt'
if (-not $token -and (Test-Path $tokenFile)) { $token = (Get-Content $tokenFile -Raw).Trim() }
if (-not $token) { throw 'Нет токена сайта: создайте его в админке («Токены») и положите в installer\site-token.txt или AMETHYX_SITE_TOKEN.' }
$path = (Resolve-Path $File).Path
$name = [IO.Path]::GetFileName($path)
$size = (Get-Item $path).Length
if (-not $Channel) { $Channel = if ($name -match '-beta\.') { 'beta' } else { 'release' } }

$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(5)
$client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
$api = "$($Site.TrimEnd('/'))/api.php?a="

# One request; returns { status, body (parsed JSON or $null) }.
function Send($action, $content) {
  $response = $client.PostAsync($api + $action, $content).GetAwaiter().GetResult()
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $body = $null
  if ($text) { try { $body = $text | ConvertFrom-Json } catch { $body = $null } }
  [pscustomobject]@{ status = [int]$response.StatusCode; body = $body; text = $text }
}
function Json($object) {
  New-Object System.Net.Http.StringContent (($object | ConvertTo-Json -Compress), [Text.Encoding]::UTF8, 'application/json')
}
function Fail($what, $result) {
  $message = if ($result.body.message) { $result.body.message } elseif ($result.body.error) { $result.body.error } else { $result.text }
  throw "$what — ответ $($result.status): $message"
}

Write-Output "SHA-256 $name…"
$sha256 = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
$start = @{ name = $name; size = $size; channel = $Channel; latest = [bool]$Latest }
if ($Notes) { $start.notes = $Notes }
if ($Version) { $start.version = $Version }
$begun = Send 'upload-start' (Json $start)
if ($begun.status -ne 200 -or -not $begun.body.id) { Fail 'Загрузка не начата' $begun }
$id = $begun.body.id
$chunk = [int64]$begun.body.chunk
if ($chunk -le 0) { $chunk = 4MB }

$stream = [IO.File]::OpenRead($path)
try {
  $offset = [int64]0
  $buffer = New-Object byte[] $chunk
  $tries = 0
  while ($offset -lt $size) {
    $stream.Position = $offset
    $read = $stream.Read($buffer, 0, [int][Math]::Min($chunk, $size - $offset))
    $piece = New-Object System.Net.Http.ByteArrayContent ($buffer, 0, $read)
    $piece.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/octet-stream')
    try {
      $result = Send "upload-chunk&id=$id&offset=$offset" $piece
    } catch {
      # A dropped connection: the same piece again, a few times.
      if (++$tries -gt 5) { throw }
      Start-Sleep -Seconds (2 * $tries)
      continue
    }
    if ($result.status -eq 409 -and $null -ne $result.body.received) {
      # The site has a different amount: carry on from what it really has.
      $offset = [int64]$result.body.received
      continue
    }
    if ($result.status -ne 200) {
      if (++$tries -gt 5) { Send 'upload-cancel' (Json @{ id = $id }) | Out-Null; Fail 'Кусок не принят' $result }
      Start-Sleep -Seconds (2 * $tries)
      continue
    }
    $tries = 0
    $offset = [int64]$result.body.received
    Write-Progress -Activity "Загрузка $name" -Status "$([int]($offset / 1MB)) из $([int]($size / 1MB)) МБ" -PercentComplete ([int](100 * $offset / $size))
  }
} finally {
  $stream.Dispose()
  Write-Progress -Activity "Загрузка $name" -Completed
}

$done = Send 'upload-finish' (Json @{ id = $id; sha256 = $sha256 })
if ($done.status -ne 200) { Fail 'Загрузка не завершена' $done }
$client.Dispose()
Write-Output "Выложено на сайт: $name ($Channel$(if ($Latest) { ', последняя' }))"
