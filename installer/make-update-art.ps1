# Pictures of the small "updating" window the installer shows when the launcher updates itself
# (/relaunch=1, BuildUpdateWindow in Amethyx.iss), in the launcher's pixel look: the X mark, the
# title in Tiny5, a pixel frame and a progress track. Drawn at 1x, 2x and 3x (the installer picks
# one for the screen's scale), so the pixels stay sharp:
#   art\update-bg-<k>x.bmp    the whole window with an empty track,
#   art\update-fill-<k>x.bmp  the full bar; the installer shows as much of it as is done.
# Tiny5 (SIL Open Font License) is downloaded once and checked.
# Usage: .\make-update-art.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$art = Join-Path $PSScriptRoot 'art'
$font = Join-Path $env:TEMP 'Tiny5-Regular.ttf'
$fontSha256 = 'eb4206abc0c73e9fe4fe93c034ea270578859c40a7e740c6207322413c5c4c91'
if (-not (Test-Path $font) -or (Get-FileHash $font -Algorithm SHA256).Hash.ToLower() -ne $fontSha256) {
  curl.exe -sSL -o $font 'https://fonts.gstatic.com/s/tiny5/v3/KFOpCnmCvdGT7hw-.ttf'
  if ((Get-FileHash $font -Algorithm SHA256).Hash.ToLower() -ne $fontSha256) { Remove-Item $font; throw 'Контрольная сумма Tiny5 не совпала.' }
}
$fonts = New-Object System.Drawing.Text.PrivateFontCollection
$fonts.AddFontFile($font)
$tiny5 = $fonts.Families[0]

# Layout at 1x (the installer uses the same numbers for the bar: FillLeft, FillTop in Amethyx.iss).
$W = 480; $H = 120
$track = @{ X = 100; Y = 82; W = 360; H = 16 }
$segment = 12
$cut = 6

function Color([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function Fill($g, [string]$hex, [int]$x, [int]$y, [int]$w, [int]$h, [int]$k) {
  $brush = New-Object System.Drawing.SolidBrush (Color $hex)
  $g.FillRectangle($brush, $x * $k, $y * $k, $w * $k, $h * $k)
  $brush.Dispose()
}
# A frame of 2 pixels with cut corners, like the launcher's cards.
function Frame($g, [string]$hex, [int]$x, [int]$y, [int]$w, [int]$h, [int]$k) {
  Fill $g $hex ($x + 2) $y ($w - 4) 2 $k
  Fill $g $hex ($x + 2) ($y + $h - 2) ($w - 4) 2 $k
  Fill $g $hex $x ($y + 2) 2 ($h - 4) $k
  Fill $g $hex ($x + $w - 2) ($y + 2) 2 ($h - 4) $k
}

# The mark without its white background.
$original = [System.Drawing.Image]::FromFile((Join-Path $art 'logo-source.png'))
$source = New-Object System.Drawing.Bitmap $original, 256, 256
$original.Dispose()
$mark = New-Object System.Drawing.Bitmap $source.Width, $source.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for ($y = 0; $y -lt $source.Height; $y++) {
  for ($x = 0; $x -lt $source.Width; $x++) {
    $c = $source.GetPixel($x, $y)
    $light = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
    $alpha = if ($light -gt 236) { 0 } elseif ($light -gt 200) { [int](255 * (236 - $light) / 36) } else { 255 }
    $alpha = [Math]::Min($alpha, [int]$c.A)
    $mark.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B))
  }
}
$source.Dispose()

foreach ($k in 1, 2, 3) {
  $bmp = New-Object System.Drawing.Bitmap ($W * $k), ($H * $k), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # The panel with one-step cut corners (the installer cuts the window to the same shape, $cut),
  # a 2-pixel frame along that outline and no light strip on top.
  $g.Clear((Color '#16121f'))
  $c = $cut
  foreach ($edge in @(@($c, 0, ($W - 2 * $c), 2), @($c, ($H - 2), ($W - 2 * $c), 2), @(0, $c, 2, ($H - 2 * $c)), @(($W - 2), $c, 2, ($H - 2 * $c)))) {
    Fill $g '#2b2140' $edge[0] $edge[1] $edge[2] $edge[3] $k
  }
  foreach ($corner in @(@(0, 0, 1, 1), @(($W - $c - 2), 0, -1, 1), @(0, ($H - $c - 2), 1, -1), @(($W - $c - 2), ($H - $c - 2), -1, -1))) {
    $x = $corner[0]; $y = $corner[1]
    # The step: across at the cut's depth and down at its width.
    $stepY = if ($corner[3] -gt 0) { $y + $c } else { $y }
    $stepX = if ($corner[2] -gt 0) { $x + $c } else { $x }
    Fill $g '#2b2140' $x $stepY ($c + 2) 2 $k
    Fill $g '#2b2140' $stepX $y 2 ($c + 2) $k
  }

  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($mark, (New-Object System.Drawing.Rectangle (20 * $k), (28 * $k), (64 * $k), (64 * $k)))

  # Both lines in Tiny5, the launcher's pixel font; each must fit above the track.
  $g.TextRenderingHint = 'SingleBitPerPixelGridFit'
  $big = New-Object System.Drawing.Font $tiny5, (24 * $k), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $small = New-Object System.Drawing.Font $tiny5, (16 * $k), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  foreach ($line in @(@('Обновляем Amethyx', $big, '#f1ecfb', 20), @('Откроется сам через пару секунд', $small, '#a99bc0', 54))) {
    if ($g.MeasureString($line[0], $line[1]).Width -gt $track.W * $k) { throw "Не помещается: $($line[0])" }
    $g.DrawString($line[0], $line[1], (New-Object System.Drawing.SolidBrush (Color $line[2])), ($track.X * $k), ($line[3] * $k))
  }

  Frame $g '#2b2140' $track.X $track.Y $track.W $track.H $k
  Fill $g '#07050b' ($track.X + 2) ($track.Y + 2) ($track.W - 4) ($track.H - 4) $k
  $bmp.Save((Join-Path $art "update-bg-${k}x.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $g.Dispose(); $bmp.Dispose()

  # The bar: amethyst blocks with a light top and a dark bottom row, a gap between blocks.
  $fw = $track.W - 4; $fh = $track.H - 4
  $bar = New-Object System.Drawing.Bitmap ($fw * $k), ($fh * $k), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bar)
  $g.Clear((Color '#07050b'))
  for ($x = 0; $x -lt $fw; $x += $segment) {
    $bw = [Math]::Min($segment - 2, $fw - $x)
    Fill $g '#8b5cf6' $x 0 $bw $fh $k
    Fill $g '#b794ff' $x 0 $bw 2 $k
    Fill $g '#6a3fd0' $x ($fh - 2) $bw 2 $k
  }
  $bar.Save((Join-Path $art "update-fill-${k}x.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $g.Dispose(); $bar.Dispose()
  "update art ${k}x"
}
$mark.Dispose()
