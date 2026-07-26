# Console Window Monitor - Detects when console is minimized and hides it
# This script runs in the background and monitors the console window state

Add-Type -Name Window -Namespace Console -MemberDefinition '
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
  [DllImport("user32.dll")]
  public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  
  public struct WINDOWPLACEMENT {
    public uint length;
    public uint flags;
    public uint showCmd;
    public System.Drawing.Point ptMinPosition;
    public System.Drawing.Point ptMaxPosition;
    public System.Drawing.Rectangle rcNormalPosition;
  }
  
  public const uint SW_HIDE = 0;
  public const uint SW_SHOWMINIMIZED = 2;
  public const uint SW_RESTORE = 9;
  public const uint SW_SHOW = 5;
'

# Get the directory of this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Flag file to signal console should be shown
$showConsoleFlag = "$scriptDir\show-console.flag"

# Wait a bit for the console to start
Start-Sleep -Seconds 2

# Get console window handle
$consoleWindow = [Console.Window]::GetConsoleWindow()

if ($consoleWindow -eq [IntPtr]::Zero) {
    Write-Host "Could not find console window"
    exit 1
}

# Track previous window state
$previousState = 0

# Monitor loop
while ($true) {
    try {
        # Get current window placement
        $placement = New-Object Console.Window+WINDOWPLACEMENT
        $placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf($placement)
        
        if ([Console.Window]::GetWindowPlacement($consoleWindow, [ref]$placement)) {
            $currentState = $placement.showCmd
            
            # Check if window was just minimized (SW_SHOWMINIMIZED = 2)
            if ($currentState -eq 2 -and $previousState -ne 2) {
                # Hide the console window completely
                [Console.Window]::ShowWindow($consoleWindow, [Console.Window]::SW_HIDE)
                Write-Host "Console minimized to tray"
            }
            
            # Check if we should show the console (flag file exists)
            if (Test-Path $showConsoleFlag) {
                try {
                    Remove-Item $showConsoleFlag -Force
                    [Console.Window]::ShowWindow($consoleWindow, [Console.Window]::SW_RESTORE)
                    [Console.Window]::SetForegroundWindow($consoleWindow)
                    Write-Host "Console restored from tray"
                } catch {
                    Write-Host "Could not restore console: $_"
                }
            }
            
            $previousState = $currentState
        }
        
        # Check if console process is still running
        $nodeProcess = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*index.js*" }
        if (-not $nodeProcess) {
            Write-Host "Console process ended, exiting monitor"
            break
        }
        
    } catch {
        Write-Host "Error monitoring console: $_"
    }
    
    # Check every 500ms
    Start-Sleep -Milliseconds 500
}
