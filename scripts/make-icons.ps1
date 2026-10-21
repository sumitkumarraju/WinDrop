# Draws the WinDrop icon (blue tile with radio waves) as PNGs and a Windows .ico.
# Run once: powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot

function New-Icon([int]$size, [string]$out, [bool]$rounded) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)

    $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(58, 155, 255)), ([System.Drawing.Color]::FromArgb(0, 96, 208)), 45
    if ($rounded) {
        $r = $size * 0.23; $d = $r * 2
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc(0, 0, $d, $d, 180, 90)
        $path.AddArc($size - $d, 0, $d, $d, 270, 90)
        $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
        $path.AddArc(0, $size - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $g.FillPath($brush, $path)
    } else {
        $g.FillRectangle($brush, $rect)   # iOS rounds the corners itself
    }

    $c = $size / 2
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ($size * 0.06)
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $dot = $size * 0.07
    $g.FillEllipse([System.Drawing.Brushes]::White, $c - $dot, $c - $dot, $dot * 2, $dot * 2)
    foreach ($radius in @(($size * 0.19), ($size * 0.31))) {
        $box = New-Object System.Drawing.RectangleF ($c - $radius), ($c - $radius), ($radius * 2), ($radius * 2)
        $g.DrawArc($pen, $box, -45, 90)
        $g.DrawArc($pen, $box, 135, 90)
    }
    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

New-Icon 256 (Join-Path $root 'public\icon-256.png') $true
New-Icon 180 (Join-Path $root 'public\apple-touch-icon.png') $false

# .ico that simply wraps the 256 px PNG (supported since Windows Vista)
$png = [IO.File]::ReadAllBytes((Join-Path $root 'public\icon-256.png'))
$ms = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)
$w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
$w.Write($png)
[IO.File]::WriteAllBytes((Join-Path $root 'windrop.ico'), $ms.ToArray())
"Icons written."
