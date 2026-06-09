; VybecordTS — Windows installer (Inno Setup 6)
; Build: npm run build:installer  (requires Inno Setup: https://jrsoftware.org/isdl.php)

#define MyAppName "VybecordTS"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "TheUnknownMurda"
#define MyAppURL "https://github.com/TheUnknownMurda/VybecordTS"
#define MyAppExeName "VybecordTS.exe"

[Setup]
AppId={{A3B8F2E1-9C4D-4F6A-B1E2-7D8C9E0F1A2B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\build
OutputBaseFilename=VybecordTS-Setup-{#MyAppVersion}
SetupIconFile=
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\build\VybecordTS\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; WorkingDir: "{app}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Messages]
french.WelcomeLabel2=VybecordTS affiche vos paroles synchronisées sur Discord.%n%nL'assistant dans le navigateur s'ouvrira après l'installation (2 minutes).
