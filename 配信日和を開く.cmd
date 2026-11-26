@echo off
setlocal
chcp 65001 >nul
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 24.5 以降をインストールしてから、もう一度開いてください。
    pause
    exit /b 1
)
node "%~dp0scripts\open-codespace.mjs" %*
set "launch_status=%errorlevel%"
if not "%launch_status%"=="0" pause
exit /b %launch_status%
