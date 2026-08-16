# VybecordTS — System tray icon (WinForms NotifyIcon).
#
# Long-running helper, same contract as smtc-reader.ps1:
#   stdout — one JSON line per event:   {"ready":true} / {"cmd":"dashboard"}
#   stdin  — one JSON line per command: {"tooltip":"..."} / {"exit":true}
#
# Closing stdin is the normal shutdown signal: the loop below exits and
# disposes the icon, so Windows doesn't leave a ghost in the notification area.
#
# Note: this script deliberately does NOT hide the console window. Doing that
# requires a user32!ShowWindow P/Invoke, which is a well-known antivirus
# heuristic — not worth the false positives for a cosmetic feature.

param(
    [string]$IconPath = '',
    [string]$FallbackExe = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── Menu labels (kept together so they're easy to translate) ──
$L_DASHBOARD     = 'Open dashboard'
$L_SETUP         = 'Setup page'
$L_QUIT          = 'Quit VybecordTS'
$TOOLTIP_DEFAULT = 'VybecordTS'

# NotifyIcon.Text throws above 63 characters.
$TOOLTIP_MAX = 63

function Send-Event([string]$json) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

# Bundled .ico first, then the icon baked into the exe, then a generic one —
# a missing icon must never be the reason the tray fails to appear.
function Resolve-TrayIcon {
    if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
        try { return New-Object System.Drawing.Icon($IconPath) } catch { }
    }
    if ($FallbackExe -and (Test-Path -LiteralPath $FallbackExe)) {
        try { return [System.Drawing.Icon]::ExtractAssociatedIcon($FallbackExe) } catch { }
    }
    return [System.Drawing.SystemIcons]::Application
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = Resolve-TrayIcon
$notify.Text = $TOOLTIP_DEFAULT
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemDashboard = $menu.Items.Add($L_DASHBOARD)
$itemDashboard.add_Click({ Send-Event '{"cmd":"dashboard"}' })

$itemSetup = $menu.Items.Add($L_SETUP)
$itemSetup.add_Click({ Send-Event '{"cmd":"setup"}' })

$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemQuit = $menu.Items.Add($L_QUIT)
$itemQuit.add_Click({ Send-Event '{"cmd":"quit"}' })

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Send-Event '{"cmd":"dashboard"}' })

Send-Event '{"ready":true}'

# ── Message pump ──
# Application::Run() would block forever with no way to read stdin, so drive
# the loop manually and poll the pending async read on each tick. 100 ms keeps
# the menu responsive while staying invisible in CPU usage.
$stdin = [Console]::In
$pending = $stdin.ReadLineAsync()

try {
    while ($true) {
        [System.Windows.Forms.Application]::DoEvents()

        if ($pending.IsCompleted) {
            $line = $pending.Result
            if ($null -eq $line) { break }   # stdin closed — the parent is gone

            $line = $line.Trim()
            if ($line) {
                try {
                    $msg = $line | ConvertFrom-Json
                    if ($msg.exit) { break }
                    if ($null -ne $msg.tooltip) {
                        $text = [string]$msg.tooltip
                        if ($text.Length -gt $TOOLTIP_MAX) {
                            $text = $text.Substring(0, $TOOLTIP_MAX - 3) + '...'
                        }
                        if (-not $text) { $text = $TOOLTIP_DEFAULT }
                        $notify.Text = $text
                    }
                } catch {
                    # Malformed line — ignore it rather than kill the tray.
                }
            }

            $pending = $stdin.ReadLineAsync()
        }

        Start-Sleep -Milliseconds 100
    }
}
finally {
    $notify.Visible = $false
    $notify.Dispose()
    $menu.Dispose()
}
