Add-Type -AssemblyName System.Drawing

$iconDirectory = Join-Path $PSScriptRoot '../extension/icons'
[System.IO.Directory]::CreateDirectory($iconDirectory) | Out-Null
$source = [System.Drawing.Bitmap]::new(512, 512)
$graphics = [System.Drawing.Graphics]::FromImage($source)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#b8edce'))
$shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(16, 16, 176, 176, 180, 90)
$shape.AddArc(320, 16, 176, 176, 270, 90)
$shape.AddArc(320, 320, 176, 176, 0, 90)
$shape.AddArc(16, 320, 176, 176, 90, 90)
$shape.CloseFigure()
$graphics.FillPath($background, $shape)
$arrow = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#16392c'), 48)
$arrow.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$arrow.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$arrow.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawLine($arrow, 162, 162, 350, 350)
$points = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(350, 195),
  [System.Drawing.PointF]::new(350, 350),
  [System.Drawing.PointF]::new(195, 350)
)
$graphics.DrawLines($arrow, $points)
foreach ($size in @(16, 32, 48, 128)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $canvas = [System.Drawing.Graphics]::FromImage($bitmap)
  $canvas.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $canvas.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $canvas.DrawImage($source, 0, 0, $size, $size)
  $bitmap.Save((Join-Path $iconDirectory "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
  $bitmap.Dispose()
}
$arrow.Dispose()
$shape.Dispose()
$background.Dispose()
$graphics.Dispose()
$source.Dispose()
