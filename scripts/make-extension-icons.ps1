<#
.SYNOPSIS
  Rebuild extension/icons/icon{16,32,48}.png from icon128.png.

.DESCRIPTION
  Chrome picks the icon closest to the size it needs and scales it itself, which
  looks soft on the 16px toolbar slot. Shipping the small sizes means the browser
  never has to guess.

  Run this after replacing icon128.png so the set stays in step; it is not part
  of any build, because the source changes about once a year.

    pwsh scripts/make-extension-icons.ps1

  High-quality bicubic with premultiplied alpha handling, so a source with
  transparency keeps clean edges rather than dark fringing.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$iconDir = Join-Path $PSScriptRoot '..\extension\icons'
$source = Join-Path $iconDir 'icon128.png'

if (-not (Test-Path $source)) { throw "Source introuvable : $source" }

$src = [System.Drawing.Image]::FromFile($source)
try {
  Write-Host "Source : icon128.png ($($src.Width)x$($src.Height), $($src.PixelFormat))"

  foreach ($size in 16, 32, 48) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $bmp.SetResolution($src.HorizontalResolution, $src.VerticalResolution)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        # Wrap-mode Clamp: without it, bicubic samples past the edge and leaves
        # a translucent halo on the outermost row of pixels.
        $attr = New-Object System.Drawing.Imaging.ImageAttributes
        try {
          $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
          $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
          $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
        } finally { $attr.Dispose() }
      } finally { $g.Dispose() }

      $out = Join-Path $iconDir "icon$size.png"
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Host "  ecrit  icon$size.png ($((Get-Item $out).Length) octets)"
    } finally { $bmp.Dispose() }
  }
} finally { $src.Dispose() }

Write-Host 'Termine. Les quatre tailles sont referencees dans extension/manifest.json.'
