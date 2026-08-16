; VybecordTS — Inno Setup installer
;
; Build with:  npm run build:exe   (compiles this automatically)
; Or manually: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\VybecordTS.iss
;
; Installs to %APPDATA%\VybecordTS by default. The destination stays editable,
; but must be writable: VybecordTS keeps config.json, logs and its lyrics
; database next to the .exe, so C:\Program Files would break it on first run.

#define AppName        "VybecordTS"
#define AppVersion     "1.0.0"
#define AppPublisher   "TheUnknownMurda"
#define AppURL         "https://github.com/TheUnknownMurda/VybecordTS"
#define AppExe         "VybecordTS.exe"
#define SourceDir      "..\build\VybecordTS"

[Setup]
; Fixed GUID — never change it, or future versions install side by side
; instead of upgrading.
AppId={{8F3C2A91-6B47-4E5D-9C18-2A7E4D5B3F60}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases

DefaultDirName={userappdata}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
AllowNoIcons=yes

; Everything lives under the user profile — no elevation, no UAC prompt.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

OutputDir=..\build
OutputBaseFilename={#AppName}-Setup
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
french.DirNoteCaption=VybecordTS enregistre sa configuration, ses journaux et sa base de paroles dans ce dossier. Choisissez un emplacement dans lequel vous pouvez écrire.
english.DirNoteCaption=VybecordTS stores its configuration, logs and lyrics database in this folder. Pick a location you can write to.

french.DirProtected=Ce dossier est protégé par Windows et VybecordTS ne pourra pas y écrire sa configuration.%n%nChoisissez un autre emplacement, par exemple celui proposé par défaut :%n%1
english.DirProtected=This folder is protected by Windows and VybecordTS would not be able to write its configuration there.%n%nPick another location, for example the suggested default:%n%1

french.DirNotWritable=Impossible d'écrire dans ce dossier.%n%nVybecordTS a besoin d'y enregistrer sa configuration et ses paroles. Choisissez un autre emplacement, par exemple celui proposé par défaut :%n%1
english.DirNotWritable=This folder is not writable.%n%nVybecordTS needs to save its configuration and lyrics there. Pick another location, for example the suggested default:%n%1

french.SpicetifyPageTitle=Intégration Spotify
french.SpicetifyPageSubtitle=Pour l'application de bureau Spotify (facultatif)
english.SpicetifyPageTitle=Spotify integration
english.SpicetifyPageSubtitle=For the Spotify desktop app (optional)

french.SpicetifyCheck=Installer Spicetify et l'extension Vybecord
english.SpicetifyCheck=Install Spicetify and the Vybecord extension

french.SpicetifyDesc=Spicetify permet à VybecordTS de lire instantanément ce que joue l'application de bureau Spotify, avec la pochette et la progression exactes.%n%nL'installation télécharge et exécute le script officiel de Spicetify depuis Internet (github.com/spicetify). Spicetify modifie le client Spotify, ce que les conditions d'utilisation de Spotify n'autorisent pas explicitement ; en pratique aucun bannissement n'a été rapporté, mais le choix vous revient.%n%nInutile si vous écoutez Spotify dans votre navigateur : le script Tampermonkey « Spotify » suffit.
english.SpicetifyDesc=Spicetify lets VybecordTS read what the Spotify desktop app is playing instantly, with exact artwork and progress.%n%nInstalling downloads and runs Spicetify's official script from the internet (github.com/spicetify). Spicetify modifies the Spotify client, which Spotify's terms of service do not explicitly allow; no bans have been reported in practice, but the choice is yours.%n%nNot needed if you listen to Spotify in your browser: the "Spotify" Tampermonkey script is enough.

french.SpicetifyInstalling=Installation de Spicetify (téléchargement en cours)...
english.SpicetifyInstalling=Installing Spicetify (downloading)...
french.SpicetifyExtInstalling=Installation de l'extension Vybecord...
english.SpicetifyExtInstalling=Installing the Vybecord extension...

french.SpotifyRunning=Spotify est en cours d'exécution.%n%nSpicetify doit fermer Spotify pour appliquer l'extension. Fermez Spotify puis cliquez sur Réessayer.
english.SpotifyRunning=Spotify is currently running.%n%nSpicetify needs Spotify closed to apply the extension. Close Spotify, then click Retry.

french.SpicetifyFailed=L'installation de Spicetify a échoué.%n%nVybecordTS est installé et fonctionnel : Spotify sera simplement détecté via le script navigateur ou Windows. Vous pourrez réessayer plus tard depuis la page de configuration.
english.SpicetifyFailed=Spicetify installation failed.%n%nVybecordTS is installed and working: Spotify will just be detected through the browser script or Windows instead. You can retry later from the setup page.

french.SpicetifyExtFailed=Spicetify est installé, mais l'extension Vybecord n'a pas pu être appliquée.%n%nLa page de configuration qui s'ouvre au premier lancement indique la marche à suivre manuelle.
english.SpicetifyExtFailed=Spicetify is installed, but the Vybecord extension could not be applied.%n%nThe setup page that opens on first launch explains how to do it manually.

french.LaunchApp=Lancer {#AppName}
english.LaunchApp=Launch {#AppName}

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\icon.ico"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Generated at runtime — not tracked by the installer, so remove explicitly.
; config.json, stats and the lyrics databases are deliberately left behind so
; a reinstall keeps the user's settings.
Type: filesandordirs; Name: "{app}\logs"
Type: files; Name: "{app}\*.tmp"
Type: dirifempty; Name: "{app}"

[Code]
var
  SpicetifyPage: TInputOptionWizardPage;

// ── Destination folder validation ─────────────────────────────────────────
// VybecordTS writes config.json, logs and its lyrics DB next to the .exe, so
// the install folder has to be writable. Two checks: a blacklist of the
// obvious Windows-protected paths, then a real write test — the latter also
// catches read-only network shares and locked-down folders.

function IsUnder(const Path, Parent: string): Boolean;
var
  P, Q: string;
begin
  Result := False;
  if Parent = '' then Exit;
  P := Lowercase(AddBackslash(Path));
  Q := Lowercase(AddBackslash(Parent));
  Result := Copy(P, 1, Length(Q)) = Q;
end;

function IsProtectedDir(const Path: string): Boolean;
begin
  Result :=
    IsUnder(Path, ExpandConstant('{commonpf}')) or
    IsUnder(Path, ExpandConstant('{commonpf32}')) or
    IsUnder(Path, ExpandConstant('{commonpf64}')) or
    IsUnder(Path, ExpandConstant('{win}')) or
    IsUnder(Path, ExpandConstant('{sys}')) or
    (Length(RemoveBackslash(Path)) <= 2);  // drive root, e.g. "C:\"
end;

// Walk up until we find a folder that exists — that's where we can test
// whether the user is actually allowed to create the target folder.
function NearestExistingAncestor(Path: string): string;
var
  Parent: string;
begin
  Path := RemoveBackslash(Path);
  while (Path <> '') and not DirExists(Path) do
  begin
    Parent := ExtractFileDir(Path);
    if Parent = Path then Break;
    Path := Parent;
  end;
  Result := Path;
end;

function IsWritable(const Dir: string): Boolean;
var
  Probe: string;
begin
  Result := False;
  if not DirExists(Dir) then Exit;
  Probe := AddBackslash(Dir) + 'vybecord_write_test.tmp';
  if SaveStringToFile(Probe, 'test', False) then
  begin
    DeleteFile(Probe);
    Result := True;
  end;
end;

function ValidateInstallDir(const Dir: string): Boolean;
var
  Suggested, Ancestor: string;
begin
  Result := False;
  Suggested := ExpandConstant('{userappdata}\{#AppName}');

  if IsProtectedDir(Dir) then
  begin
    MsgBox(FmtMessage(CustomMessage('DirProtected'), [Suggested]), mbError, MB_OK);
    Exit;
  end;

  Ancestor := NearestExistingAncestor(Dir);
  if (Ancestor = '') or not IsWritable(Ancestor) then
  begin
    MsgBox(FmtMessage(CustomMessage('DirNotWritable'), [Suggested]), mbError, MB_OK);
    Exit;
  end;

  Result := True;
end;

// ── Spicetify ─────────────────────────────────────────────────────────────

function SpicetifyExePath(): string;
begin
  Result := ExpandConstant('{localappdata}\spicetify\spicetify.exe');
end;

function SpicetifyInstalled(): Boolean;
begin
  Result := FileExists(SpicetifyExePath());
end;

function RunHidden(const Cmd, Params: string; var ResultCode: Integer): Boolean;
begin
  Result := Exec(Cmd, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function RunPowerShell(const Script: string; var ResultCode: Integer): Boolean;
begin
  Result := RunHidden(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"',
    ResultCode);
end;

function SpotifyIsRunning(): Boolean;
var
  Code: Integer;
begin
  // exit 1 when a Spotify process exists, 0 otherwise
  if RunPowerShell('if (Get-Process Spotify -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }', Code) then
    Result := (Code = 1)
  else
    Result := False;  // can't tell — let spicetify try and report its own error
end;

// Spicetify can only patch a closed Spotify. Ask rather than fail silently.
function EnsureSpotifyClosed(): Boolean;
begin
  Result := True;
  while SpotifyIsRunning() do
  begin
    if MsgBox(CustomMessage('SpotifyRunning'), mbConfirmation, MB_RETRYCANCEL) = IDCANCEL then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

function InstallSpicetifyCli(): Boolean;
var
  Code: Integer;
begin
  WizardForm.StatusLabel.Caption := CustomMessage('SpicetifyInstalling');
  // Official installer, same command as spicetify.app documents.
  Result := RunPowerShell(
    '$ErrorActionPreference=''Stop''; ' +
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ' +
    'iwr -useb ''https://raw.githubusercontent.com/spicetify/cli/main/install.ps1'' | iex',
    Code) and (Code = 0) and SpicetifyInstalled();
end;

function InstallVybecordExtension(): Boolean;
var
  Code: Integer;
  ExtDir, Src, Dst, Spicetify: string;
begin
  Result := False;
  WizardForm.StatusLabel.Caption := CustomMessage('SpicetifyExtInstalling');

  Src := ExpandConstant('{app}\spicetify-extension\vybecord.js');
  if not FileExists(Src) then Exit;

  ExtDir := ExpandConstant('{userappdata}\spicetify\Extensions');
  if not ForceDirectories(ExtDir) then Exit;

  Dst := AddBackslash(ExtDir) + 'vybecord.js';
  if not FileCopy(Src, Dst, False) then Exit;

  Spicetify := SpicetifyExePath();

  // First run of `spicetify` on a fresh install creates config-xpui.ini.
  RunHidden(Spicetify, '-v', Code);

  if not RunHidden(Spicetify, 'config extensions vybecord.js', Code) then Exit;
  if Code <> 0 then Exit;

  if not RunHidden(Spicetify, 'apply', Code) then Exit;
  Result := (Code = 0);
end;

procedure DoSpicetifySetup();
begin
  if not EnsureSpotifyClosed() then Exit;

  if not SpicetifyInstalled() then
  begin
    if not InstallSpicetifyCli() then
    begin
      MsgBox(CustomMessage('SpicetifyFailed'), mbInformation, MB_OK);
      Exit;
    end;
  end;

  if not InstallVybecordExtension() then
    MsgBox(CustomMessage('SpicetifyExtFailed'), mbInformation, MB_OK);
end;

// ── Wizard wiring ─────────────────────────────────────────────────────────

procedure InitializeWizard();
begin
  SpicetifyPage := CreateInputOptionPage(
    wpSelectTasks,
    CustomMessage('SpicetifyPageTitle'),
    CustomMessage('SpicetifyPageSubtitle'),
    CustomMessage('SpicetifyDesc'),
    False, False);
  SpicetifyPage.Add(CustomMessage('SpicetifyCheck'));
  // Unchecked by default: it downloads and runs a remote script, and modifies
  // the Spotify client. That should be a deliberate opt-in.
  SpicetifyPage.Values[0] := False;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpSelectDir then
    WizardForm.DirEdit.Hint := CustomMessage('DirNoteCaption');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpSelectDir then
    Result := ValidateInstallDir(WizardForm.DirEdit.Text);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and SpicetifyPage.Values[0] then
    DoSpicetifySetup();
end;
