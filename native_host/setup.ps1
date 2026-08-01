<#
.SYNOPSIS
  One-click setup: computes this extension's Chrome extension ID directly
  from manifest.json (no need to load the extension in Chrome first just to
  copy the ID), then installs every Native Messaging Host this extension
  uses, for the current Windows user only (writes to HKCU).

.DESCRIPTION
  manifest.json in the parent folder pins a fixed "key" (the extension's
  public key), which is why this extension's ID is the same on every
  computer that loads it — Chrome derives the ID deterministically from
  that key:
      id = first 16 bytes of SHA-256(DER-decoded key), each byte's two
           nibbles mapped to letters a-p
  That means the ID can be computed offline, without ever starting Chrome.
  This script does exactly that, then reuses the same registration logic
  as install_all.ps1 to install:
    - com.pubmed_downloader.write_love      (畫愛心人機驗證提醒)
    - com.pubmed_downloader.file_manager    (本地資料夾模式讀寫 + debug log 留痕)
    - com.pubmed_downloader.captcha_solver  (EZproxy 重登語音驗證碼辨識，選用)

  What this script does NOT do (and deliberately can't): silently load the
  unpacked extension into Chrome. Chrome requires an explicit, visible user
  action (Developer mode -> Load unpacked) before it will run unpacked
  extension code at all — that's a security boundary by design, not a gap
  in this script. You still do that one step yourself, once per browser
  profile; this script prints the reminder at the end and can optionally
  open chrome://extensions for you.

.PARAMETER ExtensionId
  Optional override. If omitted, the ID is computed from manifest.json's
  "key" field. Only pass this if you're intentionally installing for a
  different/unsigned build that doesn't carry the same key.

.PARAMETER SkipOpenChrome
  If set, does not attempt to open chrome://extensions at the end.

.EXAMPLE
  .\setup.ps1
#>
param(
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [switch]$SkipOpenChrome
)

$ErrorActionPreference = "Stop"
$hostDir      = $PSScriptRoot
$manifestPath = Join-Path (Split-Path $hostDir -Parent) "manifest.json"

function Get-ChromeExtensionIdFromKey {
    param([string]$Base64Key)
    $derBytes = [Convert]::FromBase64String($Base64Key)
    $sha256   = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($derBytes)
    } finally {
        $sha256.Dispose()
    }
    $first16 = $hash[0..15]
    -join ($first16 | ForEach-Object {
        $hi = ($_ -shr 4) -band 0xF
        $lo = $_ -band 0xF
        [string]([char]([int][char]'a' + $hi)) + [string]([char]([int][char]'a' + $lo))
    })
}

function Install-NativeHost {
    param(
        [string]$Name,
        [string]$Description,
        [string]$BatFileName,
        [string]$ResolvedExtensionId
    )

    $manifestOut = Join-Path $hostDir "$Name.json"
    $batPath     = Join-Path $hostDir $BatFileName

    if (-not (Test-Path $batPath)) {
        throw "Cannot find $batPath - please check this folder's contents are complete."
    }

    $manifest = [ordered]@{
        name             = $Name
        description      = $Description
        path             = $batPath
        type             = "stdio"
        allowed_origins  = @("chrome-extension://$ResolvedExtensionId/")
    }

    ($manifest | ConvertTo-Json) | Set-Content -Path $manifestOut -Encoding utf8

    $regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$Name"
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestOut

    Write-Host "Installed native messaging host: $Name"
    Write-Host "  manifest:  $manifestOut"
    Write-Host "  bat:       $batPath"
    Write-Host ""
}

if (-not $ExtensionId) {
    if (-not (Test-Path $manifestPath)) {
        throw "Cannot find $manifestPath - run this from inside the native_host folder of the extension."
    }
    $extManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if (-not $extManifest.key) {
        throw "manifest.json has no 'key' field, so the extension ID can't be computed offline. " +
              "Load the extension in Chrome, copy the ID from chrome://extensions, and re-run with -ExtensionId <id>."
    }
    $ExtensionId = Get-ChromeExtensionIdFromKey -Base64Key $extManifest.key
    Write-Host "Computed extension ID from manifest.json's pinned key: $ExtensionId"
    Write-Host ""
}

Install-NativeHost -Name "com.pubmed_downloader.write_love" `
    -Description "PubMed PDF Downloader - draw a heart when manual verification is detected" `
    -BatFileName "python_write_love.bat" `
    -ResolvedExtensionId $ExtensionId

Install-NativeHost -Name "com.pubmed_downloader.file_manager" `
    -Description "PubMed PDF Downloader - local folder mode file manager" `
    -BatFileName "python_file_manager.bat" `
    -ResolvedExtensionId $ExtensionId

Install-NativeHost -Name "com.pubmed_downloader.captcha_solver" `
    -Description "PubMed PDF Downloader - EZproxy re-login audio captcha solver" `
    -BatFileName "python_captcha_solver.bat" `
    -ResolvedExtensionId $ExtensionId

Write-Host "All native messaging hosts installed for extension chrome-extension://$ExtensionId/"
Write-Host ""
Write-Host "Note: this only registers the native hosts. All Python packages they need"
Write-Host "(including openai-whisper/torch for com.pubmed_downloader.captcha_solver)"
Write-Host "are listed in requirements.txt in this folder - run"
Write-Host "'pip install -r requirements.txt' once (一鍵安裝.bat does this automatically)."
Write-Host ""
Write-Host "Remaining manual step (Chrome requires this be done by hand, once per browser profile):"
Write-Host "  1. Open chrome://extensions"
Write-Host "  2. Turn on 'Developer mode' (top right)"
Write-Host "  3. Click 'Load unpacked' and select this extension's folder (the one containing manifest.json)"
Write-Host "  4. If the extension was already loaded, click its reload icon so it picks up the latest code"
Write-Host ""

if (-not $SkipOpenChrome) {
    try {
        Start-Process "chrome://extensions/"
    } catch {
        # 找不到預設瀏覽器或使用者環境不支援 Start-Process 開網址時靜默略過，
        # 不影響上面已經完成的 native host 安裝結果
    }
}
