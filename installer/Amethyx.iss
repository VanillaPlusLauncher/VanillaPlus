; Amethyx Launcher installer (Inno Setup 6). Pictures come from make-art.ps1.
#define AppName "Amethyx Launcher"
#ifndef AppVersion
  #define AppVersion "1.3.0"
#endif
; Folder with the built launcher; the build script can point it elsewhere (/DSourceDir=...).
#ifndef SourceDir
  #define SourceDir "..\build\Amethyx"
#endif
#define SlideCount 5
; /DLegacy: the build for Windows 7 and 8 (Electron 22), its own file name and minimum Windows.
#ifdef Legacy
  #define FileSuffix "-win7"
#else
  #define FileSuffix ""
#endif

[Setup]
AppId={{6B1F3C2A-8E4D-4C1B-9A57-52C3D0E7A913}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
; A new install goes to Programs\Amethyx; an update of an older install stays in its folder (same AppId).
DefaultDirName={localappdata}\Programs\Amethyx
DefaultGroupName={#AppName}
DisableWelcomePage=no
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=..\build
OutputBaseFilename=Amethyx-Setup-{#AppVersion}{#FileSuffix}
SetupIconFile=art\setup.ico
UninstallDisplayIcon={app}\Amethyx.exe
UninstallDisplayName={#AppName}
; Dark like the launcher (Inno Setup 6.6+): its violet-black behind every page, no grey lines.
WizardStyle=modern dark hidebevels
WizardBackColor=#0a080f
WizardBackColorDynamicDark=#0a080f
WizardSizePercent=140
WizardImageFile=art\wizard-side.bmp
WizardSmallImageFile=art\wizard-small.bmp
WizardImageStretch=yes
Compression=lzma2/fast
SolidCompression=yes
; Both builds let Setup start on Windows 7 SP1 and newer. The Windows 7 / 8 build (Electron 22)
; installs anywhere from there; the usual one (Electron 44) needs Windows 10 1803 and says so itself in
; InitializeSetup below, with the way to the other build, instead of Setup's own bare version error.
MinVersion=6.1sp1
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Messages]
ru.FinishedLabel=Готово. Лаунчер установлен.

[Tasks]
Name: "desktopicon"; Description: "Ярлык на рабочем столе"; GroupDescription: "Ярлыки:"

[Files]
; Screenshots go first: in a solid archive they are then unpacked instantly at startup.
Source: "art\slide*.bmp"; Flags: dontcopy
Source: "art\wizard-full.bmp"; Flags: dontcopy
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; The launcher used to be called RichLauncher, then Vanilla+ Launcher: their programs and
; shortcuts go away on update.
Type: files; Name: "{app}\RichLauncher.exe"
Type: files; Name: "{autoprograms}\RichLauncher.lnk"
Type: files; Name: "{autoprograms}\Удалить RichLauncher.lnk"
Type: files; Name: "{autodesktop}\RichLauncher.lnk"
Type: files; Name: "{app}\VanillaPlus.exe"
Type: files; Name: "{autoprograms}\Vanilla+ Launcher.lnk"
Type: files; Name: "{autoprograms}\Удалить Vanilla+ Launcher.lnk"
Type: files; Name: "{autodesktop}\Vanilla+ Launcher.lnk"
; A hand-made "Amethyx" shortcut to an unpacked test copy: the installed launcher takes its place
; (it opens the same data, which lives in %APPDATA%\Amethyx and %APPDATA%\.amethyx).
Type: files; Name: "{autodesktop}\Amethyx.lnk"
Type: files; Name: "{autoprograms}\Amethyx.lnk"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\Amethyx.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Amethyx.exe"; Tasks: desktopicon
Name: "{autoprograms}\Удалить {#AppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\Amethyx.exe"; Description: "Запустить {#AppName}"; Flags: nowait postinstall skipifsilent
; An update started from the launcher (/SILENT /relaunch=1) opens the launcher again when done.
Filename: "{app}\Amethyx.exe"; Flags: nowait; Check: IsUpdateRelaunch

[Code]
#ifndef Legacy
{ The usual build needs Windows 10 1803 or newer (Electron 44). On an older Windows: plain words and
  the download page, where the build for Windows 7, 8 and older Windows 10 is. }
function InitializeSetup: Boolean;
var
  Version: TWindowsVersion;
  ErrorCode: Integer;
begin
  GetWindowsVersionEx(Version);
  Result := (Version.Major > 10) or ((Version.Major = 10) and (Version.Build >= 17134));
  if not Result and not WizardSilent then
    if MsgBox('Эта сборка Amethyx работает на Windows 10 версии 1803 и новее, а у вас более старая Windows.' + #13#10#13#10 +
      'Для Windows 7, 8 и старых версий Windows 10 есть отдельная сборка. Открыть страницу загрузки?',
      mbInformation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://launcher.x-world.plus/#download', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;
#endif
function IsUpdateRelaunch: Boolean;
begin
  Result := ExpandConstant('{param:relaunch|0}') = '1';
end;

const
  SlideInterval = 3200;

var
  Slide: TBitmapImage;
  Dots: array of TPanel;
  SlideIndex: Integer;
  SlideTimer: LongWord;

function SetTimer(Wnd: LongWord; IDEvent, Elapse: LongWord; TimerFunc: LongWord): LongWord;
  external 'SetTimer@user32.dll stdcall';
function KillTimer(Wnd: LongWord; IDEvent: LongWord): BOOL;
  external 'KillTimer@user32.dll stdcall';

function SlidePath(Index: Integer): String;
begin
  Result := ExpandConstant('{tmp}\slide' + IntToStr(Index + 1) + '.bmp');
end;

{ Fits a 16:10 picture into the given box, centred. }
procedure PlacePicture(Image: TBitmapImage; Left, Top, MaxWidth, MaxHeight: Integer);
var
  W, H: Integer;
begin
  W := MaxWidth;
  H := W * 10 div 16;
  if H > MaxHeight then
  begin
    H := MaxHeight;
    W := H * 16 div 10;
  end;
  Image.SetBounds(Left + (MaxWidth - W) div 2, Top, W, H);
end;

procedure ShowSlide(Index: Integer);
var
  I: Integer;
begin
  SlideIndex := Index mod {#SlideCount};
  Slide.Bitmap.LoadFromFile(SlidePath(SlideIndex));
  for I := 0 to GetArrayLength(Dots) - 1 do
    if I = SlideIndex then
      Dots[I].Color := $F678AC
    else
      Dots[I].Color := $5A5A5A;
end;

procedure OnSlideTimer(Wnd: LongWord; Msg: LongWord; IDEvent: LongWord; Time: LongWord);
begin
  ShowSlide(SlideIndex + 1);
end;

procedure OnSlideClick(Sender: TObject);
begin
  ShowSlide(SlideIndex + 1);
end;

procedure InitializeWizard;
var
  I, Top, DotSize, DotsLeft: Integer;
  Page: TNewNotebookPage;
begin
  for I := 1 to {#SlideCount} do
    ExtractTemporaryFile('slide' + IntToStr(I) + '.bmp');

  { Welcome page: one picture across the whole page, the name is part of it. }
  ExtractTemporaryFile('wizard-full.bmp');
  WizardForm.WelcomeLabel1.Visible := False;
  WizardForm.WelcomeLabel2.Visible := False;
  WizardForm.WizardBitmapImage.Bitmap.LoadFromFile(ExpandConstant('{tmp}\wizard-full.bmp'));
  WizardForm.WizardBitmapImage.SetBounds(0, 0, WizardForm.WelcomePage.Width, WizardForm.WelcomePage.Height);

  { Installing page: screenshots change while files are copied. }
  Page := WizardForm.InstallingPage;
  Slide := TBitmapImage.Create(WizardForm);
  Slide.Parent := Page;
  Slide.Stretch := True;
  Slide.Cursor := crHand;
  Slide.OnClick := @OnSlideClick;
  DotSize := ScaleX(8);
  Top := WizardForm.ProgressGauge.Top + WizardForm.ProgressGauge.Height + ScaleY(14);
  PlacePicture(Slide, 0, Top, Page.Width, Page.Height - Top - DotSize - ScaleY(10));

  SetArrayLength(Dots, {#SlideCount});
  DotsLeft := (Page.Width - ({#SlideCount} * DotSize + ({#SlideCount} - 1) * DotSize)) div 2;
  for I := 0 to {#SlideCount} - 1 do
  begin
    Dots[I] := TPanel.Create(WizardForm);
    Dots[I].Parent := Page;
    Dots[I].BevelOuter := bvNone;
    Dots[I].ParentBackground := False;
    Dots[I].SetBounds(DotsLeft + I * DotSize * 2, Slide.Top + Slide.Height + ScaleY(6), DotSize, DotSize);
  end;
  ShowSlide(0);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpInstalling then
  begin
    ShowSlide(0);
    SlideTimer := SetTimer(0, 0, SlideInterval, CreateCallback(@OnSlideTimer));
  end
  else if SlideTimer <> 0 then
  begin
    KillTimer(0, SlideTimer);
    SlideTimer := 0;
  end;
end;

procedure DeinitializeSetup;
begin
  if SlideTimer <> 0 then
    KillTimer(0, SlideTimer);
end;
