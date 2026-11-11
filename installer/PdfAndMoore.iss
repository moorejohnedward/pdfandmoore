; PDF and Moore installer (Inno Setup 6). Built by "Make Installer.bat".
; Installs to Program Files, adds Start menu / desktop shortcuts and an uninstaller,
; and (optionally) registers PDF, Word, Excel and PowerPoint files for "Open with" / Default apps.

#define MyAppName "PDF and Moore"
#define MyAppVersion "8.0"
#define MyAppExe "PDF and Moore.exe"

[Setup]
AppId={{E0ABD9B0-2259-4A6D-9A9D-F595A84B4BFC}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=John Moore
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExe}
UninstallDisplayName={#MyAppName}
OutputDir=..\..\..\Release (app to run and share)
OutputBaseFilename=PDF and Moore Setup
SetupIconFile=..\PdfAndMoore\Assets\app.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequiredOverridesAllowed=dialog
ChangesAssociations=yes
CloseApplications=yes

[Tasks]
Name: "defaults"; Description: "Open PDF, Word, Excel and PowerPoint files with PDF and Moore (you confirm in Windows Settings)"
Name: "desktopicon"; Description: "Create a desktop shortcut"

[Files]
Source: "..\Release\{#MyAppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExe}"; Parameters: "--register-defaults"; Tasks: defaults; Flags: runasoriginaluser waituntilterminated; StatusMsg: "Registering file types..."
Filename: "{app}\{#MyAppExe}"; Description: "Start PDF and Moore"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\{#MyAppExe}"; Parameters: "--unregister"; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterTypes"
