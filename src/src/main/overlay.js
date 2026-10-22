'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { BrowserWindow, globalShortcut, screen } = require('electron');
const { appUrl, APP_SCHEME } = require('./appProtocol');
const { broadcast } = require('./core/broadcast');
const { createLogger } = require('./core/logger');
const { CHANNELS } = require('../shared/channels');
const { getSettings } = require('./settings/settingsService');

/*
 * The Amethyx panel over the game, like Steam's overlay: while the game's window is in front, a key
 * combination (Shift+Tab by default, Settings → "Друзья и скины") slides a panel in over it — call a friend
 * into the world, chat, send a screenshot — and the same keys, Esc or a click outside take it away.
 * Nothing is installed in the game, so it works with every version and loader, vanilla too.
 *
 * The panel is a transparent window over the whole screen the game is on (the game keeps the mouse
 * in its middle, so the cursor tells which screen). Taking the focus pauses a single-player game and
 * frees the mouse, as any other window would. A game in real full screen (F11) is minimised by
 * Windows while another window is in front; when the panel goes, the game is brought back.
 */

const PRELOAD_SCRIPT = path.join(__dirname, '..', 'preload', 'preload.js');
const PAGE = appUrl('src/renderer/overlay.html');
const log = createLogger('overlay');

let window = null;
/** The keys while a game runs, and whether they are taken right now (only while the game is in front). */
let shortcut = null;
let registered = false;
let warned = false;
let gamePid = null;
let shownAt = 0;
let focuser = null;
let watcher = null;
let foregroundPid = null;

function createWindow() {
  const panel = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    title: 'Amethyx',
    webPreferences: { preload: PRELOAD_SCRIPT, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) event.preventDefault();
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Clicked away (another window, the game): the panel goes, as Steam's does.
  panel.on('blur', () => {
    if (Date.now() - shownAt > 300) hide();
  });
  panel.loadURL(PAGE);
  return panel;
}

function isOpen() {
  return Boolean(window && !window.isDestroyed() && window.isVisible());
}

function show() {
  if (!window || window.isDestroyed()) window = createWindow();
  // The same keys close it again, wherever the focus is now.
  takeKeys(true);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  window.setBounds(display.bounds);
  shownAt = Date.now();
  const reveal = () => {
    if (!window || window.isDestroyed()) return;
    window.show();
    window.focus();
    window.webContents.send(CHANNELS.events.overlay, { open: true });
  };
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', reveal);
  else reveal();
}

/** Takes the panel away and gives the screen back to the game. */
function hide() {
  if (!isOpen()) return;
  window.webContents.send(CHANNELS.events.overlay, { open: false });
  // The panel slides out first (overlay.css), then the window goes.
  const panel = window;
  setTimeout(() => {
    if (!panel.isDestroyed()) panel.hide();
    focusGame();
    updateKeys();
  }, 160);
}

function toggle() {
  if (isOpen()) hide();
  else show();
}

/**
 * Windows: brings the game's window back to the front (restored if full screen minimised it). One
 * PowerShell with a few user32 calls stays ready while the game runs, so this is instant.
 */
function focusGame() {
  if (process.platform !== 'win32' || !gamePid) return;
  try {
    if (!focuser || focuser.exitCode !== null) {
      focuser = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      focuser.on('error', () => {});
      focuser.stdin.on('error', () => {});
      focuser.stdin.write(
        [
          'Add-Type -Namespace Amethyx -Name Win -MemberDefinition @"',
          '[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);',
          '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);',
          '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);',
          '"@',
          'function Focus-Game($id) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { if ([Amethyx.Win]::IsIconic($p.MainWindowHandle)) { [void][Amethyx.Win]::ShowWindow($p.MainWindowHandle, 9) }; [void][Amethyx.Win]::SetForegroundWindow($p.MainWindowHandle) } }',
          '',
        ].join('\r\n'),
      );
    }
    focuser.stdin.write(`Focus-Game ${Number(gamePid)}\r\n`);
  } catch (error) {
    log.warn(`Игра не возвращена на экран: ${error.message}`);
  }
}

/** The key combination from the settings, as Electron writes it. */
const KEYS = { 'shift-tab': 'Shift+Tab', 'alt-x': 'Alt+X', f9: 'F9' };

/** Takes the keys from the system (on) or gives them back (off). */
function takeKeys(on) {
  if (!shortcut || on === registered) return;
  if (!on) {
    globalShortcut.unregister(shortcut);
    registered = false;
    return;
  }
  try {
    registered = globalShortcut.register(shortcut, toggle);
  } catch (error) {
    registered = false;
    log.warn(`Панель поверх игры не включена: ${error.message}`);
  }
  if (!registered && !warned) {
    warned = true;
    log.warn(`Сочетание ${shortcut} занято другой программой: панель поверх игры не откроется`);
    broadcast(CHANNELS.events.overlay, { open: false, keyBusy: shortcut });
  }
}

/**
 * The keys are the panel's only while the game is in front or the panel is open: in every other
 * program Shift+Tab keeps its usual job. Without a watcher (not Windows) they stay taken while the game runs.
 */
function updateKeys() {
  if (!shortcut) return;
  takeKeys(!watcher || isOpen() || (gamePid !== null && foregroundPid === gamePid));
}

/**
 * Windows: one PowerShell tells which process owns the window in front whenever that changes
 * (checked 5 times a second, a few user32 calls).
 */
function watchForeground() {
  if (process.platform !== 'win32' || !gamePid) return;
  const script = [
    'Add-Type -Namespace Amethyx -Name Front -MemberDefinition @"',
    '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint id);',
    '"@',
    '$last = -1',
    'while ($true) { $id = [uint32]0; [void][Amethyx.Front]::GetWindowThreadProcessId([Amethyx.Front]::GetForegroundWindow(), [ref]$id); if ($id -ne $last) { $last = $id; [Console]::Out.WriteLine($id); [Console]::Out.Flush() }; Start-Sleep -Milliseconds 200 }',
  ].join('\r\n');
  try {
    const helper = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    watcher = helper;
    let buffer = '';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      const last = lines.filter(Boolean).pop();
      if (last === undefined || watcher !== helper) return;
      foregroundPid = Number(last);
      updateKeys();
    });
    // No watcher after all: the keys simply stay taken while the game runs.
    const lost = () => {
      if (watcher !== helper) return;
      watcher = null;
      updateKeys();
    };
    helper.on('error', lost);
    helper.on('exit', lost);
  } catch (error) {
    watcher = null;
    log.warn(`Окно впереди не отслеживается: ${error.message}`);
  }
}

/** A game started: the panel answers its keys while the game is in front (unless turned off in the settings). */
async function startOverlay(pid) {
  stopOverlay();
  const settings = await getSettings().catch(() => null);
  if (settings?.social?.overlay === false) return;
  gamePid = pid ?? null;
  shortcut = KEYS[settings?.social?.overlayKey] ?? KEYS['shift-tab'];
  warned = false;
  log.info(`Панель поверх игры: ${shortcut}`);
  watchForeground();
  updateKeys();
}

/** The game closed: keys free again, the panel and its helpers go. */
function stopOverlay() {
  takeKeys(false);
  shortcut = null;
  gamePid = null;
  foregroundPid = null;
  const helper = watcher;
  watcher = null;
  if (helper && helper.exitCode === null) helper.kill();
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
  if (focuser && focuser.exitCode === null) focuser.kill();
  focuser = null;
}

/** For other modules: is the panel's key on now (a game runs), and which. */
function overlayKey() {
  return shortcut;
}

module.exports = { startOverlay, stopOverlay, show, hide, toggle, isOpen, overlayKey };
