@echo off
REM VybecordTS Launcher - Starts the app with system tray icon
REM This batch file runs the PowerShell script that hides the console

set VYBECORD_TRAY_MODE=1
powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0start-hidden.ps1"
