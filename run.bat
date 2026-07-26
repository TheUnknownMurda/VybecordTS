@echo off
REM VybecordTS Launcher - Starts the app with minimize-to-tray behavior
REM This batch file starts the window manager and main application

REM Start the window manager in background (hides console when minimized)
start powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0window-manager.ps1"

REM Start the main application
npx tsx src/index.ts