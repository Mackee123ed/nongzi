# ASCII-only on purpose: PowerShell reads .ps1 in the ANSI codepage,
# so Chinese literals here would be garbled. Paths are derived instead.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = (Get-ChildItem -Path $PSScriptRoot -Filter *.jpg | Select-Object -First 1).FullName
if (-not $src) { throw 'no source jpg found' }

$img = [System.Drawing.Image]::FromFile($src)
foreach ($s in 16, 24, 32, 48, 64, 128, 256) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $s, $s)
  $g.Dispose()
  $bmp.Save((Join-Path $PSScriptRoot "icon_$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$img.Dispose()
Write-Output 'PNG sizes generated'
