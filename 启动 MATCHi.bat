@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0.venv\Scripts\pythonw.exe" (
    echo 尚未安装运行环境，请先双击 install.bat。
    pause
    exit /b 1
)

start "MATCHi 场地抢订" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0gui\launcher.pyw"
exit /b 0
