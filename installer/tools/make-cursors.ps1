# Draws the launcher's pixel cursors in amethyst: src\assets\cursors\amethyst-arrow.png and
# amethyst-hand.png. Each picture is drawn from the pixel maps below ('#' outline, 'o' amethyst, '.'
# empty), every pixel twice as big, with the amethyst going from light at the top to deep below.
# Usage: .\make-cursors.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$out = Join-Path $root 'src\assets\cursors'
New-Item -ItemType Directory -Force $out | Out-Null

$arrow = @(
  '#..........',
  '##.........',
  '#o#........',
  '#oo#.......',
  '#ooo#......',
  '#oooo#.....',
  '#ooooo#....',
  '#oooooo#...',
  '#ooooooo#..',
  '#oooooooo#.',
  '#ooooo#####',
  '#oo#oo#....',
  '#o#.#oo#...',
  '##..#oo#...',
  '.....#oo#..',
  '......##...'
)
$hand = @(
  '....##.........',
  '...#oo#........',
  '...#oo#........',
  '...#oo#........',
  '...#oo###......',
  '...#oo#oo###...',
  '...#oo#oo#oo##.',
  '##.#oo#oo#oo#o#',
  '#o##oooooooooo#',
  '#oo#oooooooooo#',
  '.#oooooooooooo#',
  '.#ooooooooooo#.',
  '..#oooooooooo#.',
  '...#oooooooo#..',
  '....#oooooo#...',
  '....########...'
)

function Mix([int[]]$a, [int[]]$b, [double]$t) {
  return [System.Drawing.Color]::FromArgb(255, [int]($a[0] + ($b[0] - $a[0]) * $t), [int]($a[1] + ($b[1] - $a[1]) * $t), [int]($a[2] + ($b[2] - $a[2]) * $t))
}

function Draw([string[]]$map, [string]$name) {
  $scale = 2
  $width = $map[0].Length
  $height = $map.Count
  $bitmap = New-Object System.Drawing.Bitmap ($width * $scale), ($height * $scale), ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $outline = [System.Drawing.Color]::FromArgb(255, 28, 14, 58)
  for ($y = 0; $y -lt $height; $y++) {
    # Light lilac at the top to deep amethyst at the bottom; the left column of the fill a bit lighter.
    $fill = Mix @(232, 220, 255) @(142, 98, 236) ($y / [Math]::Max(1, $height - 1))
    $shine = Mix @(250, 246, 255) @(196, 170, 255) ($y / [Math]::Max(1, $height - 1))
    for ($x = 0; $x -lt $width; $x++) {
      $char = $map[$y][$x]
      if ($char -eq '.') { continue }
      $color = if ($char -eq '#') { $outline } elseif ($x -gt 0 -and $map[$y][$x - 1] -eq '#') { $shine } else { $fill }
      for ($dy = 0; $dy -lt $scale; $dy++) {
        for ($dx = 0; $dx -lt $scale; $dx++) { $bitmap.SetPixel($x * $scale + $dx, $y * $scale + $dy, $color) }
      }
    }
  }
  $path = Join-Path $out $name
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Output $path
}

Draw $arrow 'amethyst-arrow.png'
Draw $hand 'amethyst-hand.png'
