@echo off
title Competitor Scout - Highside
color 0A

echo.
echo  =============================================
echo    Competitor Scout by Highside
echo  =============================================
echo.
echo  Starting server...
echo  Browser will open automatically.
echo.
echo  To STOP the server:
echo    - Use the "Shut down" button in the app, OR
echo    - Close this window
echo.

:: Go to the project root
cd /d "%~dp0"

:: Check for and apply updates before launching
echo  Checking for updates...
node updater.js
if %ERRORLEVEL% NEQ 0 (
    echo  Update check failed - starting anyway...
)

:: Kill anything on port 3001 first
for /f "tokens=5" %%a in ('netstat -aon ^| find "3001" ^| find "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Start the app
echo  Launching app...
npm run start

:: If it exits, pause so user can see any error
echo.
echo  Server stopped. Press any key to close.
pause >nul