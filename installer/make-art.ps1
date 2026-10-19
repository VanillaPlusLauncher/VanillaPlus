# Builds the installer's pictures from launcher screenshots and the launcher's own artwork.
# Usage: make-art.ps1 -Shots <folder with inst-*.png> -Panorama <panorama_1.png> -MarkPath <logo.png> -Out <folder>
param([string]$Shots, [string]$Panorama, [string]$MarkPath, [string]$Out)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Out | Out-Null

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'HighQuality'
  $g.PixelOffsetMode = 'HighQuality'
  return @($bmp, $g)
}

# Slides: every screenshot scaled to the slide box (16:10), saved as 24-bit BMP.
$i = 1
foreach ($file in Get-ChildItem $Shots -Filter 'inst-*.png' | Sort-Object Name) {
  $src = [System.Drawing.Image]::FromFile($file.FullName)
  $bmp, $g = New-Canvas 960 600
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, 960, 600))
  $bmp.Save((Join-Path $Out "slide$i.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $g.Dispose(); $bmp.Dispose(); $src.Dispose()
  $i++
}

# Tall picture for the first and last page: a slice of the title-screen panorama, darkened at
# the bottom, with the launcher's mark.
$pano = [System.Drawing.Image]::FromFile($Panorama)
$markImage = [System.Drawing.Image]::FromFile($MarkPath)
$bmp, $g = New-Canvas 410 785
$side = [Math]::Min($pano.Width, $pano.Height)
$cropW = [int]($side * 410 / 785)
$g.DrawImage($pano, (New-Object System.Drawing.Rectangle 0, 0, 410, 785), (New-Object System.Drawing.Rectangle ([int](($pano.Width - $cropW) / 2)), 0, $cropW, $side), [System.Drawing.GraphicsUnit]::Pixel)
$shade = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Rectangle 0, 0, 410, 785), ([System.Drawing.Color]::FromArgb(40, 0, 0, 0)), ([System.Drawing.Color]::FromArgb(225, 8, 12, 11)), 90
$g.FillRectangle($shade, 0, 0, 410, 785)
$g.DrawImage($markImage, (New-Object System.Drawing.Rectangle 125, 560, 160, 160))
$bmp.Save((Join-Path $Out 'wizard-side.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()

# Full-window picture for the welcome page: the panorama with the mark and the name in the middle.
# 3:2 like the wizard page; the wizard stretches it to the page.
$fullW = 1392; $fullH = 915
$bmp, $g = New-Canvas $fullW $fullH
$cropH = [int]($pano.Width * $fullH / $fullW)
$g.DrawImage($pano, (New-Object System.Drawing.Rectangle 0, 0, $fullW, $fullH), (New-Object System.Drawing.Rectangle 0, ([int](($pano.Height - $cropH) * 0.45)), $pano.Width, $cropH), [System.Drawing.GraphicsUnit]::Pixel)
$veil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110, 6, 10, 9))
$g.FillRectangle($veil, 0, 0, $fullW, $fullH)
$glow = New-Object System.Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse(($fullW / 2 - 420), ($fullH / 2 - 330), 840, 640)
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(120, 0, 0, 0)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
$g.FillPath($glowBrush, $glow)
$markSize = 250
$g.DrawImage($markImage, (New-Object System.Drawing.Rectangle ([int](($fullW - $markSize) / 2)), 250, $markSize, $markSize))
$g.TextRenderingHint = 'AntiAliasGridFit'
$format = New-Object System.Drawing.StringFormat
$format.Alignment = 'Center'
$nameBox = New-Object System.Drawing.RectangleF 0, 540, $fullW, 120
$font = New-Object System.Drawing.Font 'Segoe UI Semibold', 64, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$shadowBox = New-Object System.Drawing.RectangleF 0, 544, $fullW, 120
$g.DrawString('Vanilla+ Launcher', $font, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 0, 0, 0))), $shadowBox, $format)
$g.DrawString('Vanilla+ Launcher', $font, [System.Drawing.Brushes]::White, $nameBox, $format)
$bmp.Save((Join-Path $Out 'wizard-full.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()

# Small picture in the top-right corner of the inner pages.
$bmp, $g = New-Canvas 138 140
$g.Clear([System.Drawing.Color]::FromArgb(255, 14, 18, 17))
$g.DrawImage($markImage, (New-Object System.Drawing.Rectangle 14, 15, 110, 110))
$bmp.Save((Join-Path $Out 'wizard-small.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()

# The setup icon (art\setup.ico) comes from import-logo.ps1.
$pano.Dispose(); $markImage.Dispose()
Get-ChildItem $Out | Select-Object Name, Length
