# Simple tray icon test
Add-Type -AssemblyName System.Windows.Forms

$form = New-Object System.Windows.Forms.Form
$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$form.ShowInTaskbar = $false
$form.Opacity = 0

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$notifyIcon.Text = "Test Tray Icon"
$notifyIcon.Visible = $true

$notifyIcon.ShowBalloonTip(5000, "Test", "Tray icon should be visible now!", [System.Windows.Forms.ToolTipIcon]::Info)

Start-Sleep -Seconds 10
$notifyIcon.Visible = $false
