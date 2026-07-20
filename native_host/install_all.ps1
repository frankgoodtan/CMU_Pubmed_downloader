<#
.SYNOPSIS
  Installs every Chrome Native Messaging Host this extension uses, in one
  command, for the current Windows user only (writes to HKCU).

.DESCRIPTION
  Registers all hosts below by rewriting each one's manifest JSON with the
  absolute path to its .bat launcher and the given extension ID, then writing
  a registry value under
    HKCU:\Software\Google\Chrome\NativeMessagingHosts\<host name>
  pointing at that manifest (this is how Chrome discovers native hosts):

    - com.pubmed_downloader.write_love    (畫愛心人機驗證提醒 / python_write_love.py)
    - com.pubmed_downloader.file_manager  (本地資料夾模式讀寫 + debug log 留痕 / python_file_manager.py)

  Equivalent to running install_write_love.ps1 and install_file_manager.ps1
  separately with the same -ExtensionId; kept as thin wrappers so either can
  still be run standalone if you only need to (re)install one host.

.PARAMETER ExtensionId
  The extension ID shown on chrome://extensions after loading the extension
  (32 lowercase letters a-p). Required, because each manifest's
  allowed_origins must match this ID exactly or Chrome will refuse to talk
  to the native host.

.EXAMPLE
  .\install_all.ps1 -ExtensionId abcdefghijklmnopqrstuvwxabcdefgh
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$hostDir = $PSScriptRoot

function Install-NativeHost {
    param(
        [string]$Name,
        [string]$Description,
        [string]$BatFileName
    )

    $manifestPath = Join-Path $hostDir "$Name.json"
    $batPath      = Join-Path $hostDir $BatFileName

    if (-not (Test-Path $batPath)) {
        throw "Cannot find $batPath - please check this folder's contents are complete."
    }

    $manifest = [ordered]@{
        name             = $Name
        description      = $Description
        path             = $batPath
        type             = "stdio"
        allowed_origins  = @("chrome-extension://$ExtensionId/")
    }

    ($manifest | ConvertTo-Json) | Set-Content -Path $manifestPath -Encoding utf8

    $regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$Name"
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestPath

    Write-Host "Installed native messaging host: $Name"
    Write-Host "  manifest:  $manifestPath"
    Write-Host "  bat:       $batPath"
    Write-Host "  extension: chrome-extension://$ExtensionId/"
    Write-Host ""
}

Install-NativeHost -Name "com.pubmed_downloader.write_love" `
    -Description "PubMed PDF Downloader - draw a heart when manual verification is detected" `
    -BatFileName "python_write_love.bat"

Install-NativeHost -Name "com.pubmed_downloader.file_manager" `
    -Description "PubMed PDF Downloader - local folder mode file manager" `
    -BatFileName "python_file_manager.bat"

Write-Host "All native messaging hosts installed for extension chrome-extension://$ExtensionId/"
Write-Host ""
Write-Host "To uninstall everything:"
Write-Host "  Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pubmed_downloader.write_love' -Force"
Write-Host "  Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pubmed_downloader.file_manager' -Force"
