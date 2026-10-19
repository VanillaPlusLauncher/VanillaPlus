# Turns a logo picture into the launcher's mark: the plain background around the logo is removed
# (flood fill from the picture's edges, so light parts inside the logo stay), the empty margins are
# cut, and the result is centred on a transparent square.
# Writes src\assets\branding\amethyx-mark.png (512 px) and installer\art\setup.ico (16-256 px).
#
# Usage: .\import-logo.ps1 -Source <picture> [-Tolerance 40]
# The current logo's original is installer\art\logo-source.png (-Tolerance 40).
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [int]$Tolerance = 40
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot

$image = [System.Drawing.Bitmap]::new((Resolve-Path $Source).Path)
$width = $image.Width
$height = $image.Height
$bitmap = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.DrawImage($image, 0, 0, $width, $height)
$g.Dispose()
$image.Dispose()

# Raw pixel access (BGRA bytes).
$rect = New-Object System.Drawing.Rectangle 0, 0, $width, $height
$data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

# Background removal in C# (a per-pixel loop in PowerShell would take minutes).
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
public static class LogoCutout {
  // Clears pixels connected to the picture's edges that are close to the corner colour.
  // Returns {minX, minY, maxX, maxY} of what is left (maxX = -1 when nothing is).
  public static int[] Run(byte[] px, int width, int height, int stride, int tolerance) {
    double b0 = 0, g0 = 0, r0 = 0;
    int[][] corners = { new[] {0, 0}, new[] {width - 1, 0}, new[] {0, height - 1}, new[] {width - 1, height - 1} };
    foreach (var c in corners) { int i = c[1] * stride + c[0] * 4; b0 += px[i]; g0 += px[i + 1]; r0 += px[i + 2]; }
    b0 /= 4; g0 /= 4; r0 /= 4;
    var seen = new bool[width * height];
    var queue = new Queue<int>();
    for (int x = 0; x < width; x++) { queue.Enqueue(x); queue.Enqueue((height - 1) * width + x); }
    for (int y = 0; y < height; y++) { queue.Enqueue(y * width); queue.Enqueue(y * width + width - 1); }
    while (queue.Count > 0) {
      int p = queue.Dequeue();
      if (seen[p]) continue;
      seen[p] = true;
      int x = p % width, y = p / width, i = y * stride + x * 4;
      double db = px[i] - b0, dg = px[i + 1] - g0, dr = px[i + 2] - r0;
      double d = Math.Sqrt(db * db + dg * dg + dr * dr);
      if (d > tolerance * 2) continue;
      if (d > tolerance) { px[i + 3] = (byte)Math.Min(255, Math.Round(255 * (d - tolerance) / tolerance)); continue; }
      px[i + 3] = 0;
      if (x > 0) queue.Enqueue(p - 1);
      if (x < width - 1) queue.Enqueue(p + 1);
      if (y > 0) queue.Enqueue(p - width);
      if (y < height - 1) queue.Enqueue(p + width);
    }
    int minX = width, minY = height, maxX = -1, maxY = -1;
    for (int y = 0; y < height; y++)
      for (int x = 0; x < width; x++)
        if (px[y * stride + x * 4 + 3] > 16) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    return new[] { minX, minY, maxX, maxY };
  }
}
"@
$bounds = [LogoCutout]::Run($bytes, $width, $height, $stride, $Tolerance)
$minX = $bounds[0]; $minY = $bounds[1]; $maxX = $bounds[2]; $maxY = $bounds[3]
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$bitmap.UnlockBits($data)
if ($maxX -lt 0) { throw 'После удаления фона ничего не осталось: уменьшите -Tolerance.' }

function Save-Square([int]$size, [string]$path) {
  $square = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gs = [System.Drawing.Graphics]::FromImage($square)
  $gs.Clear([System.Drawing.Color]::Transparent)
  $gs.InterpolationMode = 'HighQualityBicubic'
  $gs.PixelOffsetMode = 'HighQuality'
  $gs.SmoothingMode = 'HighQuality'
  $w = $maxX - $minX + 1
  $h = $maxY - $minY + 1
  $margin = [Math]::Round($size * 0.06)
  $scale = ($size - 2 * $margin) / [Math]::Max($w, $h)
  $dw = [Math]::Round($w * $scale); $dh = [Math]::Round($h * $scale)
  $gs.DrawImage($bitmap, (New-Object System.Drawing.Rectangle ([int](($size - $dw) / 2)), ([int](($size - $dh) / 2)), $dw, $dh), (New-Object System.Drawing.Rectangle $minX, $minY, $w, $h), [System.Drawing.GraphicsUnit]::Pixel)
  $gs.Dispose()
  if ($path) { $square.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) }
  return $square
}

$mark = Join-Path $root 'src\assets\branding\amethyx-mark.png'
(Save-Square 512 $mark).Dispose()

# Windows icon: several sizes as PNG entries in one .ico.
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($size in $sizes) {
  $square = Save-Square $size $null
  $ms = New-Object System.IO.MemoryStream
  $square.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $square.Dispose()
  , $ms.ToArray()
}
$ico = Join-Path $root 'installer\art\setup.ico'
$fs = [System.IO.File]::Create($ico)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($k = 0; $k -lt $sizes.Count; $k++) {
  $s = $sizes[$k]
  $w.Write([Byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([Byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$pngs[$k].Length); $w.Write([UInt32]$offset)
  $offset += $pngs[$k].Length
}
foreach ($png in $pngs) { $w.Write($png) }
$w.Close()
$bitmap.Dispose()
Write-Output $mark
Write-Output $ico
