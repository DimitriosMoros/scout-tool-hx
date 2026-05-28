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

cd /d "%~dp0"

echo  Checking for updates...
echo.

node updater.js

echo.
echo  Server stopped. Press any key to close.
pause >nul