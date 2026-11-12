# Generates local media fixtures (no network): phone-style screenshots and a short narrated clip.
param([string]$Out = (Join-Path $PSScriptRoot '..\test\fixtures\media'))
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $Out | Out-Null
function New-Frame($path, [string[]]$lines, $top, $bottom, [int]$size = 64) {
  $bmp = New-Object System.Drawing.Bitmap 1080, 1920
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $rect = New-Object System.Drawing.Rectangle 0, 0, 1080, 1920
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $top, $bottom, 90
  $g.FillRectangle($brush, $rect)
  $font = New-Object System.Drawing.Font 'Segoe UI', $size, ([System.Drawing.FontStyle]::Bold)
  $y = 1300
  foreach ($l in $lines) {
    $sz = $g.MeasureString($l, $font)
    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 0, 0, 0))), 40, $y - 10, [Math]::Min(1000, $sz.Width + 40), $sz.Height + 20)
    $g.DrawString($l, $font, [System.Drawing.Brushes]::White, 60, $y)
    $y += $sz.Height + 40
  }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
}
# 1) Screenshot of a Reel whose location tag reads "Praia da Ursa, Sintra"
New-Frame (Join-Path $Out 'screenshot-location-tag.png') @('Praia da Ursa, Sintra', 'wild beach near Cabo da Roca') ([System.Drawing.Color]::SteelBlue) ([System.Drawing.Color]::SandyBrown)
# 2) Pure landscape (no text at all)
New-Frame (Join-Path $Out 'landscape-no-text.png') @() ([System.Drawing.Color]::Orange) ([System.Drawing.Color]::DarkSlateBlue)
# 3) Video frames: intro + "shown at the end" caption
New-Frame (Join-Path $Out 'clip-frame-1.png') @('Day trip up north!') ([System.Drawing.Color]::DarkGreen) ([System.Drawing.Color]::LightSkyBlue)
New-Frame (Join-Path $Out 'clip-frame-2.png') @('Banias Waterfall', 'Golan Heights') ([System.Drawing.Color]::DarkCyan) ([System.Drawing.Color]::White)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile((Join-Path $Out 'clip-voice.wav'))
$s.Speak('Today we hiked to the Banias Waterfall in the Golan Heights. The viewpoint above the waterfall is at the end.')
$s.Dispose()
Write-Output "fixtures written to $Out"
