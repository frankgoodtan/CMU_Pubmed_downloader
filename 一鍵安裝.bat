@echo off
rem Double-click this file to: install every Python package the native hosts
rem need (see native_host\requirements.txt), then auto-compute this
rem extension's Chrome ID from manifest.json and register all three Native
rem Messaging Hosts (write_love + file_manager + captcha_solver). No need to
rem copy the ID from chrome://extensions by hand, and no need to run pip
rem install yourself.
rem
rem This file is intentionally kept plain-ASCII-only (no Chinese/wide
rem characters, not even in comments): cmd.exe parses a .bat file's bytes
rem using whatever codepage is active at the moment it reads each line, and
rem a `chcp 65001` earlier in the same script does not reliably apply to
rem lines cmd.exe has already buffered - on some Windows builds/locales this
rem can garble non-ASCII bytes in later REM/echo lines badly enough that
rem cmd.exe misparses part of a comment as a command (symptom seen before
rem this fix: a garbled "'Host...write_love' is not recognized as an
rem internal or external command" error appearing before the real install
rem steps ran). Keeping this launcher pure ASCII removes that whole failure
rem mode; all the actual user-facing Chinese text lives in setup.ps1 instead,
rem where PowerShell's own encoding-aware script parser is not affected by
rem this cmd.exe quirk.
setlocal
cd /d "%~dp0native_host"

echo ============================================================
echo Step 1/2: Installing Python packages
echo (opencv-python / mss / numpy / openai-whisper)
echo First install downloads torch (a dependency of openai-whisper),
echo which is a few hundred MB - please be patient, do not close this window.
echo ============================================================
where python >nul 2>nul
if %errorlevel%==0 (
    python -m pip install -r requirements.txt
    goto :pip_done
)
where py >nul 2>nul
if %errorlevel%==0 (
    py -m pip install -r requirements.txt
    goto :pip_done
)
echo Could not find a "python" or "py" command. Please install Python
echo (make sure to check "Add python.exe to PATH" during setup), then
echo double-click this file again.
pause
exit /b 1

:pip_done
echo.
echo ============================================================
echo Step 2/2: Registering Native Messaging Hosts
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native_host\setup.ps1"
echo.
pause
