# VybecordTS Simple Tray Script
# This script creates a basic system tray icon

Add-Type -AssemblyName System.Windows.Forms

# Create the system tray icon
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$notifyIcon.Text = "VybecordTS - Discord Rich Presence"
$notifyIcon.Visible = $true

# Create context menu
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# Open Dashboard menu item
$openDashboard = New-Object System.Windows.Forms.ToolStripMenuItem
$openDashboard.Text = "Open Dashboard"
$openDashboard.Add_Click({
    Start-Process "http://127.0.0.1:8888"
})
$contextMenu.Items.Add($openDashboard)

# Separator
$contextMenu.Items.Add("-")

# Exit menu item
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Exit"
$exitItem.Add_Click({
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*index.js*" } | Stop-Process -Force
})
$contextMenu.Items.Add($exitItem)

$notifyIcon.ContextMenuStrip = $contextMenu

# Left-click to open dashboard
$notifyIcon.Add_Click({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process "http://127.0.0.1:8888"
    }
})

# Show balloon tip after short delay
$timerBalloon = New-Object System.Windows.Forms.Timer
$timerBalloon.Interval = 1000
$timerBalloon.Add_Tick({
    $notifyIcon.ShowBalloonTip(3000, "VybecordTS", "Running in background", [System.Windows.Forms.ToolTipIcon]::Info)
    $timerBalloon.Stop()
})
$timerBalloon.Start()

# Monitor if Node.js process is still running
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    $nodeProcess = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*index.js*" }
    if (-not $nodeProcess) {
        $notifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

# Application message loop
[System.Windows.Forms.Application]::Run()

# Cleanup
$notifyIcon.Dispose()
