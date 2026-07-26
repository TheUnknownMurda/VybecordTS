# VybecordTS Launcher - Starts the app with system tray icon
# This script hides the console and shows only a system tray icon

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Get the directory of this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Determine the executable to run
if (Test-Path "$scriptDir\dist\index.js") {
    $exePath = "node"
    $exeArgs = "`"$scriptDir\dist\index.js`""
} elseif (Test-Path "$scriptDir\build\VybecordTS\VybecordTS.exe") {
    $exePath = "$scriptDir\build\VybecordTS\VybecordTS.exe"
    $exeArgs = ""
} else {
    Write-Host "Error: Could not find VybecordTS executable"
    exit 1
}

# Create the system tray icon FIRST
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon

# Try to load the VybecordTS logo from URL and convert to icon
try {
    $logoUrl = "https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/T13Beb2q34Er50o2JrKn2.gif"
    $webClient = New-Object System.Net.WebClient
    $imageBytes = $webClient.DownloadData($logoUrl)
    $stream = New-Object System.IO.MemoryStream($imageBytes)
    $image = [System.Drawing.Image]::FromStream($stream)
    
    # Convert image to icon (using a simple approach)
    $bitmap = New-Object System.Drawing.Bitmap($image)
    $iconHandle = $bitmap.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
    $notifyIcon.Icon = $icon
    
    # Cleanup
    $stream.Dispose()
    $image.Dispose()
    $bitmap.Dispose()
} catch {
    # Fallback to default system icon if loading fails
    Write-Host "Could not load logo from URL, using default icon"
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
}

$notifyIcon.Text = "VybecordTS - Discord Rich Presence"
$notifyIcon.Visible = $true

# Create context menu BEFORE starting the app
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
    # Create a flag file to signal the Node.js process to show its console
    $flagFile = "$scriptDir\show-console.flag"
    try {
        New-Item -Path $flagFile -ItemType File -Force | Out-Null
    } catch {
        Write-Host "Could not create flag file: $_"
    }
})
$contextMenu.Items.Add($showConsole)

# Hide Console menu item
$hideConsole = New-Object System.Windows.Forms.ToolStripMenuItem
$hideConsole.Text = "Hide Console"
$hideConsole.Add_Click({
    # Create a flag file to signal the Node.js process to hide its console
    $flagFile = "$scriptDir\hide-console.flag"
    try {
        New-Item -Path $flagFile -ItemType File -Force | Out-Null
    } catch {
        Write-Host "Could not create flag file: $_"
    }
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
    # Kill the node process
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*VybecordTS*" } | Stop-Process -Force
})
$contextMenu.Items.Add($exitItem)

$notifyIcon.ContextMenuStrip = $contextMenu

# Left-click to open dashboard
$notifyIcon.Add_Click({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process "http://127.0.0.1:8888"
    }
})

# Start the application in background with tray mode environment variable
$env:VYBECORD_TRAY_MODE = "1"
$process = Start-Process -FilePath $exePath -ArgumentList $exeArgs -WindowStyle Hidden -PassThru

# Show balloon tip after a short delay to ensure icon is visible
$timerBalloon = New-Object System.Windows.Forms.Timer
$timerBalloon.Interval = 500
$timerBalloon.Add_Tick({
    $notifyIcon.ShowBalloonTip(3000, "VybecordTS", "Running in background. Click icon to open dashboard.", [System.Windows.Forms.ToolTipIcon]::Info)
    $timerBalloon.Stop()
})
$timerBalloon.Start()

# Keep the tray icon running
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    # Check if the main process is still running
    if ($process -and $process.HasExited) {
        $notifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

# Application message loop - this keeps the icon visible
[System.Windows.Forms.Application]::Run()

# Cleanup on exit
$notifyIcon.Dispose()
