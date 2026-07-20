@echo off
chcp 65001 >nul
rem 雙擊這個檔案即可：自動從 manifest.json 算出擴充功能 ID，並裝好全部
rem Native Messaging Host（write_love + file_manager）。不需要先手動去
rem chrome://extensions 複製 ID。
cd /d "%~dp0native_host"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native_host\setup.ps1"
echo.
pause
