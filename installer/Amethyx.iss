; Amethyx Launcher installer (Inno Setup 6). Its window is drawn from pictures in the launcher's pixel
; look (make-setup-art.ps1): one screen to install, a block bar while files are copied, and "Готово".
#define AppName "Amethyx Launcher"
#ifndef AppVersion
  #define AppVersion "1.3.0"
#endif
; Folder with the built launcher; the build script can point it elsewhere (/DSourceDir=...).
#ifndef SourceDir
  #define SourceDir "..\build\Amethyx"
#endif
; /DLegacy: the build for Windows 7 and 8 (Electron 22), its own file name and minimum Windows.
#ifdef Legacy
  #define FileSuffix "-win7"
#else
  #define FileSuffix ""
#endif
; How many panoramas make-setup-art.ps1 has cut (art\setup-pano-1.png, -2, …): one is picked each start.
#define PanoCount 0
#for {PanoCount = 0; FileExists(AddBackslash(SourcePath) + "art\setup-pano-" + Str(PanoCount + 1) + ".png"); PanoCount++} PanoCount
#if PanoCount == 0
  #error No installer backgrounds: run installer\make-setup-art.ps1 first.
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
; Dark like the launcher (Inno Setup 6.6+): the uninstaller and Setup's own dialogs too.
WizardStyle=modern dark hidebevels
WizardBackColor=#0a080f
WizardBackColorDynamicDark=#0a080f
WizardSmallImageFile=art\wizard-small.bmp
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

[Files]
; The window's pictures go first: in a solid archive they are then unpacked instantly at startup.
Source: "art\update-*.bmp"; Flags: dontcopy
Source: "art\setup-*.png"; Flags: dontcopy
Source: "art\Tiny5.ttf"; Flags: dontcopy
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
; The desktop shortcut follows the tick on the install screen (WantDesktopIcon).
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Amethyx.exe"; Check: WantDesktopIcon
Name: "{autoprograms}\Удалить {#AppName}"; Filename: "{uninstallexe}"

[Run]
; "Запустить" on the last screen ticks this one; "Закрыть" and the window's × leave it unticked.
Filename: "{app}\Amethyx.exe"; Description: "Запустить {#AppName}"; Flags: nowait postinstall skipifsilent unchecked
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

{ The window's pictures are drawn at 1x, 2x and 3x so the pixels stay sharp: the one nearest to the
  screen's scale is used (2x already from 125 %). }
function PictureScale: Integer;
begin
  Result := 1;
  if ScaleX(100) > 112 then Result := 2;
  if ScaleX(100) >= 250 then Result := 3;
end;

function SetTimer(Wnd: LongWord; IDEvent, Elapse: LongWord; TimerFunc: LongWord): LongWord;
  external 'SetTimer@user32.dll stdcall';
function KillTimer(Wnd: LongWord; IDEvent: LongWord): BOOL;
  external 'KillTimer@user32.dll stdcall';
function CreateRectRgn(Left, Top, Right, Bottom: Integer): LongWord;
  external 'CreateRectRgn@gdi32.dll stdcall';
function CombineRgn(Dest, Source1, Source2: LongWord; Mode: Integer): Integer;
  external 'CombineRgn@gdi32.dll stdcall';
function DeleteObject(Handle: LongWord): BOOL;
  external 'DeleteObject@gdi32.dll stdcall';
function SetWindowRgn(Wnd: HWND; Region: LongWord; Redraw: BOOL): Integer;
  external 'SetWindowRgn@user32.dll stdcall';
function GetSystemMenu(Wnd: HWND; Revert: BOOL): LongWord;
  external 'GetSystemMenu@user32.dll stdcall';
function EnableMenuItem(Menu: LongWord; Item, Flags: LongWord): BOOL;
  external 'EnableMenuItem@user32.dll stdcall';
function GetCursorPos(var Point: TPoint): BOOL;
  external 'GetCursorPos@user32.dll stdcall';
function ScreenToClient(Wnd: HWND; var Point: TPoint): BOOL;
  external 'ScreenToClient@user32.dll stdcall';
function AddFontResourceEx(FileName: String; Flags: DWORD; Reserved: DWORD): Integer;
  external 'AddFontResourceExW@gdi32.dll stdcall';
function DwmSetWindowAttribute(Wnd: HWND; Attribute: DWORD; var Value: DWORD; Size: DWORD): Integer;
  external 'DwmSetWindowAttribute@dwmapi.dll stdcall delayload';
function GetTickCount: DWORD;
  external 'GetTickCount@kernel32.dll stdcall';
function GetWindowLong(Wnd: HWND; Index: Integer): LongInt;
  external 'GetWindowLongW@user32.dll stdcall';
function SetWindowLong(Wnd: HWND; Index: Integer; NewLong: LongInt): LongInt;
  external 'SetWindowLongW@user32.dll stdcall';

const
  RGN_OR = 2;
  SC_CLOSE = $F060;
  MF_BYCOMMAND = 0;
  MF_ENABLED = 0;
  FR_PRIVATE = $10;
  GWL_EXSTYLE = -20;
  WS_EX_COMPOSITED = $02000000;

{ ---------------------------------------------------------------------------------------------
  An update from the launcher: no pages and no buttons, only a small window in the launcher's pixel
  look, like a splash screen. It is one picture (make-update-art.ps1) over the wizard's own
  controls, and the bar is a second picture shown as far as the install has got, in whole blocks.
  --------------------------------------------------------------------------------------------- }
const
  UpdateFillLeft = 102;
  UpdateFillTop = 84;
  UpdateBlock = 12;
  UpdateCut = 6;

var
  UpdateFill: TBitmapImage;
  UpdateScale: Integer;

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
  UpdateScale := PictureScale;
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

{ ---------------------------------------------------------------------------------------------
  The usual install: Setup's own pages stay underneath, hidden by a panel with the pictures of
  art\setup-ui (make-setup-art.ps1; setup-layout.iss says where each one stands, at 1x). Three
  screens: install (folder, desktop shortcut, "Установить"), installing (block bar, percentage)
  and done ("Закрыть", "Запустить"). The folder and the percentage are written by Setup itself in
  the launcher's pixel font. Buttons light up under the mouse (a timer looks where it is).
  --------------------------------------------------------------------------------------------- }
#include "art\setup-layout.iss"

const
  ScreenInstall = 0;
  ScreenProgress = 1;
  ScreenDone = 2;
  FieldColor = $11090B;      { #0b0911, the folder field }
  PanelColor = $1F1216;      { #16121f, the panels }
  SoftTextColor = $D8BBC4;   { #c4bbd8 }
  AccentTextColor = $FFA0BE; { #bea0ff }
  FillBlock = 16;

type
  TSetupButton = record
    Normal, Hover: TBitmapImage;
    X, Y, W, H: Integer;
  end;

var
  Screen: TPanel;
  Scale: Integer;
  ShownScreen: Integer;
  PanelInstall, PanelProgress, PanelDone: TBitmapImage;
  ChangeButton, InstallButton, CloseButton, RunButton: TSetupButton;
  CheckOn, CheckOff, CheckHit: TBitmapImage;
  PathText, PercentText, SetupFill: TBitmapImage;
  ShownPercent: Integer;
  DesktopIcon: Boolean;
  HoverTimer: LongWord;

function WantDesktopIcon: Boolean;
begin
  Result := DesktopIcon;
end;

{ One picture of art\setup-*.png at its place (1x coordinates). }
function Part(const Name: String; X, Y: Integer): TBitmapImage;
var
  FileName: String;
begin
  FileName := 'setup-' + Name + '-' + IntToStr(Scale) + 'x.png';
  ExtractTemporaryFile(FileName);
  Result := TBitmapImage.Create(WizardForm);
  Result.Parent := Screen;
  Result.BackColor := clNone;
  Result.PngImage.LoadFromFile(ExpandConstant('{tmp}\') + FileName);
  Result.SetBounds(X * Scale, Y * Scale, Result.PngImage.Width, Result.PngImage.Height);
end;

procedure MakeButton(var Button: TSetupButton; const Name: String; X, Y, W, H: Integer; Click: TNotifyEvent);
begin
  Button.X := X * Scale; Button.Y := Y * Scale; Button.W := W * Scale; Button.H := H * Scale;
  Button.Normal := Part(Name, X, Y);
  Button.Hover := Part(Name + '-hover', X, Y);
  Button.Hover.Visible := False;
  Button.Normal.Cursor := crHand;
  Button.Hover.Cursor := crHand;
  Button.Normal.OnClick := Click;
  Button.Hover.OnClick := Click;
end;

procedure ShowButton(var Button: TSetupButton; Visible: Boolean);
begin
  Button.Normal.Visible := Visible;
  Button.Hover.Visible := False;
end;

{ A place Setup writes into: an empty picture of that size. }
function TextPlace(X, Y, W, H: Integer): TBitmapImage;
begin
  Result := TBitmapImage.Create(WizardForm);
  Result.Parent := Screen;
  Result.SetBounds(X * Scale, Y * Scale, W * Scale, H * Scale);
  Result.Bitmap.Width := W * Scale;
  Result.Bitmap.Height := H * Scale;
end;

{ Text in Tiny5 on a solid background, left or right aligned, vertically centred. }
procedure WriteText(Place: TBitmapImage; const Text: String; Background, Color: TColor; RightAligned: Boolean);
var
  R: TRect;
  Canvas: TCanvas;
  X: Integer;
begin
  Canvas := Place.Bitmap.Canvas;
  Canvas.Brush.Color := Background;
  Canvas.Brush.Style := bsSolid;
  R.Left := 0; R.Top := 0; R.Right := Place.Bitmap.Width; R.Bottom := Place.Bitmap.Height;
  Canvas.FillRect(R);
  Canvas.Font.Name := 'Tiny5';
  Canvas.Font.Height := -16 * Scale;
  Canvas.Font.Color := Color;
  X := 0;
  if RightAligned then
    X := Place.Bitmap.Width - Canvas.TextWidth(Text);
  Canvas.TextOut(X, (Place.Bitmap.Height - Canvas.TextHeight(Text)) div 2, Text);
  Place.Invalidate;
end;

{ The folder; a long one keeps its drive and its end ("C:\...\Programs\Amethyx"). }
procedure ShowFolder;
var
  Path, Shown: String;
  Canvas: TCanvas;
  Cut: Integer;
begin
  Path := WizardForm.DirEdit.Text;
  Shown := Path;
  Canvas := PathText.Bitmap.Canvas;
  Canvas.Font.Name := 'Tiny5';
  Canvas.Font.Height := -16 * Scale;
  Cut := 4;
  while (Canvas.TextWidth(Shown) > PathText.Bitmap.Width) and (Cut < Length(Path) - 8) do
  begin
    Shown := Copy(Path, 1, 3) + '...' + Copy(Path, Cut, Length(Path));
    Cut := Cut + 1;
  end;
  WriteText(PathText, Shown, FieldColor, SoftTextColor, False);
end;

{ The percentage, written only when it changes. Its place is made when the bar first shows: one made
  while hidden showed leftover pixels instead of the text. }
procedure ShowPercent(Percent: Integer);
begin
  if PercentText = nil then
  begin
    PercentText := TextPlace(SetupPercentX, SetupPercentY, SetupPercentW, SetupPercentH);
    ShownPercent := -1;
  end;
  if Percent = ShownPercent then
    Exit;
  ShownPercent := Percent;
  WriteText(PercentText, IntToStr(Percent) + '%', PanelColor, AccentTextColor, True);
end;

procedure ShowScreen(Which: Integer);
begin
  ShownScreen := Which;
  if Which = ScreenProgress then
    ShowPercent(0);
  PanelInstall.Visible := Which = ScreenInstall;
  ShowButton(ChangeButton, Which = ScreenInstall);
  ShowButton(InstallButton, Which = ScreenInstall);
  CheckOn.Visible := (Which = ScreenInstall) and DesktopIcon;
  CheckOff.Visible := (Which = ScreenInstall) and not DesktopIcon;
  CheckHit.Visible := Which = ScreenInstall;
  PathText.Visible := Which = ScreenInstall;
  PanelProgress.Visible := Which = ScreenProgress;
  if PercentText <> nil then
    PercentText.Visible := Which = ScreenProgress;
  SetupFill.Visible := Which = ScreenProgress;
  PanelDone.Visible := Which = ScreenDone;
  ShowButton(CloseButton, Which = ScreenDone);
  ShowButton(RunButton, Which = ScreenDone);
end;

{ A button lights up while the mouse is over it. }
procedure UpdateHover(var Button: TSetupButton; const Point: TPoint);
var
  Over: Boolean;
begin
  if not (Button.Normal.Visible or Button.Hover.Visible) then
    Exit;
  Over := (Point.X >= Button.X) and (Point.X < Button.X + Button.W) and (Point.Y >= Button.Y) and (Point.Y < Button.Y + Button.H);
  if Button.Hover.Visible <> Over then
  begin
    Button.Hover.Visible := Over;
    Button.Normal.Visible := not Over;
  end;
end;

procedure OnHoverTimer(Wnd: LongWord; Msg: LongWord; IDEvent: LongWord; Time: LongWord);
var
  Point: TPoint;
begin
  if not GetCursorPos(Point) then
    Exit;
  ScreenToClient(Screen.Handle, Point);
  UpdateHover(ChangeButton, Point);
  UpdateHover(InstallButton, Point);
  UpdateHover(CloseButton, Point);
  UpdateHover(RunButton, Point);
end;

procedure ChangeFolderClick(Sender: TObject);
var
  Dir: String;
begin
  Dir := WizardForm.DirEdit.Text;
  if BrowseForFolder('Куда установить Amethyx Launcher?', Dir, True) then
  begin
    { Like Setup's own "Browse": the launcher gets a folder of its own inside the chosen one. }
    if CompareText(ExtractFileName(RemoveBackslashUnlessRoot(Dir)), 'Amethyx') <> 0 then
      Dir := AddBackslash(Dir) + 'Amethyx';
    WizardForm.DirEdit.Text := Dir;
    ShowFolder;
  end;
end;

procedure DesktopIconClick(Sender: TObject);
begin
  DesktopIcon := not DesktopIcon;
  CheckOn.Visible := DesktopIcon;
  CheckOff.Visible := not DesktopIcon;
end;

procedure InstallClick(Sender: TObject);
begin
  WizardForm.NextButton.OnClick(WizardForm.NextButton);
end;

procedure Finish(Run: Boolean);
var
  I: Integer;
begin
  for I := 0 to WizardForm.RunList.Items.Count - 1 do
    WizardForm.RunList.Checked[I] := Run;
  WizardForm.NextButton.OnClick(WizardForm.NextButton);
end;

procedure CloseClick(Sender: TObject);
begin
  Finish(False);
end;

procedure RunClick(Sender: TObject);
begin
  Finish(True);
end;

{ The last screen: the window's × (and "Close" in its menu) ends Setup without starting the
  launcher. Setup itself greys them out there, since it has no Cancel button to send them to. }
procedure FinishedCloseQuery(Sender: TObject; var CanClose: Boolean);
begin
  CanClose := False;
  Finish(False);
end;

procedure BuildSetupWindow;
var
  Pano: TBitmapImage;
  PanoName: String;
  Color: DWORD;
begin
  Scale := PictureScale;
  DesktopIcon := True;
  WizardForm.ClientWidth := 760 * Scale;
  WizardForm.ClientHeight := 460 * Scale;
  WizardForm.Position := poScreenCenter;

  { The launcher's pixel font, for this process only. }
  ExtractTemporaryFile('Tiny5.ttf');
  AddFontResourceEx(ExpandConstant('{tmp}\Tiny5.ttf'), FR_PRIVATE, 0);

  { Pictures are drawn under the wizard's windowed controls, so they sit on a panel above them. }
  Screen := TPanel.Create(WizardForm);
  Screen.Parent := WizardForm;
  Screen.BevelOuter := bvNone;
  Screen.SetBounds(0, 0, WizardForm.ClientWidth, WizardForm.ClientHeight);
  Screen.BringToFront;

  { A different panorama each time, like the launcher's background. }
  PanoName := 'setup-pano-' + IntToStr(GetTickCount mod {#PanoCount} + 1) + '.png';
  ExtractTemporaryFile(PanoName);
  Pano := TBitmapImage.Create(WizardForm);
  Pano.Parent := Screen;
  Pano.Stretch := True;
  Pano.PngImage.LoadFromFile(ExpandConstant('{tmp}\') + PanoName);
  Pano.SetBounds(0, 0, Screen.Width, Screen.Height);

  Part('shade', SetupShadeX, SetupShadeY);
  Part('brand', SetupBrandX, SetupBrandY);

  PanelInstall := Part('panel-install', SetupPanelInstallX, SetupPanelInstallY);
  PathText := TextPlace(SetupPathX, SetupPathY, SetupPathW, SetupPathH);
  MakeButton(ChangeButton, 'btn-change', SetupBtnChangeX, SetupBtnChangeY, SetupBtnChangeW, SetupBtnChangeH, @ChangeFolderClick);
  CheckOn := Part('check-on', SetupCheckOnX, SetupCheckOnY);
  CheckOff := Part('check-off', SetupCheckOffX, SetupCheckOffY);
  { The tick and its words are one place to click. }
  CheckHit := TBitmapImage.Create(WizardForm);
  CheckHit.Parent := Screen;
  CheckHit.BackColor := clNone;
  CheckHit.Cursor := crHand;
  CheckHit.SetBounds(SetupCheckHitX * Scale, SetupCheckHitY * Scale, SetupCheckHitW * Scale, SetupCheckHitH * Scale);
  CheckHit.OnClick := @DesktopIconClick;
  MakeButton(InstallButton, 'btn-install', SetupBtnInstallX, SetupBtnInstallY, SetupBtnInstallW, SetupBtnInstallH, @InstallClick);

  PanelProgress := Part('panel-progress', SetupPanelProgressX, SetupPanelProgressY);
  SetupFill := Part('fill', SetupFillX, SetupFillY);
  SetupFill.Stretch := False;
  SetupFill.Center := False;
  SetupFill.Width := 0;

  PanelDone := Part('panel-done', SetupPanelDoneX, SetupPanelDoneY);
  MakeButton(CloseButton, 'btn-close', SetupBtnCloseX, SetupBtnCloseY, SetupBtnCloseW, SetupBtnCloseH, @CloseClick);
  MakeButton(RunButton, 'btn-run', SetupBtnRunX, SetupBtnRunY, SetupBtnRunW, SetupBtnRunH, @RunClick);

  ShowFolder;
  ShowScreen(ScreenInstall);
  { Drawn off screen first and shown at once: the growing bar and the percentage do not flicker. }
  SetWindowLong(Screen.Handle, GWL_EXSTYLE, GetWindowLong(Screen.Handle, GWL_EXSTYLE) or WS_EX_COMPOSITED);
  HoverTimer := SetTimer(0, 0, 40, CreateCallback(@OnHoverTimer));

  { Windows 11: the title bar in the launcher's violet-black instead of grey. }
  Color := $000F080A;
  DwmSetWindowAttribute(WizardForm.Handle, 35, Color, 4);
  Color := $00EAD2D9;
  DwmSetWindowAttribute(WizardForm.Handle, 36, Color, 4);
end;

{ --------------------------------------------------------------------------------------------- }

procedure InitializeWizard;
begin
  if IsUpdateRelaunch then
    BuildUpdateWindow
  else
    BuildSetupWindow;
end;

var
  NextTimer: LongWord;

procedure OnNextTimer(Wnd: LongWord; Msg: LongWord; IDEvent: LongWord; Time: LongWord);
begin
  KillTimer(0, NextTimer);
  NextTimer := 0;
  WizardForm.NextButton.OnClick(WizardForm.NextButton);
end;

{ The folder is chosen on the install screen; Setup's own folder page is not needed. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := PageID = wpSelectDir;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if IsUpdateRelaunch then
  begin
    { Again once the window is up, in case Windows made it anew when it was shown. }
    CutUpdateWindowCorners;
    Exit;
  end;
  case CurPageID of
    wpWelcome: ShowScreen(ScreenInstall);
    wpPreparing:
      begin
        { The launcher is still open: Setup's own question about closing it stays hidden under the
          screen, so the answer is "close it" and Setup goes on by itself a moment later. }
        ShowScreen(ScreenProgress);
        if WizardForm.PreparingYesRadio.Visible then
        begin
          WizardForm.PreparingYesRadio.Checked := True;
          NextTimer := SetTimer(0, 0, 300, CreateCallback(@OnNextTimer));
        end;
      end;
    wpInstalling: ShowScreen(ScreenProgress);
    wpFinished:
      begin
        ShowScreen(ScreenDone);
        WizardForm.OnCloseQuery := @FinishedCloseQuery;
        EnableMenuItem(GetSystemMenu(WizardForm.Handle, False), SC_CLOSE, MF_BYCOMMAND or MF_ENABLED);
      end;
  end;
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
var
  Done: Int64;
  Width, Block: Integer;
begin
  if MaxProgress <= 0 then
    Exit;
  { In 64 bits: the progress counts bytes and would overflow an Integer once multiplied. }
  Done := CurProgress;
  if UpdateFill <> nil then
  begin
    Block := UpdateBlock * UpdateScale;
    Width := Done * UpdateFill.Bitmap.Width div MaxProgress;
    if Width < UpdateFill.Bitmap.Width then
      Width := (Width div Block) * Block;
    UpdateFill.Width := Width;
  end
  else if SetupFill <> nil then
  begin
    Block := FillBlock * Scale;
    Width := Done * SetupFill.PngImage.Width div MaxProgress;
    if Width < SetupFill.PngImage.Width then
      Width := (Width div Block) * Block;
    SetupFill.Width := Width;
    ShowPercent(Done * 100 div MaxProgress);
  end;
end;

{ Nothing in the update window to cancel the update with: Esc and Alt+F4 are ignored. }
procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if IsUpdateRelaunch then
    Cancel := False;
end;

procedure DeinitializeSetup;
begin
  if HoverTimer <> 0 then
    KillTimer(0, HoverTimer);
end;
