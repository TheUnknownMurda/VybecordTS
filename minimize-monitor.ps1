# Console Minimize Monitor - Hides console when minimized
Add-Type -Name Window -Namespace Console -MemberDefinition '
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetConsoleWindow();
'

$consoleWindow = [Console.Window]::GetConsoleWindow()
if ($consoleWindow -eq [IntPtr]::Zero) {
    Write-Host "No console window found"
    exit 1
}

Write-Host "Monitoring console window for minimization..."

while ($true) {
    try {
        if ([Console.Window]::IsIconic($consoleWindow)) {
            [Console.Window]::ShowWindow($consoleWindow, 0) # SW_HIDE
            Write-Host "Console minimized and hidden"
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
