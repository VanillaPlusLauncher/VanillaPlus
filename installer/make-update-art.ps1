# Pictures of the small "updating" window the installer shows when the launcher updates itself
# (/relaunch=1, BuildUpdateWindow in Amethyx.iss), in the launcher's soft look: a raised violet
# panel, the X mark with a glow behind it, the title in Tiny5 (the launcher's font), room for the
# line the installer writes (what it is doing now) and a round track that fills with a soft violet
# pill. Drawn at 1x, 2x and 3x (the installer picks one for the screen's scale):
#   art\update-bg-<k>x.bmp    the whole window with an empty track,
#   art\update-fill-<k>x.bmp  the track filled to the end; the installer shows as much of it as is done,
#   art\update-cap-<k>x.bmp   the round end of the pill over the track, put at the edge of what is shown,
#   art\update-mark-<k>x.bmp  the X bobbing like the launcher's loading mark: $frames pictures of the
#                             place round it side by side, shown one after another (one turn: $period ms).
# The pill is the same in every column (light on top, deeper below), so the cap fits wherever it stands.
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

# Layout at 1x (the installer uses the same numbers: UpdateFillLeft, UpdateFillTop in Amethyx.iss).
$W = 480; $H = 128
$track = @{ X = 104; Y = 92; W = 352; H = 12 }
$radius = $track.H / 2
# Where the pill ends when the cap is cut out (any place in the straight part of the track).
$capEnd = $track.X + 200
# The place the bobbing X moves in (UpdateMarkLeft, UpdateMarkTop in Amethyx.iss) and its frames;
# the mark stands at 24, 32, 64 × 64, its middle at 56, 64.
$markBox = @{ X = 14; Y = 14; W = 84; H = 92 }
$frames = 24

# mark-bob from the launcher (css/features/shell.css): [time, lift, angle, scale], each step eased by
# cubic-bezier(0.45, 0, 0.55, 1). The lift is larger than its 5 px: this mark is bigger than 26 px.
$keys = @(@(0, 0, -6, 1), @(0.45, -8, 6, 1.06), @(0.6, -6.5, 5, 1.05), @(1, 0, -6, 1))
function Ease([double]$t) {
  $lo = 0.0; $hi = 1.0
  for ($i = 0; $i -lt 40; $i++) {
    $u = ($lo + $hi) / 2
    $x = 3 * (1 - $u) * (1 - $u) * $u * 0.45 + 3 * (1 - $u) * $u * $u * 0.55 + $u * $u * $u
    if ($x -lt $t) { $lo = $u } else { $hi = $u }
  }
  $u = ($lo + $hi) / 2
  3 * (1 - $u) * $u * $u + $u * $u * $u
}
function Pose([double]$p) {
  for ($i = 0; $i -lt $keys.Count - 1; $i++) {
    $a = $keys[$i]; $b = $keys[$i + 1]
    if ($p -le $b[0]) {
      $e = Ease (($p - $a[0]) / ($b[0] - $a[0]))
      return @{ Lift = $a[1] + ($b[1] - $a[1]) * $e; Angle = $a[2] + ($b[2] - $a[2]) * $e; Scale = $a[3] + ($b[3] - $a[3]) * $e }
    }
  }
}

function Color([string]$hex, [int]$alpha = 255) { [System.Drawing.Color]::FromArgb($alpha, [System.Drawing.ColorTranslator]::FromHtml($hex)) }
function Pill([float]$x, [float]$y, [float]$w, [float]$h) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $h
  $path.AddArc($x, $y, $d, $d, 90, 180)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 180)
  $path.CloseFigure()
  $path
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

# The whole window at scale $k; $pillEnd: $null — an empty track, otherwise where the pill ends (1x);
# $pose: how the mark stands (the first frame when left out).
function Draw-Window([int]$k, $pillEnd, $pose = (Pose 0)) {
  $bmp = New-Object System.Drawing.Bitmap ($W * $k), ($H * $k), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'

  # The panel: lighter on top, deeper below, a thin light edge along the top (like soft.css).
  $all = New-Object System.Drawing.Rectangle 0, 0, ($W * $k), ($H * $k)
  $panel = New-Object System.Drawing.Drawing2D.LinearGradientBrush $all, (Color '#30274a'), (Color '#1f1930'), 90
  $g.FillRectangle($panel, $all)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (Color '#ffffff' 30)), 0, 0, $W * $k, $k)

  # A violet glow behind the mark, then the mark.
  $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glow.AddEllipse((4 * $k), (12 * $k), (104 * $k), (104 * $k))
  $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
  $glowBrush.CenterColor = Color '#9670f5' 120
  $glowBrush.SurroundColors = @(Color '#9670f5' 0)
  $g.FillPath($glowBrush, $glow)
  $g.InterpolationMode = 'HighQualityBicubic'
  $state = $g.Save()
  $g.TranslateTransform((56 * $k), ((64 + $pose.Lift) * $k))
  $g.RotateTransform($pose.Angle)
  $g.ScaleTransform($pose.Scale, $pose.Scale)
  $g.DrawImage($mark, (New-Object System.Drawing.RectangleF (-32 * $k), (-32 * $k), (64 * $k), (64 * $k)))
  $g.Restore($state)

  # The title in Tiny5, the launcher's font. The line under it (what is being done right now) is
  # written by the installer itself (ShowUpdateStatus in Amethyx.iss).
  $g.TextRenderingHint = 'SingleBitPerPixelGridFit'
  $big = New-Object System.Drawing.Font $tiny5, (24 * $k), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  # Typographic: no padding before the first letter, so it starts where that line and the track do.
  $title = 'Обновляем Amethyx'
  $exact = [System.Drawing.StringFormat]::GenericTypographic
  if ($g.MeasureString($title, $big, [int]::MaxValue, $exact).Width -gt $track.W * $k) { throw "Не помещается: $title" }
  $g.DrawString($title, $big, (New-Object System.Drawing.SolidBrush (Color '#f4effd')), [float]($track.X * $k), [float](22 * $k), $exact)

  # The track: a sunken pill, darker along its top inside edge, a faint light along the bottom.
  $trackPath = Pill ($track.X * $k) ($track.Y * $k) ($track.W * $k) ($track.H * $k)
  $g.FillPath((New-Object System.Drawing.SolidBrush (Color '#171221')), $trackPath)
  $g.SetClip($trackPath)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (Color '#000000' 110)), ($track.X * $k), ($track.Y * $k), ($track.W * $k), (2 * $k))
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (Color '#ffffff' 18)), ($track.X * $k), (($track.Y + $track.H - 1) * $k), ($track.W * $k), $k)
  $g.ResetClip()

  if ($null -ne $pillEnd) {
    # The pill: light violet on top to deep violet below, a soft shine near the top.
    $length = $pillEnd - $track.X
    $pill = Pill ($track.X * $k) ($track.Y * $k) ($length * $k) ($track.H * $k)
    $rect = New-Object System.Drawing.RectangleF ($track.X * $k), ($track.Y * $k), ($length * $k), ($track.H * $k)
    $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, (Color '#c2a6ff'), (Color '#8157ec'), 90
    $g.FillPath($fill, $pill)
    $shine = Pill (($track.X + $radius / 2) * $k) (($track.Y + 2) * $k) (($length - $radius) * $k) (3 * $k)
    $g.FillPath((New-Object System.Drawing.SolidBrush (Color '#ffffff' 70)), $shine)
  }
  $g.Dispose()
  $bmp
}

function Save-Crop($bmp, [int]$x, [int]$y, [int]$w, [int]$h, [string]$name) {
  $crop = $bmp.Clone((New-Object System.Drawing.Rectangle $x, $y, $w, $h), [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $crop.Save((Join-Path $art $name), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $crop.Dispose()
}

foreach ($k in 1, 2, 3) {
  $empty = Draw-Window $k $null
  $empty.Save((Join-Path $art "update-bg-${k}x.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $empty.Dispose()

  $full = Draw-Window $k ($track.X + $track.W)
  Save-Crop $full ($track.X * $k) ($track.Y * $k) ($track.W * $k) ($track.H * $k) "update-fill-${k}x.bmp"
  $full.Dispose()

  # The last $radius columns of a pill that ends at $capEnd: its round end over the track.
  $ended = Draw-Window $k $capEnd
  Save-Crop $ended (($capEnd - $radius) * $k) ($track.Y * $k) ($radius * $k) ($track.H * $k) "update-cap-${k}x.bmp"
  $ended.Dispose()

  # The bobbing X: the place round the mark in each pose, side by side.
  $strip = New-Object System.Drawing.Bitmap ($markBox.W * $k * $frames), ($markBox.H * $k), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $sg = [System.Drawing.Graphics]::FromImage($strip)
  for ($f = 0; $f -lt $frames; $f++) {
    $posed = Draw-Window $k $null (Pose ($f / $frames))
    $place = New-Object System.Drawing.Rectangle ($markBox.X * $k), ($markBox.Y * $k), ($markBox.W * $k), ($markBox.H * $k)
    $sg.DrawImage($posed, (New-Object System.Drawing.Rectangle ($f * $markBox.W * $k), 0, ($markBox.W * $k), ($markBox.H * $k)), $place, [System.Drawing.GraphicsUnit]::Pixel)
    $posed.Dispose()
  }
  $sg.Dispose()
  $strip.Save((Join-Path $art "update-mark-${k}x.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $strip.Dispose()
  "update art ${k}x"
}
$mark.Dispose()
