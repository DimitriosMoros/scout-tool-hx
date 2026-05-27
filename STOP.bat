@echo off
title Competitor Scout - Stop
color 0C

echo.
echo  =============================================
echo    Competitor Scout - Stopping server
echo  =============================================
echo.

:: Kill process on port 3001
echo  Stopping server on port 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| find "3001" ^| find "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Also kill any node processes running index.js
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list ^| find "PID"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo  Server stopped.
echo.
timeout /t 2 >nul