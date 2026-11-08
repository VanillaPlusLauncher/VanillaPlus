# Pictures of the small "updating" window the installer shows when the launcher updates itself
# (/relaunch=1, BuildUpdateWindow in Amethyx.iss), in the launcher's soft look: a raised violet
# panel, the X mark with a glow behind it, the title in Tiny5 (the launcher's font), room for the
# line the installer writes (what it is doing now) and a round track that fills with a soft violet
# pill. Drawn at Windows' usual scales, in percent ($scales; the installer picks the nearest one):
#   art\update-bg-<percent>.bmp    the whole window with an empty track,
#   art\update-fill-<percent>.bmp  the track filled to the end; the installer shows as much of it as is done,
#   art\update-cap-<percent>.bmp   the round end of the pill over the track, put at the edge of what is shown,
#   art\update-mark-<percent>.bmp  the X building itself of pieces (art-src\UpdateMark.cs): $frames pictures
#                                  of the place round it side by side, shown one after another (one loop:
#                                  UpdateMarkPeriod in Amethyx.iss).
# The pill is the same in every column (light on top, deeper below), so the cap fits wherever it stands.
# Every place is the 1x one times the scale, rounded half up, as Amethyx.iss puts it (ScaledBy).
# Tiny5 (SIL Open Font License) is downloaded once and checked.
# Usage: .\make-update-art.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'art-src\UpdateMark.cs') -ReferencedAssemblies System.Drawing
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
# The place the X is drawn in (UpdateMarkLeft, UpdateMarkTop in Amethyx.iss; its pieces never leave it)
# and its frames (UpdateMarkFrames); the X stands at 24, 32, 64 × 64, its middle at 56, 64.
$markBox = @{ X = 14; Y = 14; W = 84; H = 92 }
$frames = 72
# Percent; the same list as PictureScale in Amethyx.iss and render-setup-ui.js.
$scales = 100, 125, 150, 175, 200, 225, 250, 300
# A 1x length at scale $k (1.25 for 125 %), rounded half up like ScaledBy in Amethyx.iss.
function Px([double]$value, [double]$k) { [int][Math]::Floor($value * $k + 0.5) }

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
# $moment: the moment of the X's loop (0..1), or -1 for the whole X standing still.
function Draw-Window([double]$k, $pillEnd, [double]$moment = -1) {
  $bmp = New-Object System.Drawing.Bitmap (Px $W $k), (Px $H $k), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'

  # The panel: lighter on top, deeper below, a thin light edge along the top (like soft.css).
  $all = New-Object System.Drawing.Rectangle 0, 0, (Px $W $k), (Px $H $k)
  $panel = New-Object System.Drawing.Drawing2D.LinearGradientBrush $all, (Color '#30274a'), (Color '#1f1930'), 90
  $g.FillRectangle($panel, $all)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (Color '#ffffff' 30)), 0, 0, (Px $W $k), (Px 1 $k))

  # A violet glow behind the mark, then the mark.
  $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glow.AddEllipse((4 * $k), (12 * $k), (104 * $k), (104 * $k))
  $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
  $glowBrush.CenterColor = Color '#9670f5' 120
  $glowBrush.SurroundColors = @(Color '#9670f5' 0)
  $g.FillPath($glowBrush, $glow)
  $g.InterpolationMode = 'HighQualityBicubic'
  $left = Px $markBox.X $k; $top = Px $markBox.Y $k
  $g.SetClip((New-Object System.Drawing.Rectangle $left, $top, ((Px ($markBox.X + $markBox.W) $k) - $left), ((Px ($markBox.Y + $markBox.H) $k) - $top)))
  [UpdateMark]::Paint($g, $mark, $k, $moment)
  $g.ResetClip()

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

# The part of a 1x box ($x, $y, $w, $h) at scale $k, cut where Amethyx.iss puts it.
function Save-Crop($bmp, [double]$k, [double]$x, [double]$y, [double]$w, [double]$h, [string]$name) {
  $left = Px $x $k; $top = Px $y $k
  $box = New-Object System.Drawing.Rectangle $left, $top, ((Px ($x + $w) $k) - $left), ((Px ($y + $h) $k) - $top)
  $crop = $bmp.Clone($box, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $crop.Save((Join-Path $art $name), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $crop.Dispose()
}

# Pictures of the previous scales go; the ones drawn now take their place.
Get-ChildItem $art -Filter 'update-*.bmp' | Remove-Item
foreach ($percent in $scales) {
  $k = $percent / 100
  $empty = Draw-Window $k $null
  $empty.Save((Join-Path $art "update-bg-$percent.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $empty.Dispose()

  $full = Draw-Window $k ($track.X + $track.W)
  Save-Crop $full $k $track.X $track.Y $track.W $track.H "update-fill-$percent.bmp"
  $full.Dispose()

  # The last $radius columns of a pill that ends at $capEnd: its round end over the track.
  $ended = Draw-Window $k $capEnd
  Save-Crop $ended $k ($capEnd - $radius) $track.Y $radius $track.H "update-cap-$percent.bmp"
  $ended.Dispose()

  # The X building itself: the place round it at each moment, side by side (every frame the same size,
  # so the installer finds a frame as the strip's width / $frames).
  $left = Px $markBox.X $k; $top = Px $markBox.Y $k
  $frameW = (Px ($markBox.X + $markBox.W) $k) - $left
  $frameH = (Px ($markBox.Y + $markBox.H) $k) - $top
  $strip = New-Object System.Drawing.Bitmap ($frameW * $frames), $frameH, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $sg = [System.Drawing.Graphics]::FromImage($strip)
  $place = New-Object System.Drawing.Rectangle $left, $top, $frameW, $frameH
  for ($f = 0; $f -lt $frames; $f++) {
    $posed = Draw-Window $k $null ($f / $frames)
    $sg.DrawImage($posed, (New-Object System.Drawing.Rectangle ($f * $frameW), 0, $frameW, $frameH), $place, [System.Drawing.GraphicsUnit]::Pixel)
    $posed.Dispose()
  }
  $sg.Dispose()
  $strip.Save((Join-Path $art "update-mark-$percent.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $strip.Dispose()
  "update art $percent %"
}
$mark.Dispose()
