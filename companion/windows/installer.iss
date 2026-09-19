#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#define StagingDir "..\..\dist\windows-staging"

[Setup]
AppId={{4D45F477-3E37-4D4B-A539-37EE16A5F70A}
AppName=EditOfLegends Engine
AppVersion={#AppVersion}
AppPublisher=TaejinUOS
DefaultDirName={localappdata}\Programs\EditOfLegends
DefaultGroupName=EditOfLegends
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=EditOfLegends-Engine-Setup-{#AppVersion}-win-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\EditOfLegendsLauncher.exe
CloseApplications=no
RestartApplications=no

[Files]
Source: "{#StagingDir}\EditOfLegendsLauncher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StagingDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StagingDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StagingDir}\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Classes\editoflegends"; ValueType: string; ValueName: ""; ValueData: "URL:EditOfLegends Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\editoflegends"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\editoflegends\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\EditOfLegendsLauncher.exe,0"
Root: HKCU; Subkey: "Software\Classes\editoflegends\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\EditOfLegendsLauncher.exe"" ""%1"""

[Icons]
Name: "{group}\EditOfLegends 제거"; Filename: "{uninstallexe}"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
