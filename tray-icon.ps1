# VybecordTS System Tray Icon - Standalone script
# This script creates a system tray icon for an already running VybecordTS process

Add-Type -AssemblyName System.Windows.Forms

# Get the directory of this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Create the system tray icon
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon

# Use default system icon
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

# Show Console menu item
$showConsole = New-Object System.Windows.Forms.ToolStripMenuItem
$showConsole.Text = "Show Console"
$showConsole.Add_Click({
    $flagFile = "$scriptDir\show-console.flag"
    New-Item -Path $flagFile -ItemType File -Force | Out-Null
})
$contextMenu.Items.Add($showConsole)

# Hide Console menu item
$hideConsole = New-Object System.Windows.Forms.ToolStripMenuItem
$hideConsole.Text = "Hide Console"
$hideConsole.Add_Click({
    $flagFile = "$scriptDir\hide-console.flag"
    New-Item -Path $flagFile -ItemType File -Force | Out-Null
})
$contextMenu.Items.Add($hideConsole)

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

# Keep tray icon running - check if Node.js process is alive
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    $nodeProcesses = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*index.js*" }
    if (-not $nodeProcesses) {
        $notifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

# Application message loop
[System.Windows.Forms.Application]::Run()

# Cleanup
$notifyIcon.Dispose()
