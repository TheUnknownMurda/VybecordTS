# Minimal test script for system tray icon
Add-Type -AssemblyName System.Windows.Forms

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$notifyIcon.Text = "Test Tray Icon"
$notifyIcon.Visible = $true

# Show balloon tip immediately
$notifyIcon.ShowBalloonTip(5000, "Test", "Tray icon is visible!", [System.Windows.Forms.ToolTipIcon]::Info)

# Keep it running for 10 seconds then exit
Start-Sleep -Seconds 10
$notifyIcon.Visible = $false
