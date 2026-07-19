<#
.SYNOPSIS
  Installs the "local folder mode" file-manager Chrome Native Messaging Host
  for the current Windows user only (writes to HKCU).

.DESCRIPTION
  1. Rewrites com.pubmed_downloader.file_manager.json in this folder with the
     absolute path to python_file_manager.bat and the given extension ID.
  2. Writes a registry value under
     HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pubmed_downloader.file_manager
     pointing at that manifest file (this is how Chrome discovers native hosts).

.PARAMETER ExtensionId
  The extension ID shown on chrome://extensions after loading the extension
  (32 lowercase letters a-p). Required, because the manifest's allowed_origins
  must match this ID exactly or Chrome will refuse to talk to the native host.

.EXAMPLE
  .\install_file_manager.ps1 -ExtensionId abcdefghijklmnopqrstuvwxabcdefgh
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$hostDir      = $PSScriptRoot
$manifestPath = Join-Path $hostDir "com.pubmed_downloader.file_manager.json"
$batPath      = Join-Path $hostDir "python_file_manager.bat"

if (-not (Test-Path $batPath)) {
    throw "Cannot find $batPath - please check this folder's contents are complete."
}

$manifest = [ordered]@{
    name             = "com.pubmed_downloader.file_manager"
    description      = "PubMed PDF Downloader - local folder mode file manager"
    path             = $batPath
    type             = "stdio"
    allowed_origins  = @("chrome-extension://$ExtensionId/")
}

($manifest | ConvertTo-Json) | Set-Content -Path $manifestPath -Encoding utf8

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pubmed_downloader.file_manager"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestPath

Write-Host "Installed native messaging host: com.pubmed_downloader.file_manager"
Write-Host "  manifest:  $manifestPath"
Write-Host "  bat:       $batPath"
Write-Host "  extension: chrome-extension://$ExtensionId/"
Write-Host ""
Write-Host "To uninstall: Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pubmed_downloader.file_manager' -Force"
