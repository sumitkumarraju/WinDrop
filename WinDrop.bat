@echo off
title WinDrop
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo WinDrop needs Node.js. Download it from https://nodejs.org and run this again.
    pause
    exit /b
)
node server.js
pause
