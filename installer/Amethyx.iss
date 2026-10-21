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
Source: "art\update-*.bmp"; Flags: dontcopy
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
; An update started from the launcher (/SILENT /relaunch=1) shows only a small window (see
; BuildUpdateWindow) and opens the launcher again when done.
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

{ An update from the launcher: no pages and no buttons, only a small window in the launcher's pixel
  look, like a splash screen. It is one picture (make-update-art.ps1, drawn at 1x, 2x and 3x so the
  pixels stay sharp) over the wizard's own controls, and the bar is a second picture shown as far
  as the install has got, in whole blocks. }
const
  UpdateFillLeft = 102;
  UpdateFillTop = 84;
  UpdateBlock = 12;
  UpdateCut = 6;
  RGN_OR = 2;

var
  UpdateFill: TBitmapImage;
  UpdateScale: Integer;

function CreateRectRgn(Left, Top, Right, Bottom: Integer): LongWord;
  external 'CreateRectRgn@gdi32.dll stdcall';
function CombineRgn(Dest, Source1, Source2: LongWord; Mode: Integer): Integer;
  external 'CombineRgn@gdi32.dll stdcall';
function DeleteObject(Handle: LongWord): BOOL;
  external 'DeleteObject@gdi32.dll stdcall';
function SetWindowRgn(Wnd: HWND; Region: LongWord; Redraw: BOOL): Integer;
  external 'SetWindowRgn@user32.dll stdcall';

{ The window's corners cut by one step, like the launcher's panels (the picture's frame follows it). }
procedure CutUpdateWindowCorners;
var
  Cut, W, H: Integer;
  Region, Across: LongWord;
begin
  Cut := UpdateCut * UpdateScale;
  W := WizardForm.ClientWidth;
  H := WizardForm.ClientHeight;
  Region := CreateRectRgn(Cut, 0, W - Cut, H);
  Across := CreateRectRgn(0, Cut, W, H - Cut);
  CombineRgn(Region, Region, Across, RGN_OR);
  DeleteObject(Across);
  { The window owns the region from here on. }
  SetWindowRgn(WizardForm.Handle, Region, True);
end;

procedure BuildUpdateWindow;
var
  Cover: TPanel;
  Back: TBitmapImage;
  Suffix: String;
begin
  UpdateScale := 1;
  if ScaleX(100) > 112 then UpdateScale := 2;
  if ScaleX(100) >= 250 then UpdateScale := 3;
  Suffix := IntToStr(UpdateScale) + 'x.bmp';
  ExtractTemporaryFile('update-bg-' + Suffix);
  ExtractTemporaryFile('update-fill-' + Suffix);

  { Pictures are drawn under the wizard's windowed controls, so they sit on a panel above them. }
  Cover := TPanel.Create(WizardForm);
  Cover.Parent := WizardForm;
  Cover.BevelOuter := bvNone;
  Back := TBitmapImage.Create(WizardForm);
  Back.Parent := Cover;
  Back.Bitmap.LoadFromFile(ExpandConstant('{tmp}\update-bg-' + Suffix));
  WizardForm.BorderStyle := bsNone;
  WizardForm.ClientWidth := Back.Bitmap.Width;
  WizardForm.ClientHeight := Back.Bitmap.Height;
  WizardForm.Position := poScreenCenter;
  Cover.SetBounds(0, 0, Back.Bitmap.Width, Back.Bitmap.Height);
  Cover.BringToFront;
  Back.SetBounds(0, 0, Back.Bitmap.Width, Back.Bitmap.Height);

  UpdateFill := TBitmapImage.Create(WizardForm);
  UpdateFill.Parent := Cover;
  UpdateFill.Stretch := False;
  UpdateFill.Center := False;
  UpdateFill.Bitmap.LoadFromFile(ExpandConstant('{tmp}\update-fill-' + Suffix));
  UpdateFill.SetBounds(UpdateFillLeft * UpdateScale, UpdateFillTop * UpdateScale, 0, UpdateFill.Bitmap.Height);
  UpdateFill.BringToFront;
  CutUpdateWindowCorners;
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
var
  Done: Int64;
  Width, Block: Integer;
begin
  if (UpdateFill = nil) or (MaxProgress <= 0) then
    Exit;
  Block := UpdateBlock * UpdateScale;
  { In 64 bits: the progress counts bytes and would overflow an Integer once multiplied. }
  Done := CurProgress;
  Width := Done * UpdateFill.Bitmap.Width div MaxProgress;
  if Width < UpdateFill.Bitmap.Width then
    Width := (Width div Block) * Block;
  UpdateFill.Width := Width;
end;

{ Nothing in that window to cancel the update with: Esc and Alt+F4 are ignored. }
procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if IsUpdateRelaunch then
    Cancel := False;
end;

procedure InitializeWizard;
var
  I, Top, DotSize, DotsLeft, W, H: Integer;
  Page: TNewNotebookPage;
  Picture: TBitmapImage;
begin
  if IsUpdateRelaunch then
  begin
    BuildUpdateWindow;
    Exit;
  end;
  for I := 1 to {#SlideCount} do
    ExtractTemporaryFile('slide' + IntToStr(I) + '.bmp');

  { Welcome page: one picture across the whole window, under the buttons too; the name is part of
    it. It keeps its proportions: it covers the window and what sticks out is cut off. }
  ExtractTemporaryFile('wizard-full.bmp');
  WizardForm.WelcomeLabel1.Visible := False;
  WizardForm.WelcomeLabel2.Visible := False;
  Picture := WizardForm.WizardBitmapImage;
  Picture.Bitmap.LoadFromFile(ExpandConstant('{tmp}\wizard-full.bmp'));
  Picture.Parent := WizardForm;
  Picture.Stretch := True;
  H := WizardForm.ClientHeight;
  W := H * Picture.Bitmap.Width div Picture.Bitmap.Height;
  if W < WizardForm.ClientWidth then
  begin
    W := WizardForm.ClientWidth;
    H := W * Picture.Bitmap.Height div Picture.Bitmap.Width;
  end;
  Picture.SetBounds((WizardForm.ClientWidth - W) div 2, (WizardForm.ClientHeight - H) div 2, W, H);
  Picture.BringToFront;
  WizardForm.BackButton.BringToFront;
  WizardForm.NextButton.BringToFront;
  WizardForm.CancelButton.BringToFront;

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
  if IsUpdateRelaunch then
  begin
    { Again once the window is up, in case Windows made it anew when it was shown. }
    CutUpdateWindowCorners;
    Exit;
  end;
  { The whole-window picture belongs to the welcome page only. }
  WizardForm.WizardBitmapImage.Visible := CurPageID = wpWelcome;
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
