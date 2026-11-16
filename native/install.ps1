param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)
$ErrorActionPreference = 'Stop'
$executablePath = Join-Path $PSScriptRoot 'bin/Sozvon.ZoomHost.exe'
if (-not (Test-Path -LiteralPath $executablePath)) { & (Join-Path $PSScriptRoot 'build.ps1') }
$executablePath = (Resolve-Path -LiteralPath $executablePath).Path
$manifestPath = Join-Path $PSScriptRoot 'bin/com.sozvon.zoom.json'
$manifest = @{
  name = 'com.sozvon.zoom'
  description = 'Созвон — управление Zoom для Windows'
  path = $executablePath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sozvon.zoom'
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Output "Помощник зарегистрирован для расширения $ExtensionId. Обновите расширение и нажмите «Проверить помощник»."
