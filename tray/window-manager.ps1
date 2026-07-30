# Window Manager - Automatically hide console when minimized (like EA/Ubisoft apps)
Add-Type -Name Window -Namespace Console -MemberDefinition '
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();
  
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_APPWINDOW = 0x00040000;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int SW_HIDE = 0;
  public const int SW_SHOW = 5;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_FRAMECHANGED = 0x0020;
'

# Wait for console to start
Start-Sleep -Seconds 2

$consoleWindow = [Console.Window]::GetConsoleWindow()
if ($consoleWindow -eq [IntPtr]::Zero) {
    Write-Host "No console window found"
    exit 1
}

# Store original style
$originalExStyle = [Console.Window]::GetWindowLong($consoleWindow, [Console.Window]::GWL_EXSTYLE)
$isHidden = $false

Write-Host "Monitoring console window for minimization..."

# Monitor loop - automatically hide when minimized
while ($true) {
    try {
        # Check if window is minimized
        if ([Console.Window]::IsIconic($consoleWindow)) {
            if (-not $isHidden) {
                # Remove WS_EX_APPWINDOW, add WS_EX_TOOLWINDOW
                $newExStyle = $originalExStyle -band (-bnot [Console.Window]::WS_EX_APPWINDOW)
                $newExStyle = $newExStyle -bor [Console.Window]::WS_EX_TOOLWINDOW
                
                [Console.Window]::SetWindowLong($consoleWindow, [Console.Window]::GWL_EXSTYLE, $newExStyle)
                [Console.Window]::SetWindowPos($consoleWindow, 0, 0, 0, 0, 0, 
                    [Console.Window]::SWP_NOMOVE -bor [Console.Window]::SWP_NOSIZE -bor 
                    [Console.Window]::SWP_NOZORDER -bor [Console.Window]::SWP_FRAMECHANGED)
                [Console.Window]::ShowWindow($consoleWindow, [Console.Window]::SW_HIDE)
                
                $isHidden = $true
                Write-Host "Console minimized and hidden from taskbar"
            }
        }
        
        # Check if node process is still running
        $nodeProcess = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*index.js*" }
        if (-not $nodeProcess) {
            Write-Host "Node process ended, exiting monitor"
            break
        }
        
        Start-Sleep -Milliseconds 500
    } catch {
        Write-Host "Error: $_"
        Start-Sleep -Seconds 1
    }
}
