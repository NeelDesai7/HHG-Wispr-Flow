// Vachan desktop shell.
//
// This is the thing that makes Vachan truly hands-free: it launches at login, boots the
// existing Vachan server (the whole on-device brain — Gemma, tasks, habits, calendar, privacy
// screening — unchanged), and lives in the system tray. There is no tab to keep open and no
// button to press. The background listener (added in a later step) feeds the mic through an
// on-device transcriber into this same server. Nothing leaves the laptop.

const { app, BrowserWindow, Tray, Menu, nativeImage, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT) || 5181;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Where the vachan project lives: next to desktop/ in dev, under resources/ once installed.
const SERVER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'vachan') : path.join(__dirname, '..');
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js');
// The server needs Node ≥22.5 for node:sqlite. Installed, we run the node.exe we bundle in resources;
// in dev we use the node.exe on PATH (the user's v24).
const NODE_BIN = app.isPackaged
  ? path.join(process.resourcesPath, 'node.exe')
  : (process.platform === 'win32' ? 'node.exe' : 'node');
// Program Files is read-only, so the installed app keeps its SQLite db + settings under the user's
// profile (userData). In dev the server uses its own data/ folder.
const DATA_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'data') : null;

// On-device speech-to-text. Electron owns this process so it is reliably stopped on quit (on
// Windows a killed parent does not take its children down), and tells the server its URL.
const WHISPER_PORT = Number(process.env.WHISPER_PORT) || 5182;
const WHISPER_URL = `http://127.0.0.1:${WHISPER_PORT}`;
const WHISPER_BIN_CUDA = path.join(SERVER_DIR, 'vendor', 'whisper', 'bin-cuda', 'Release', 'whisper-server.exe');
const WHISPER_BIN_CPU = path.join(SERVER_DIR, 'vendor', 'whisper', 'bin', 'Release', 'whisper-server.exe');
const WHISPER_BIN = fs.existsSync(WHISPER_BIN_CUDA) ? WHISPER_BIN_CUDA : WHISPER_BIN_CPU; // GPU build wins
const WHISPER_MODEL = path.join(SERVER_DIR, 'vendor', 'whisper', 'models', 'ggml-small.bin');

let serverProc = null;
let whisperProc = null;
let win = null;
let listenerWin = null;
let tray = null;
let quitting = false;

// A hidden window may capture the microphone without a user gesture — Vachan is meant to just
// listen. (This only relaxes autoplay inside our own app; it changes nothing in any browser.)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── on-device transcriber (whisper.cpp), started before the server that calls it ──
function whisperInstalled() { return fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL); }
function startWhisper() {
  if (whisperProc || !whisperInstalled()) return;
  whisperProc = spawn(WHISPER_BIN, ['-m', WHISPER_MODEL, '--host', '127.0.0.1', '--port', String(WHISPER_PORT)],
    { cwd: path.dirname(WHISPER_BIN), stdio: 'ignore', windowsHide: true });
  whisperProc.on('exit', () => { whisperProc = null; });
}

// ── boot the existing Vachan server as a child (real Node, so node:sqlite works) ──
function startServer() {
  if (serverProc) return;
  const env = { ...process.env, PORT: String(PORT), VACHAN_DESKTOP: '1' };
  if (whisperInstalled()) env.WHISPER_URL = WHISPER_URL; // the server HTTP-calls this on-device STT
  if (DATA_DIR) env.VACHAN_DATA_DIR = DATA_DIR; // installed: write the db under the user's profile
  serverProc = spawn(NODE_BIN,
    ['--disable-warning=ExperimentalWarning', SERVER_ENTRY],
    { cwd: SERVER_DIR, env, stdio: 'inherit' });
  serverProc.on('exit', (code) => {
    serverProc = null;
    if (!quitting) console.error(`[vachan] server exited (${code}); it will not restart automatically`);
  });
}

// Poll the health endpoint until the server answers, so we never load a blank window.
function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const r = http.get(`${ORIGIN}/api/health`, (res) => { res.resume(); resolve(); });
      r.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error('server did not start'));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

const ICON_PATH = path.join(__dirname, 'tray.png');
function trayIcon() {
  const img = nativeImage.createFromPath(ICON_PATH);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Vachan — listening on-device');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Vachan', click: showWindow },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit Vachan', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

// The always-on ears: a hidden window that holds the microphone and streams clips of speech to
// the server. It keeps running at full rate even when nothing is shown (backgroundThrottling off),
// so Vachan hears you whether or not the main window is open.
function startListener() {
  if (listenerWin) return;
  listenerWin = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  listenerWin.loadURL(`${ORIGIN}/listener.html`);
  listenerWin.on('closed', () => { listenerWin = null; });
}

function showWindow() {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 720, minHeight: 520,
    title: 'Vachan', backgroundColor: '#0b0d10', autoHideMenuBar: true,
    icon: ICON_PATH,
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(ORIGIN);
  // Keep Vachan alive in the tray when the window is closed — it must keep listening.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  // Open external links (e.g. the Ollama model page) in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) return { action: 'allow' };
    shell.openExternal(url); return { action: 'deny' };
  });
}

// Only ever one Vachan running.
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // Grant the mic to our own loopback origin only — needed for the background listener later.
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'media' && wc.getURL().startsWith(ORIGIN));
    });

    // Start listening at login by default; the user never has to arrange this.
    if (!app.getLoginItemSettings().openAtLogin) app.setLoginItemSettings({ openAtLogin: true });

    startWhisper(); // begin loading the model now so the first clip is fast
    startServer();
    buildTray();
    try { await waitForServer(); } catch (err) { console.error('[vachan]', err.message); }
    startListener(); // begin listening on its own — no window needed
    showWindow();
  });

  // Tray app: don't quit when the window closes.
  app.on('window-all-closed', (e) => { if (!quitting) e.preventDefault?.(); });
  app.on('before-quit', () => { quitting = true; if (serverProc) serverProc.kill(); if (whisperProc) whisperProc.kill(); });
}
