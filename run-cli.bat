@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo 找不到 Node.js，请先双击 install.bat。
    pause
    exit /b 1
)

node "%~dp0src\cli.mjs" %*
exit /b %errorlevel%
