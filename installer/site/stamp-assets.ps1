# Puts ?v=<first 8 hex of the file's SHA-256> after every local .css/.js link and screenshot
# (src, data-full and their English twins data-src-en / data-full-en) in the site's pages, so a
# browser fetches a file again as soon as it changes (they are cached for a day).
param([string]$Site = 'website')
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($page in @("$Site\index.html", "$Site\admin\index.html")) {
  $dir = Split-Path $page
  $html = [IO.File]::ReadAllText((Resolve-Path $page))
  $new = [regex]::Replace($html, '(?<attr>(?:href|src|data-full|data-src-en|data-full-en)=")(?<path>(?:\.\./)?(?:[A-Za-z0-9_-]+\.(?:css|js)|assets/shots/[A-Za-z0-9_-]+\.webp))(?:\?v=[0-9a-f]+)?"', {
    param($m)
    $file = Join-Path $dir ($m.Groups['path'].Value -replace '/', '\')
    $hash = (Get-FileHash $file -Algorithm SHA256).Hash.Substring(0, 8).ToLower()
    $m.Groups['attr'].Value + $m.Groups['path'].Value + '?v=' + $hash + '"'
  })
  if ($new -ne $html) { [IO.File]::WriteAllText((Resolve-Path $page), $new, $utf8); "stamped $page" } else { "unchanged $page" }
}
