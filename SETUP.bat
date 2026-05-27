@echo off
title Competitor Scout - First Time Setup
color 0B

echo.
echo  =============================================
echo    Competitor Scout - First Time Setup
echo  =============================================
echo.
echo  This will install all required dependencies.
echo  This only needs to be run once.
echo.

:: Go to the project root
cd /d "%~dp0"

:: Check Node.js is installed
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  ERROR: Node.js is not installed!
    echo.
    echo  Please install Node.js from: https://nodejs.org
    echo  Download the LTS version, install it, then run SETUP.bat again.
    echo.
    pause
    exit /b 1
)

echo  Node.js found:
node --version

:: Install root dependencies
echo.
echo  Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR: npm install failed. Check your internet connection.
    pause
    exit /b 1
)

:: Install backend dependencies if backend has its own package.json
if exist "backend\package.json" (
    echo.
    echo  Installing backend dependencies...
    cd backend
    call npm install
    cd ..
)

:: Check if .env exists
if not exist "backend\.env" (
    echo.
    echo  =============================================
    echo    IMPORTANT: Configure your credentials
    echo  =============================================
    echo.
    echo  No .env file found in backend folder.
    echo  Please create backend\.env with your Shopify credentials.
    echo.
    echo  Required variables:
    echo    SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
    echo    SHOPIFY_ACCESS_TOKEN=shpss_...
    echo    SHOPIFY_CLIENT_ID=...
    echo    SHOPIFY_CLIENT_SECRET=...
    echo    PORT=3001
    echo.
)

echo.
echo  =============================================
echo    Setup complete! You can now run START.bat
echo  =============================================
echo.
pause