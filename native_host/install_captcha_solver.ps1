<#
.SYNOPSIS
  Installs the "EZproxy re-login audio captcha solver" Chrome Native Messaging
  Host for the current Windows user only (writes to HKCU).

.DESCRIPTION
  1. Rewrites com.pubmed_downloader.captcha_solver.json in this folder with the
     absolute path to python_captcha_solver.bat and the given extension ID.
  2. Writes a registry value under
     HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pubmed_downloader.captcha_solver
     pointing at that manifest file (this is how Chrome discovers native hosts).

  This host is optional: it's only used to auto-solve the EZproxy login page's
  audio captcha when the batch download needs to re-login mid-run (the first
  login of any run is always typed in by hand). Without it installed, the
  extension just falls back to always prompting you to log in by hand, same
  as before this feature existed.

.PARAMETER ExtensionId
  The extension ID shown on chrome://extensions after loading the extension
  (32 lowercase letters a-p). Required, because the manifest's allowed_origins
  must match this ID exactly or Chrome will refuse to talk to the native host.

.EXAMPLE
  .\install_captcha_solver.ps1 -ExtensionId abcdefghijklmnopqrstuvwxabcdefgh
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$hostDir      = $PSScriptRoot
$manifestPath = Join-Path $hostDir "com.pubmed_downloader.captcha_solver.json"
$batPath      = Join-Path $hostDir "python_captcha_solver.bat"

if (-not (Test-Path $batPath)) {
    throw "Cannot find $batPath - please check this folder's contents are complete."
}

$manifest = [ordered]@{
    name             = "com.pubmed_downloader.captcha_solver"
    description      = "PubMed PDF Downloader - EZproxy re-login audio captcha solver"
    path             = $batPath
    type             = "stdio"
    allowed_origins  = @("chrome-extension://$ExtensionId/")
}

($manifest | ConvertTo-Json) | Set-Content -Path $manifestPath -Encoding utf8

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pubmed_downloader.captcha_solver"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestPath

Write-Host "Installed native messaging host: com.pubmed_downloader.captcha_solver"
Write-Host "  manifest:  $manifestPath"
Write-Host "  bat:       $batPath"
Write-Host "  extension: chrome-extension://$ExtensionId/"
Write-Host ""
Write-Host "Reminder: this host needs the openai-whisper package (pulls in torch, a few"
Write-Host "hundred MB) on top of what the other native hosts need. All of it is listed in"
Write-Host "requirements.txt in this folder - run 'pip install -r requirements.txt' once"
Write-Host "(一鍵安裝.bat already does this step for you automatically) before relying on"
Write-Host "auto re-login."
Write-Host ""
Write-Host "To uninstall: Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pubmed_downloader.captcha_solver' -Force"
