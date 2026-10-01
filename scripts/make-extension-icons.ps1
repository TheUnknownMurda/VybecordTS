<#
.SYNOPSIS
  Rebuild extension/icons/icon{16,32,48,128}.png from the Vybecord mark.

.DESCRIPTION
  The whole set is drawn here, from the mark in website/favicon.svg: a dark
  rounded square, a faint green ring, and the beamed note. icon128.png used to
  be hand-dropped artwork that this script only resized, and what landed there
  was a flat green square — which is what the browser then showed in its
  extensions menu, beside every other extension's logo.

  There is no SVG rasteriser anywhere in the tree, so the geometry is redrawn
  with GDI+ primitives. That means it is a TRANSCRIPTION of the SVG, not a
  rendering of it: change website/favicon.svg and this must be changed with it,
  or the browser and the website will show two different marks.

  Chrome picks the icon closest to the size it needs and scales it itself, which
  looks soft in the 16px toolbar slot. Shipping the small sizes means the
  browser never has to guess.

  Not part of any build — the mark changes about once a year.

    pwsh scripts/make-extension-icons.ps1

  Bump the version in extension/manifest.json afterwards and re-run
  scripts/pack-extension.mjs, or the store zips keep the old icons.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$iconDir = Join-Path $PSScriptRoot '..\extension\icons'
$source = Join-Path $iconDir 'icon128.png'

# The SVG's viewBox is 0 0 64 64; every unit below is multiplied by this.
$SCALE = 2.0
$FULL = 128

function New-RoundRect([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $path
}

# ── Draw the 128, the one every other size is sampled from ───────────────────

$bmp = New-Object System.Drawing.Bitmap $FULL, $FULL, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # <rect width="64" height="64" rx="15" fill="#06060a"/>
    $bg = New-RoundRect 0 0 $FULL $FULL (15 * $SCALE)
    try {
      $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#06060a'))
      try { $g.FillPath($brush, $bg) } finally { $brush.Dispose() }
    } finally { $bg.Dispose() }

    # <rect x="1" y="1" width="62" height="62" rx="14.5" stroke="#10b981" stroke-opacity=".35"/>
    $ring = New-RoundRect (1 * $SCALE) (1 * $SCALE) (62 * $SCALE) (62 * $SCALE) (14.5 * $SCALE)
    try {
      $accent = [System.Drawing.ColorTranslator]::FromHtml('#10b981')
      # .35 opacity, as an alpha byte.
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(89, $accent.R, $accent.G, $accent.B)), (1 * $SCALE)
      try { $g.DrawPath($pen, $ring) } finally { $pen.Dispose() }
    } finally { $ring.Dispose() }

    $note = [System.Drawing.ColorTranslator]::FromHtml('#34d399')

    # <path d="M25 41.5V22.8l17-3.3v18.7" stroke-width="4" round cap and join/>
    $stem = New-Object System.Drawing.Drawing2D.GraphicsPath
    try {
      $stem.AddLine((25 * $SCALE), (41.5 * $SCALE), (25 * $SCALE), (22.8 * $SCALE))
      $stem.AddLine((25 * $SCALE), (22.8 * $SCALE), (42 * $SCALE), (19.5 * $SCALE))
      $stem.AddLine((42 * $SCALE), (19.5 * $SCALE), (42 * $SCALE), (38.2 * $SCALE))
      $pen = New-Object System.Drawing.Pen $note, (4 * $SCALE)
      try {
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawPath($pen, $stem)
      } finally { $pen.Dispose() }
    } finally { $stem.Dispose() }

    # <circle cx="21" cy="42" r="4.6"/> and <circle cx="38" cy="38.6" r="4.6"/>
    $headBrush = New-Object System.Drawing.SolidBrush $note
    try {
      foreach ($head in @(@(21, 42), @(38, 38.6))) {
        $r = 4.6 * $SCALE
        $g.FillEllipse($headBrush, ($head[0] * $SCALE - $r), ($head[1] * $SCALE - $r), ($r * 2), ($r * 2))
      }
    } finally { $headBrush.Dispose() }
  } finally { $g.Dispose() }

  $bmp.Save($source, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "  ecrit  icon128.png ($((Get-Item $source).Length) octets)"
} finally { $bmp.Dispose() }

# ── Sample it down for the sizes the browser would otherwise guess at ────────
#
# High-quality bicubic with premultiplied alpha handling, so the transparent
# corners of the rounded square keep clean edges rather than dark fringing.

$src = [System.Drawing.Image]::FromFile($source)
try {
  foreach ($size in 16, 32, 48) {
    $small = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $small.SetResolution($src.HorizontalResolution, $src.VerticalResolution)
      $g = [System.Drawing.Graphics]::FromImage($small)
      try {
        $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        # Wrap-mode clamp: without it, bicubic samples past the edge and leaves
        # a translucent halo on the outermost row of pixels.
        $attr = New-Object System.Drawing.Imaging.ImageAttributes
        try {
          $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
          $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
          $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
        } finally { $attr.Dispose() }
      } finally { $g.Dispose() }

      $out = Join-Path $iconDir "icon$size.png"
      $small.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Host "  ecrit  icon$size.png ($((Get-Item $out).Length) octets)"
    } finally { $small.Dispose() }
  }
} finally { $src.Dispose() }

Write-Host 'Termine. Les quatre tailles sont referencees dans extension/manifest.json.'
