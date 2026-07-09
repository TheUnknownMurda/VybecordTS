@echo off
echo ========================================
echo VybecordTS - Installation Script
echo ========================================
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js (version 20 or higher) from: https://nodejs.org/
    pause
    exit /b 1
)

:: Check Node.js version
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo [OK] Node.js version: %NODE_VERSION%

:: Check if npm is installed
where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm is not installed or not in PATH.
    pause
    exit /b 1
)

echo [OK] npm is available
echo.

:: Install npm dependencies
echo [1/3] Installing npm dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install npm dependencies.
    pause
    exit /b 1
)
echo [OK] Dependencies installed successfully
echo.

:: Rebuild better-sqlite3 (native module)
echo [2/3] Rebuilding better-sqlite3 (native module)...
call npm rebuild better-sqlite3
if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] Failed to rebuild better-sqlite3.
    echo Make sure you have Python and Visual Studio Build Tools installed.
    echo You can install them from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo The application may still work, but you might encounter issues.
) else (
    echo [OK] better-sqlite3 rebuilt successfully
)
echo.

:: Create .env file if it doesn't exist
echo [3/3] Setting up environment configuration...
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [OK] Created .env file from .env.example
        echo.
        echo [IMPORTANT] Please edit .env file and add your credentials:
        echo   - SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (from https://developer.spotify.com/dashboard)
        echo   - DISCORD_CLIENT_ID (from https://discord.com/developers/applications)
    ) else (
        echo [WARNING] .env.example not found. Please create .env file manually.
    )
) else (
    echo [OK] .env file already exists
)
echo.

echo ========================================
echo Installation completed successfully!
echo ========================================
echo.
echo Next steps:
echo 1. Edit .env file with your credentials (if not done already)
echo 2. Run 'npm run dev' to start the application in development mode
echo 3. Or run 'npm run build' followed by 'npm start' for production
echo.
pause
