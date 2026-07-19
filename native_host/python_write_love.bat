@echo off
rem Chrome Native Messaging Host 的進入點。Chrome 會把這個 .bat 當成
rem native host 的 "path" 直接執行（Windows 上 Chrome 支援 .bat 當 native host），
rem 這裡只是薄薄一層轉呼叫同資料夾的 python_write_love.py。
setlocal
where python >nul 2>nul
if %errorlevel%==0 (
    python "%~dp0python_write_love.py"
    exit /b %errorlevel%
)
where py >nul 2>nul
if %errorlevel%==0 (
    py "%~dp0python_write_love.py"
    exit /b %errorlevel%
)
exit /b 1
