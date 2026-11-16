param([switch]$Tests)
$ErrorActionPreference = 'Stop'
$frameworkPath = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compilerPath = Join-Path $frameworkPath 'csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw '.NET Framework 4.x не найден.' }
$outputDirectory = Join-Path $PSScriptRoot 'bin'
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$references = @('System.Core.dll', 'System.Web.dll', 'System.Web.Extensions.dll')
$outputExecutable = Join-Path $outputDirectory $(if ($Tests) { 'Sozvon.ZoomTests.exe' } else { 'Sozvon.ZoomHost.exe' })
$compilerArgs = @('/nologo', '/codepage:65001', '/target:exe', '/optimize+', "/out:$outputExecutable")
foreach ($reference in $references) { $compilerArgs += '/reference:' + (Join-Path $frameworkPath $reference) }
foreach ($reference in @('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll')) { $compilerArgs += '/reference:' + (Join-Path $frameworkPath ('WPF/' + $reference)) }
$sources = @('Protocol.cs', 'Controller.cs', 'ZoomAutomation.cs', 'Program.cs')
if ($Tests) { $sources += 'NativeTests.cs'; $compilerArgs += '/main:Sozvon.NativeTests' }
foreach ($source in $sources) { $compilerArgs += Join-Path $PSScriptRoot $source }
& $compilerPath @compilerArgs
if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать помощник Zoom.' }
Write-Output $outputExecutable
