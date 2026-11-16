$ErrorActionPreference = 'Stop'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sozvon.zoom'
$ownManifestPath = Join-Path $PSScriptRoot 'bin/com.sozvon.zoom.json'
if (Test-Path -LiteralPath $registryPath) {
  $current = (Get-Item -LiteralPath $registryPath).GetValue('')
  if ($current -ne $ownManifestPath) { throw 'Этот помощник зарегистрирован из другой папки. Удаление отменено.' }
  Remove-Item -LiteralPath $registryPath
}
Write-Output 'Регистрация помощника удалена. Файлы и Zoom сохранены.'
