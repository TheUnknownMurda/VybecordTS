@echo off
npm rebuild better-sqlite3 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Failed to rebuild better-sqlite3.
    echo Make sure you have Python and Visual Studio Build Tools installed.
    echo You can install them from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    pause
)
