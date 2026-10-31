; Amethyx Launcher installer (Inno Setup 6). Its window is drawn from pictures in the launcher's soft
; look (make-setup-art.ps1): one screen to install, a bar while files are copied, and "Готово".
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
; Where a new install goes: the per-user Programs folder, which needs no administrator rights.
#define DefaultDir "{localappdata}\Programs\Amethyx"
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
; A new install goes to Programs\Amethyx; an update of an older install stays in its folder (same AppId),
; unless that folder is right in Documents (see LeaveOldFolder).
DefaultDirName={#DefaultDir}
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
; FileStarted: the window says which part of the launcher is being put in place.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; BeforeInstall: FileStarted

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

{ The window's pictures are drawn at 1x, 2x and 3x so they stay sharp: the one nearest to the
  screen's scale is used (2x already from 125 %). }
function PictureScale: Integer;
begin
  Result := 1;
  if ScaleX(100) > 112 then Result := 2;
  if ScaleX(100) >= 250 then Result := 3;
end;

type
  TMsg = record
    Wnd: HWND;
    Message: LongWord;
    WParam: Longint;
    LParam: Longint;
    Time: DWORD;
    Point: TPoint;
  end;

function SetTimer(Wnd: LongWord; IDEvent, Elapse: LongWord; TimerFunc: LongWord): LongWord;
  external 'SetTimer@user32.dll stdcall';
function KillTimer(Wnd: LongWord; IDEvent: LongWord): BOOL;
  external 'KillTimer@user32.dll stdcall';
function SetWindowRgn(Wnd: HWND; Region: LongWord; Redraw: BOOL): Integer;
  external 'SetWindowRgn@user32.dll stdcall';
function CreateRoundRectRgn(Left, Top, Right, Bottom, WidthEllipse, HeightEllipse: Integer): LongWord;
  external 'CreateRoundRectRgn@gdi32.dll stdcall';
function BitBlt(DestDC: LongWord; X, Y, Width, Height: Integer; SourceDC: LongWord; SourceX, SourceY: Integer; Rop: DWORD): BOOL;
  external 'BitBlt@gdi32.dll stdcall';
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
function PeekMessage(var Msg: TMsg; Wnd: HWND; FilterMin, FilterMax, Remove: LongWord): BOOL;
  external 'PeekMessageW@user32.dll stdcall';
function TranslateMessage(const Msg: TMsg): BOOL;
  external 'TranslateMessage@user32.dll stdcall';
function DispatchMessage(const Msg: TMsg): Longint;
  external 'DispatchMessageW@user32.dll stdcall';

const
  SC_CLOSE = $F060;
  MF_BYCOMMAND = 0;
  MF_ENABLED = 0;
  FR_PRIVATE = $10;
  GWL_EXSTYLE = -20;
  WS_EX_COMPOSITED = $02000000;
  SRCCOPY = $00CC0020;
  PM_REMOVE = 1;
  SoftTextColor = $D8BBC4;   { #c4bbd8 }
  AccentTextColor = $FFA0BE; { #bea0ff }

{ Waits while the window keeps drawing and its timers keep running (Sleep would freeze it). }
procedure WaitDrawing(Ms: DWORD);
var
  Start: DWORD;
  Msg: TMsg;
begin
  Start := GetTickCount;
  while GetTickCount - Start < Ms do
  begin
    while PeekMessage(Msg, 0, 0, 0, PM_REMOVE) do
    begin
      TranslateMessage(Msg);
      DispatchMessage(Msg);
    end;
    Sleep(15);
  end;
end;

{ ---------------------------------------------------------------------------------------------
  An update from the launcher: no pages and no buttons, only a small window in the launcher's soft
  look, like a splash screen. It is one picture (make-update-art.ps1) over the wizard's own
  controls; the bar is a second picture shown as far as the install has got, and a third one, the
  pill's round end, stands at the edge of what is shown. Under the title one line says what is
  being done right now, with the percentage at its right, and the X bobs like the launcher's
  loading mark (a strip of frames, one shown after another by a timer).
  --------------------------------------------------------------------------------------------- }
const
  UpdateFillLeft = 104;
  UpdateFillTop = 92;
  UpdateStatusLeft = 104;
  UpdateStatusTop = 56;
  UpdateStatusWidth = 352;
  UpdateStatusHeight = 24;
  UpdateMarkLeft = 14;
  UpdateMarkTop = 14;
  UpdateMarkFrames = 24;
  UpdateMarkPeriod = 1100;
  UpdateCorner = 8;
  DWMWA_WINDOW_CORNER_PREFERENCE = 33;
  DWMWA_BORDER_COLOR = 34;
  DWMWCP_ROUND = 2;

var
  UpdateBack, UpdateFill, UpdateCap, UpdateStatus, UpdateStatusWork, UpdateMark, UpdateMarkStrip: TBitmapImage;
  UpdateScale: Integer;
  UpdateShownStep: String;
  UpdateShownPercent, UpdateMarkFrame: Integer;
  UpdateStart: DWORD;

{ Round corners: Windows 11 draws them itself, smooth, with a thin edge in the panel's light violet;
  an older Windows gets the window cut to the same shape. }
procedure RoundUpdateWindowCorners;
var
  Value: DWORD;
  Radius: Integer;
begin
  Value := DWMWCP_ROUND;
  if DwmSetWindowAttribute(WizardForm.Handle, DWMWA_WINDOW_CORNER_PREFERENCE, Value, 4) = 0 then
  begin
    Value := $00503A45;  { #453a50 }
    DwmSetWindowAttribute(WizardForm.Handle, DWMWA_BORDER_COLOR, Value, 4);
    Exit;
  end;
  Radius := UpdateCorner * UpdateScale;
  { The window owns the region from here on. }
  SetWindowRgn(WizardForm.Handle, CreateRoundRectRgn(0, 0, WizardForm.ClientWidth + 1, WizardForm.ClientHeight + 1, Radius * 2, Radius * 2), True);
end;

{ The line under the title: what is being done, in Tiny5 over the window's own background, and the
  percentage at the right (none when Percent < 0). Written again only when something changed. The
  words go on a hidden copy first and the whole line is then copied into the shown one: a picture
  written on with its own canvas while shown kept showing what it had before. }
procedure ShowUpdateStatus(const Step: String; Percent: Integer);
var
  Canvas: TCanvas;
  Text: String;
  W, H: Integer;
begin
  if (Step = UpdateShownStep) and (Percent = UpdateShownPercent) then
    Exit;
  UpdateShownStep := Step;
  UpdateShownPercent := Percent;
  Canvas := UpdateStatusWork.Bitmap.Canvas;
  W := UpdateStatus.Bitmap.Width;
  H := UpdateStatus.Bitmap.Height;
  { The window's picture under this place, then the words over it. }
  BitBlt(Canvas.Handle, 0, 0, W, H, UpdateBack.Bitmap.Canvas.Handle, UpdateStatus.Left, UpdateStatus.Top, SRCCOPY);
  Canvas.Brush.Style := bsClear;
  Canvas.Font.Name := 'Tiny5';
  Canvas.Font.Height := -16 * UpdateScale;
  Canvas.Font.Color := SoftTextColor;
  Canvas.TextOut(0, (H - Canvas.TextHeight(Step)) div 2, Step);
  if Percent >= 0 then
  begin
    Text := IntToStr(Percent) + '%';
    Canvas.Font.Color := AccentTextColor;
    Canvas.TextOut(W - Canvas.TextWidth(Text), (H - Canvas.TextHeight(Text)) div 2, Text);
  end;
  BitBlt(UpdateStatus.Bitmap.Canvas.Handle, 0, 0, W, H, Canvas.Handle, 0, 0, SRCCOPY);
  UpdateStatus.Invalidate;
end;

{ The X: the frame of the strip for this moment of the bob. }
procedure ShowUpdateMark;
var
  Frame, W: Integer;
begin
  Frame := ((GetTickCount - UpdateStart) mod UpdateMarkPeriod) * UpdateMarkFrames div UpdateMarkPeriod;
  if Frame = UpdateMarkFrame then
    Exit;
  UpdateMarkFrame := Frame;
  W := UpdateMark.Bitmap.Width;
  BitBlt(UpdateMark.Bitmap.Canvas.Handle, 0, 0, W, UpdateMark.Bitmap.Height, UpdateMarkStrip.Bitmap.Canvas.Handle, Frame * W, 0, SRCCOPY);
  UpdateMark.Invalidate;
end;

{ ---------------------------------------------------------------------------------------------
  The usual install: Setup's own pages stay underneath, hidden by a panel with the pictures of
  art\setup-ui (make-setup-art.ps1; setup-layout.iss says where each one stands, at 1x). Three
  screens: install (folder, desktop shortcut, "Установить"), installing (what is being done, the
  percentage, the bar) and done ("Закрыть", "Запустить"). The folder and the line with what is being
  done are written by Setup itself in the launcher's pixel font. Buttons light up under the mouse (a
  timer looks where it is); their pictures are bigger than the buttons, for the soft shadow, so a
  click is taken only on the button itself.
  --------------------------------------------------------------------------------------------- }
#include "art\setup-layout.iss"

const
  ScreenInstall = 0;
  ScreenProgress = 1;
  ScreenDone = 2;
  FieldColor = $27171C;      { #1c1727, the folder field }
  PanelColor = $362027;      { #272036, the panels }

type
  TSetupButton = record
    Normal, Hover, Hit: TBitmapImage;
    X, Y, W, H: Integer;
  end;

var
  Screen: TPanel;
  Scale: Integer;
  ShownScreen: Integer;
  PanelInstall, PanelProgress, PanelDone: TBitmapImage;
  ChangeButton, InstallButton, CloseButton, RunButton: TSetupButton;
  CheckOn, CheckOff, CheckHit: TBitmapImage;
  PathText, StatusText, SetupFill, SetupCap: TBitmapImage;
  SetupShownStep: String;
  SetupShownPercent: Integer;
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

{ An empty place over the window, at 1x coordinates: to click on, or for Setup to write into. }
function Place(X, Y, W, H: Integer): TBitmapImage;
begin
  Result := TBitmapImage.Create(WizardForm);
  Result.Parent := Screen;
  Result.BackColor := clNone;
  Result.SetBounds(X * Scale, Y * Scale, W * Scale, H * Scale);
end;

{ A button: its picture and its lit picture at (X, Y), clicked on its own box. }
procedure MakeButton(var Button: TSetupButton; const Name: String; X, Y, BoxX, BoxY, BoxW, BoxH: Integer; Click: TNotifyEvent);
begin
  Button.X := BoxX * Scale; Button.Y := BoxY * Scale; Button.W := BoxW * Scale; Button.H := BoxH * Scale;
  Button.Normal := Part(Name, X, Y);
  Button.Hover := Part(Name + '-hover', X, Y);
  Button.Hover.Visible := False;
  Button.Hit := Place(BoxX, BoxY, BoxW, BoxH);
  Button.Hit.Cursor := crHand;
  Button.Hit.OnClick := Click;
end;

procedure ShowButton(var Button: TSetupButton; Visible: Boolean);
begin
  Button.Normal.Visible := Visible;
  Button.Hover.Visible := False;
  Button.Hit.Visible := Visible;
  if Visible then
    Button.Hit.BringToFront;
end;

{ A place Setup writes into: an empty picture of that size. }
function TextPlace(X, Y, W, H: Integer): TBitmapImage;
begin
  Result := Place(X, Y, W, H);
  Result.Bitmap.Width := W * Scale;
  Result.Bitmap.Height := H * Scale;
end;

{ Text in Tiny5 on a solid background, left aligned, vertically centred; and, when it is given, a
  second text right aligned in the accent colour. }
procedure WriteText(Target: TBitmapImage; const Text: String; Background, Color: TColor; const Right: String);
var
  R: TRect;
  Canvas: TCanvas;
begin
  Canvas := Target.Bitmap.Canvas;
  Canvas.Brush.Color := Background;
  Canvas.Brush.Style := bsSolid;
  R.Left := 0; R.Top := 0; R.Right := Target.Bitmap.Width; R.Bottom := Target.Bitmap.Height;
  Canvas.FillRect(R);
  Canvas.Brush.Style := bsClear;
  Canvas.Font.Name := 'Tiny5';
  Canvas.Font.Height := -16 * Scale;
  Canvas.Font.Color := Color;
  Canvas.TextOut(0, (R.Bottom - Canvas.TextHeight(Text)) div 2, Text);
  if Right <> '' then
  begin
    Canvas.Font.Color := AccentTextColor;
    Canvas.TextOut(R.Right - Canvas.TextWidth(Right), (R.Bottom - Canvas.TextHeight(Right)) div 2, Right);
  end;
  Target.Invalidate;
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
  WriteText(PathText, Shown, FieldColor, SoftTextColor, '');
end;

{ The line over the bar: what is being done and the percentage (none when Percent < 0), written
  only when it changes. Its place is made when the bar first shows: one made while hidden showed
  leftover pixels instead of the text. }
procedure ShowSetupStatus(const Step: String; Percent: Integer);
var
  Text: String;
begin
  if StatusText = nil then
  begin
    StatusText := TextPlace(SetupStatusX, SetupStatusY, SetupStatusW, SetupStatusH);
    SetupShownPercent := -2;
  end;
  if (Step = SetupShownStep) and (Percent = SetupShownPercent) then
    Exit;
  SetupShownStep := Step;
  SetupShownPercent := Percent;
  Text := '';
  if Percent >= 0 then
    Text := IntToStr(Percent) + '%';
  WriteText(StatusText, Step, PanelColor, SoftTextColor, Text);
end;

procedure ShowScreen(Which: Integer);
begin
  ShownScreen := Which;
  PanelInstall.Visible := Which = ScreenInstall;
  ShowButton(ChangeButton, Which = ScreenInstall);
  ShowButton(InstallButton, Which = ScreenInstall);
  CheckOn.Visible := (Which = ScreenInstall) and DesktopIcon;
  CheckOff.Visible := (Which = ScreenInstall) and not DesktopIcon;
  CheckHit.Visible := Which = ScreenInstall;
  PathText.Visible := Which = ScreenInstall;
  PanelProgress.Visible := Which = ScreenProgress;
  if Which = ScreenProgress then
    ShowSetupStatus('Готовимся…', -1);
  if StatusText <> nil then
    StatusText.Visible := Which = ScreenProgress;
  SetupFill.Visible := Which = ScreenProgress;
  if Which <> ScreenProgress then
    SetupCap.Visible := False;
  PanelDone.Visible := Which = ScreenDone;
  ShowButton(CloseButton, Which = ScreenDone);
  ShowButton(RunButton, Which = ScreenDone);
end;

{ A button lights up while the mouse is over it. }
procedure UpdateHover(var Button: TSetupButton; const Point: TPoint);
var
  Over: Boolean;
begin
  if not Button.Hit.Visible then
    Exit;
  Over := (Point.X >= Button.X) and (Point.X < Button.X + Button.W) and (Point.Y >= Button.Y) and (Point.Y < Button.Y + Button.H);
  if Button.Hover.Visible <> Over then
  begin
    Button.Hover.Visible := Over;
    Button.Normal.Visible := not Over;
  end;
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

{ ---------------------------------------------------------------------------------------------
  What is being done and the bar, in both windows. The bar moves in jerks, like a real download:
  it waits a moment while files go in, then jumps to where the install really is; now and then it
  waits longer and leaps.
  --------------------------------------------------------------------------------------------- }
var
  CurrentStep: String;
  BarFill, BarCap: TBitmapImage;
  BarFull, BarBlock: Integer;
  ShownProgress, TargetProgress: Integer;  { per mille }
  JumpAt, JumpDelay: DWORD;

procedure ShowStatus(const Step: String; Percent: Integer);
begin
  if UpdateStatus <> nil then
    ShowUpdateStatus(Step, Percent)
  else if ShownScreen = ScreenProgress then
    ShowSetupStatus(Step, Percent);
end;

{ Before each file of the launcher: which part of it that is, in plain words. }
procedure FileStarted;
var
  Name, Kind: String;
begin
  Name := Lowercase(CurrentFileName);
  Kind := ExtractFileExt(Name);
  if Pos('\resources\', Name) > 0 then
  begin
    if IsUpdateRelaunch then
      CurrentStep := 'Ставим новую версию'
    else
      CurrentStep := 'Ставим сам лаунчер';
  end
  else if Pos('\locales\', Name) > 0 then
    CurrentStep := 'Ставим языки'
  else if Kind = '.exe' then
    CurrentStep := 'Ставим основу программы'
  else if Kind = '.dll' then
    CurrentStep := 'Ставим графику и видео'
  else
    CurrentStep := 'Ставим ресурсы окна';
  ShowStatus(CurrentStep, ShownProgress div 10);
end;

{ The bar as far as ShownProgress, with the round end at its edge; nothing until the pill is as long
  as both of its round ends, and the whole bar (its own round end) once the cap would reach the
  track's end. }
procedure DrawProgress;
var
  Width: Integer;
begin
  Width := BarFull * ShownProgress div 1000;
  if Width < 2 * BarBlock then
    Width := 0
  else if Width > BarFull - BarBlock then
    Width := BarFull;
  BarFill.Width := Width;
  BarCap.Left := BarFill.Left + Width - BarBlock;
  BarCap.Visible := (Width > 0) and (Width < BarFull);
end;

{ Moves the bar to where the install is, once its pause is over (at once when Force). }
procedure MoveProgress(Force: Boolean);
begin
  if (BarFill = nil) or (ShownProgress = TargetProgress) then
    Exit;
  if (UpdateFill = nil) and (ShownScreen <> ScreenProgress) then
    Exit;
  if not Force and (GetTickCount - JumpAt < JumpDelay) then
    Exit;
  ShownProgress := TargetProgress;
  JumpAt := GetTickCount;
  { Mostly a short pause, sometimes a long one, after which the bar leaps far ahead. }
  if Random(4) = 0 then
    JumpDelay := 1100 + Random(900)
  else
    JumpDelay := 250 + Random(550);
  DrawProgress;
  if CurrentStep <> '' then
    ShowStatus(CurrentStep, ShownProgress div 10);
end;

procedure OnUpdateTimer(Wnd: LongWord; Msg: LongWord; IDEvent: LongWord; Time: LongWord);
begin
  ShowUpdateMark;
  MoveProgress(False);
end;

procedure OnHoverTimer(Wnd: LongWord; Msg: LongWord; IDEvent: LongWord; Time: LongWord);
var
  Point: TPoint;
begin
  MoveProgress(False);
  if not GetCursorPos(Point) then
    Exit;
  ScreenToClient(Screen.Handle, Point);
  UpdateHover(ChangeButton, Point);
  UpdateHover(InstallButton, Point);
  UpdateHover(CloseButton, Point);
  UpdateHover(RunButton, Point);
end;

{ --------------------------------------------------------------------------------------------- }

var
  UpdateTimer: LongWord;

procedure BuildUpdateWindow;
var
  Cover: TPanel;
  Suffix: String;
begin
  UpdateScale := PictureScale;
  Suffix := IntToStr(UpdateScale) + 'x.bmp';
  ExtractTemporaryFile('update-bg-' + Suffix);
  ExtractTemporaryFile('update-fill-' + Suffix);
  ExtractTemporaryFile('update-cap-' + Suffix);
  ExtractTemporaryFile('update-mark-' + Suffix);
  { The launcher's pixel font, for this process only. }
  ExtractTemporaryFile('Tiny5.ttf');
  AddFontResourceEx(ExpandConstant('{tmp}\Tiny5.ttf'), FR_PRIVATE, 0);

  { Pictures are drawn under the wizard's windowed controls, so they sit on a panel above them. }
  Cover := TPanel.Create(WizardForm);
  Cover.Parent := WizardForm;
  Cover.BevelOuter := bvNone;
  UpdateBack := TBitmapImage.Create(WizardForm);
  UpdateBack.Parent := Cover;
  UpdateBack.Bitmap.LoadFromFile(ExpandConstant('{tmp}\update-bg-' + Suffix));
  WizardForm.BorderStyle := bsNone;
  WizardForm.ClientWidth := UpdateBack.Bitmap.Width;
  WizardForm.ClientHeight := UpdateBack.Bitmap.Height;
  WizardForm.Position := poScreenCenter;
  Cover.SetBounds(0, 0, UpdateBack.Bitmap.Width, UpdateBack.Bitmap.Height);
  Cover.BringToFront;
  UpdateBack.SetBounds(0, 0, UpdateBack.Bitmap.Width, UpdateBack.Bitmap.Height);

  { The strip of frames is only read from; the place of the X shows one of them. }
  UpdateMarkStrip := TBitmapImage.Create(WizardForm);
  UpdateMarkStrip.Bitmap.LoadFromFile(ExpandConstant('{tmp}\update-mark-' + Suffix));
  UpdateMark := TBitmapImage.Create(WizardForm);
  UpdateMark.Parent := Cover;
  UpdateMark.SetBounds(UpdateMarkLeft * UpdateScale, UpdateMarkTop * UpdateScale, UpdateMarkStrip.Bitmap.Width div UpdateMarkFrames, UpdateMarkStrip.Bitmap.Height);
  UpdateMark.Bitmap.Width := UpdateMark.Width;
  UpdateMark.Bitmap.Height := UpdateMark.Height;
  UpdateMark.BringToFront;
  UpdateStart := GetTickCount;
  UpdateMarkFrame := -1;
  ShowUpdateMark;

  UpdateStatus := TBitmapImage.Create(WizardForm);
  UpdateStatus.Parent := Cover;
  UpdateStatus.SetBounds(UpdateStatusLeft * UpdateScale, UpdateStatusTop * UpdateScale, UpdateStatusWidth * UpdateScale, UpdateStatusHeight * UpdateScale);
  UpdateStatus.Bitmap.Width := UpdateStatus.Width;
  UpdateStatus.Bitmap.Height := UpdateStatus.Height;
  UpdateStatus.BringToFront;
  UpdateStatusWork := TBitmapImage.Create(WizardForm);
  UpdateStatusWork.Bitmap.Width := UpdateStatus.Width;
  UpdateStatusWork.Bitmap.Height := UpdateStatus.Height;
  UpdateShownPercent := -2;
  { Setup first waits for the launcher to close (it quits right after starting the update). }
  ShowUpdateStatus('Закрываем старую версию…', -1);

  UpdateFill := TBitmapImage.Create(WizardForm);
  UpdateFill.Parent := Cover;
  UpdateFill.Stretch := False;
  UpdateFill.Center := False;
  UpdateFill.Bitmap.LoadFromFile(ExpandConstant('{tmp}\update-fill-' + Suffix));
  UpdateFill.SetBounds(UpdateFillLeft * UpdateScale, UpdateFillTop * UpdateScale, 0, UpdateFill.Bitmap.Height);
  UpdateFill.BringToFront;

  UpdateCap := TBitmapImage.Create(WizardForm);
  UpdateCap.Parent := Cover;
  UpdateCap.Bitmap.LoadFromFile(ExpandConstant('{tmp}\update-cap-' + Suffix));
  UpdateCap.SetBounds(UpdateFill.Left, UpdateFill.Top, UpdateCap.Bitmap.Width, UpdateCap.Bitmap.Height);
  UpdateCap.Visible := False;
  UpdateCap.BringToFront;
  BarFill := UpdateFill;
  BarCap := UpdateCap;
  BarFull := UpdateFill.Bitmap.Width;
  BarBlock := UpdateCap.Bitmap.Width;

  { Drawn off screen first and shown at once: the X and the growing bar do not flicker. }
  SetWindowLong(Cover.Handle, GWL_EXSTYLE, GetWindowLong(Cover.Handle, GWL_EXSTYLE) or WS_EX_COMPOSITED);
  RoundUpdateWindowCorners;
  UpdateTimer := SetTimer(0, 0, 30, CreateCallback(@OnUpdateTimer));
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
  MakeButton(ChangeButton, 'btn-change', SetupBtnChangeX, SetupBtnChangeY, SetupBtnChangeBoxX, SetupBtnChangeBoxY, SetupBtnChangeBoxW, SetupBtnChangeBoxH, @ChangeFolderClick);
  CheckOn := Part('check-on', SetupCheckOnX, SetupCheckOnY);
  CheckOff := Part('check-off', SetupCheckOffX, SetupCheckOffY);
  { The tick and its words are one place to click. }
  CheckHit := Place(SetupCheckHitX, SetupCheckHitY, SetupCheckHitW, SetupCheckHitH);
  CheckHit.Cursor := crHand;
  CheckHit.OnClick := @DesktopIconClick;
  MakeButton(InstallButton, 'btn-install', SetupBtnInstallX, SetupBtnInstallY, SetupBtnInstallBoxX, SetupBtnInstallBoxY, SetupBtnInstallBoxW, SetupBtnInstallBoxH, @InstallClick);

  PanelProgress := Part('panel-progress', SetupPanelProgressX, SetupPanelProgressY);
  SetupFill := Part('fill', SetupFillX, SetupFillY);
  SetupFill.Stretch := False;
  SetupFill.Center := False;
  SetupFill.Width := 0;
  SetupCap := Part('cap', SetupFillX, SetupFillY);
  SetupCap.Visible := False;
  BarFill := SetupFill;
  BarCap := SetupCap;
  BarFull := SetupFill.PngImage.Width;
  BarBlock := SetupCap.PngImage.Width;

  PanelDone := Part('panel-done', SetupPanelDoneX, SetupPanelDoneY);
  MakeButton(CloseButton, 'btn-close', SetupBtnCloseX, SetupBtnCloseY, SetupBtnCloseBoxX, SetupBtnCloseBoxY, SetupBtnCloseBoxW, SetupBtnCloseBoxH, @CloseClick);
  MakeButton(RunButton, 'btn-run', SetupBtnRunX, SetupBtnRunY, SetupBtnRunBoxX, SetupBtnRunBoxY, SetupBtnRunBoxW, SetupBtnRunBoxH, @RunClick);

  ShowFolder;
  ShowScreen(ScreenInstall);
  { Drawn off screen first and shown at once: the growing bar and the text do not flicker. }
  SetWindowLong(Screen.Handle, GWL_EXSTYLE, GetWindowLong(Screen.Handle, GWL_EXSTYLE) or WS_EX_COMPOSITED);
  HoverTimer := SetTimer(0, 0, 40, CreateCallback(@OnHoverTimer));

  { Windows 11: the title bar in the launcher's violet-black instead of grey. }
  Color := $000F080A;
  DwmSetWindowAttribute(WizardForm.Handle, 35, Color, 4);
  Color := $00EAD2D9;
  DwmSetWindowAttribute(WizardForm.Handle, 36, Color, 4);
end;

{ ---------------------------------------------------------------------------------------------
  Setup offers the folder of the last install. Two kinds of it are left: the launcher used to be
  called RichLauncher, then Vanilla+ Launcher, and its folder was named after it; and the first
  launchers were put right in Documents (Documents\RichLauncher, later Documents\Amethyx). A folder
  in Documents gives way to Programs\Amethyx, an old name elsewhere to a folder called Amethyx next
  to it. Once the launcher is installed there, the old copy of the program goes (only when the
  folder really holds one: its program and resources\app.asar; the games, packs and settings live
  in %APPDATA% and are not there), the shortcuts to it lead to the new one, and a launcher still
  open from it is closed first like one open from the install folder.
  --------------------------------------------------------------------------------------------- }
var
  OldAppDir: String;

function HasOldName(const Dir: String): Boolean;
var
  Name: String;
begin
  Name := Lowercase(ExtractFileName(RemoveBackslashUnlessRoot(Dir)));
  Result := (Name = 'richlauncher') or (Name = 'vanillaplus') or (Name = 'vanilla+') or (Name = 'vanilla+ launcher');
end;

{ The launcher's own folder right in Documents: where Windows has it now, or the usual one in the
  user's folder (Documents may have been moved to OneDrive since). }
function InDocuments(const Dir: String): Boolean;
var
  Parent: String;
begin
  Result := False;
  if not HasOldName(Dir) and (CompareText(ExtractFileName(Dir), 'Amethyx') <> 0) then
    Exit;
  Parent := ExtractFileDir(Dir);
  Result := (CompareText(Parent, RemoveBackslashUnlessRoot(ExpandConstant('{userdocs}'))) = 0) or
    (CompareText(Parent, GetEnv('USERPROFILE') + '\Documents') = 0);
end;

procedure LeaveOldFolder;
var
  Dir: String;
begin
  { Only the folder of the last install: one given with /DIR stays as it is. }
  Dir := RemoveBackslashUnlessRoot(WizardForm.DirEdit.Text);
  if (WizardForm.PrevAppDir = '') or (CompareText(Dir, RemoveBackslashUnlessRoot(WizardForm.PrevAppDir)) <> 0) then
    Exit;
  if InDocuments(Dir) then
    WizardForm.DirEdit.Text := ExpandConstant('{#DefaultDir}')
  else if HasOldName(Dir) then
    WizardForm.DirEdit.Text := AddBackslash(ExtractFileDir(Dir)) + 'Amethyx'
  else
    Exit;
  OldAppDir := Dir;
  { An update makes no desktop shortcut, but one that is there is made anew for the new folder. }
  DesktopIcon := FileExists(ExpandConstant('{autodesktop}\{#AppName}.lnk'));
end;

{ The old copy's programs, for Setup to close before it installs (CloseApplications). }
procedure RegisterExtraCloseApplicationsResources;
begin
  if OldAppDir = '' then
    Exit;
  RegisterExtraCloseApplicationsResource(False, OldAppDir + '\Amethyx.exe');
  RegisterExtraCloseApplicationsResource(False, OldAppDir + '\VanillaPlus.exe');
  RegisterExtraCloseApplicationsResource(False, OldAppDir + '\RichLauncher.exe');
end;

{ A path into the old copy, as the same path into the new one. }
function MovedPath(const Path: String): String;
var
  Old: String;
begin
  Old := AddBackslash(OldAppDir);
  Result := Path;
  if CompareText(Copy(Path, 1, Length(Old)), Old) = 0 then
    Result := ExpandConstant('{app}\') + Copy(Path, Length(Old) + 1, Length(Path));
end;

{ Shortcuts in Folder to the old copy (made by hand or pinned) lead to the new one, their
  arguments kept. }
procedure MoveShortcuts(const Folder: String);
var
  Find: TFindRec;
  Shell, Link: Variant;
  Target: String;
begin
  if not FindFirst(AddBackslash(Folder) + '*.lnk', Find) then
    Exit;
  try
    Shell := CreateOleObject('WScript.Shell');
    repeat
      Link := Shell.CreateShortcut(AddBackslash(Folder) + Find.Name);
      Target := Link.TargetPath;
      if MovedPath(Target) <> Target then
      begin
        Link.TargetPath := MovedPath(Target);
        Link.WorkingDirectory := MovedPath(Link.WorkingDirectory);
        Link.IconLocation := MovedPath(Link.IconLocation);
        Link.Save;
      end;
    until not FindNext(Find);
  except
    Log('Shortcuts in ' + Folder + ' not moved: ' + GetExceptionMessage);
  end;
  FindClose(Find);
end;

procedure RemoveOldCopy;
begin
  if (OldAppDir = '') or (CompareText(OldAppDir, RemoveBackslashUnlessRoot(ExpandConstant('{app}'))) = 0) then
    Exit;
  MoveShortcuts(ExpandConstant('{autodesktop}'));
  MoveShortcuts(ExpandConstant('{userappdata}\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'));
  if not FileExists(OldAppDir + '\resources\app.asar') then
    Exit;
  if FileExists(OldAppDir + '\RichLauncher.exe') or FileExists(OldAppDir + '\VanillaPlus.exe') or FileExists(OldAppDir + '\Amethyx.exe') then
    DelTree(OldAppDir, True, True, True);
end;

{ --------------------------------------------------------------------------------------------- }

procedure InitializeWizard;
begin
  LeaveOldFolder;
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
    RoundUpdateWindowCorners;
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
          ShowSetupStatus('Закрываем открытый лаунчер…', -1);
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
begin
  if MaxProgress <= 0 then
    Exit;
  { In 64 bits: the progress counts bytes and would overflow an Integer once multiplied. }
  Done := CurProgress;
  TargetProgress := Done * 1000 div MaxProgress;
  MoveProgress(False);
end;

{ All files are in place: the bar fills up. An update has started the launcher already ([Run] comes
  before this step); its window says so and stays a moment, the X still bobbing, so it can be read. }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then
    Exit;
  RemoveOldCopy;
  TargetProgress := 1000;
  MoveProgress(True);
  if UpdateStatus <> nil then
  begin
    ShowUpdateStatus('Готово! Открываем лаунчер…', -1);
    WaitDrawing(900);
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
  if UpdateTimer <> 0 then
    KillTimer(0, UpdateTimer);
end;
