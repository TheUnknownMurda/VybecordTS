using System;
using System.Drawing;
using System.Windows.Forms;
using System.Diagnostics;

class TrayIconApp
{
    private static NotifyIcon notifyIcon;
    private static ContextMenuStrip contextMenu;
    
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        
        notifyIcon = new NotifyIcon();
        notifyIcon.Icon = SystemIcons.Information;
        notifyIcon.Text = "VybecordTS - Discord Rich Presence";
        notifyIcon.Visible = true;
        
        // Create context menu
        contextMenu = new ContextMenuStrip();
        
        ToolStripMenuItem openDashboard = new ToolStripMenuItem("Open Dashboard");
        openDashboard.Click += (s, e) => Process.Start("http://127.0.0.1:8888");
        contextMenu.Items.Add(openDashboard);
        
        contextMenu.Items.Add("-");
        
        ToolStripMenuItem exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += (s, e) => {
            notifyIcon.Visible = false;
            Application.Exit();
            // Kill node process
            foreach (Process p in Process.GetProcessesByName("node"))
            {
                try
                {
                    if (p.MainModule.FileName.Contains("node") && p.CommandLine != null && p.CommandLine.Contains("index.js"))
                    {
                        p.Kill();
                    }
                }
                catch {}
            }
        };
        contextMenu.Items.Add(exitItem);
        
        notifyIcon.ContextMenuStrip = contextMenu;
        
        // Left-click to open dashboard
        notifyIcon.Click += (s, e) => {
            if (((MouseEventArgs)e).Button == MouseButtons.Left)
            {
                Process.Start("http://127.0.0.1:8888");
            }
        };
        
        // Show balloon tip
        notifyIcon.ShowBalloonTip(3000, "VybecordTS", "Running in background", ToolTipIcon.Info);
        
        // Monitor if node process is still running
        Timer timer = new Timer();
        timer.Interval = 3000;
        timer.Tick += (s, e) => {
            bool nodeRunning = false;
            foreach (Process p in Process.GetProcessesByName("node"))
            {
                try
                {
                    if (p.CommandLine != null && p.CommandLine.Contains("index.js"))
                    {
                        nodeRunning = true;
                        break;
                    }
                }
                catch {}
            }
            
            if (!nodeRunning)
            {
                notifyIcon.Visible = false;
                Application.Exit();
            }
        };
        timer.Start();
        
        Application.Run();
    }
}
