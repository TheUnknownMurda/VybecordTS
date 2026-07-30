const systray = require('systray2');
const { exec } = require('child_process');
const path = require('path');

// Get the directory of this script
const scriptDir = __dirname;

// Menu items
const menuItems = [
  {
    title: 'Show Console',
    tooltip: 'Show the console window',
    checked: false,
    enabled: true,
    click: () => {
      exec('powershell.exe -WindowStyle Hidden -Command "Add-Type -Name Window -Namespace Console -MemberDefinition \'[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern IntPtr GetConsoleWindow();\'; $w = [Console.Window]::GetConsoleWindow(); [Console.Window]::ShowWindow($w, 9)"');
    }
  },
  {
    title: 'Hide Console',
    tooltip: 'Hide the console window',
    checked: false,
    enabled: true,
    click: () => {
      exec('powershell.exe -WindowStyle Hidden -Command "Add-Type -Name Window -Namespace Console -MemberDefinition \'[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern IntPtr GetConsoleWindow();\'; $w = [Console.Window]::GetConsoleWindow(); [Console.Window]::ShowWindow($w, 0)"');
    }
  },
  {
    title: '-',
    tooltip: '',
    checked: false,
    enabled: true
  },
  {
    title: 'Open Dashboard',
    tooltip: 'Open the web dashboard',
    checked: false,
    enabled: true,
    click: () => {
      exec('start http://127.0.0.1:8888');
    }
  },
  {
    title: '-',
    tooltip: '',
    checked: false,
    enabled: true
  },
  {
    title: 'Exit',
    tooltip: 'Exit the application',
    checked: false,
    enabled: true,
    click: () => {
      // Kill node process
      exec('taskkill /F /IM node.exe');
      systray.exit();
    }
  }
];

// Start the tray icon
systray.start({
  title: 'VybecordTS',
  icon: path.join(scriptDir, 'icon.png'),
  tooltip: 'VybecordTS - Discord Rich Presence',
  menu: {
    icon: path.join(scriptDir, 'icon.png'),
    title: 'VybecordTS',
    items: menuItems
  }
}, (error) => {
  if (error) {
    console.error('Error starting tray icon:', error);
  }
});

// Handle exit
systray.on('exit', (code) => {
  console.log('Tray icon exited with code:', code);
});

// Handle click
systray.on('click', () => {
  console.log('Tray icon clicked');
  exec('start http://127.0.0.1:8888');
});

// Keep the process alive
process.on('SIGINT', () => {
  systray.exit();
  process.exit(0);
});
