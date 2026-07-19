@echo off
setlocal

cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  set "PY_CMD=py"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    set "PY_CMD=python"
  ) else (
    echo Python was not found.
    echo Please install Python or add it to PATH, then run this file again.
    pause
    exit /b 1
  )
)

%PY_CMD% .\checkbox_trajectory_collector.py
