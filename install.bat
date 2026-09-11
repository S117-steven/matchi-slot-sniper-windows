@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 (
    echo.
    echo 安装没有完成。请查看上面的错误信息，然后重试。
    pause
    exit /b 1
)

echo.
echo 安装完成。桌面上已经创建 MATCHi 场地抢订 快捷方式。
pause
exit /b 0
