# System Tray Icon - Similar to pystray implementation
Add-Type -AssemblyName System.Windows.Forms

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$flagFile = "$scriptDir\window-flag.txt"

# Create the system tray icon
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$notifyIcon.Text = "VybecordTS - Discord Rich Presence"
$notifyIcon.Visible = $true

# Create context menu
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# Show menu item
$showItem = New-Object System.Windows.Forms.ToolStripMenuItem
$showItem.Text = "Show"
$showItem.Add_Click({
    "show" | Out-File -FilePath $flagFile -Encoding ASCII
})
$contextMenu.Items.Add($showItem)

# Hide menu item
$hideItem = New-Object System.Windows.Forms.ToolStripMenuItem
$hideItem.Text = "Hide"
$hideItem.Add_Click({
    "hide" | Out-File -FilePath $flagFile -Encoding ASCII
})
$contextMenu.Items.Add($hideItem)

# Separator
$contextMenu.Items.Add("-")

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

# Left-click to toggle show/hide
$notifyIcon.Add_Click({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        # Check current window state and toggle
        $consoleWindow = (Add-Type -Name Window -Namespace Console -MemberDefinition '
          [DllImport("kernel32.dll")]
          public static extern IntPtr GetConsoleWindow();
        ' -PassThru)::GetConsoleWindow()
        
        $isVisible = [Console.Window]::IsWindowVisible($consoleWindow)
        
        if ($isVisible) {
            "hide" | Out-File -FilePath $flagFile -Encoding ASCII
        } else {
            "show" | Out-File -FilePath $flagFile -Encoding ASCII
        }
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
