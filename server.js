// WinDrop — AirDrop-style file transfer between your iPhone/iPad (or any phone) and this PC over Wi-Fi.
// No dependencies. Usage:
//   node server.js                         run in this console and open the WinDrop window
//   node server.js --launch                start hidden in the background and open the window
//   node server.js --launch --background   start hidden with no window (used at Windows login)
//   node server.js --install               start with Windows + Desktop/Start menu shortcuts, then launch
//   node server.js --uninstall             remove those shortcuts and stop WinDrop
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const BACKGROUND = has('--background') || !!process.env.WINDROP_NO_WINDOW;

const PORT = Number(process.env.WINDROP_PORT) || 8765;
const PUBLIC = path.join(__dirname, 'public');
const SAVE_DIR = path.join(os.homedir(), 'Downloads', 'WinDrop');
const SHARE_DIR = path.join(os.tmpdir(), 'windrop-shared');
const CONFIG = path.join(__dirname, 'windrop.config.json');
const LOG = path.join(__dirname, 'windrop.log');
const HOST_NAME = os.hostname();
const MDNS_HOST = `windrop-${HOST_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pc'}.local`;
const START_MENU = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const STARTUP_LNK = path.join(START_MENU, 'Startup', 'WinDrop.lnk');
const MENU_LNK = path.join(START_MENU, 'WinDrop.lnk');
const APP_ID = 'WinDrop.FileTransfer';
const SCRIPTS = path.join(__dirname, 'scripts');

// Settings, plus the devices you have paired. A device pairs by typing the temporary code shown on
// the PC and then gets its own secret key, so it reconnects by itself and can be removed on its own.
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
const saveConfig = () => fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
config.devices = config.devices || {};
if (config.token) {
  delete config.token; // the old shared key from the QR code: phones now have to pair with a code
  saveConfig();
}

// ---------- shortcuts / start with Windows ----------
function powershell(script, env = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    windowsHide: true,
    encoding: 'utf8',
  }).trim();
}

const desktopLnk = () => path.join(powershell("[Environment]::GetFolderPath('Desktop')"), 'WinDrop.lnk');

function makeShortcut(lnk, extraArgs) {
  powershell(
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:WD_LNK);' +
    '$s.TargetPath = $env:WD_NODE; $s.Arguments = $env:WD_ARGS; $s.WorkingDirectory = $env:WD_DIR;' +
    "$s.WindowStyle = 7; $s.IconLocation = $env:WD_ICON; $s.Description = 'WinDrop - send files between your phone and this PC'; $s.Save()",
    {
      WD_LNK: lnk,
      WD_NODE: process.execPath,
      WD_ARGS: `"${__filename}" --launch ${extraArgs}`.trim(),
      WD_DIR: __dirname,
      WD_ICON: path.join(__dirname, 'windrop.ico'),
    },
  );
}

// Windows only shows notifications under an app's own name/icon if a Start menu shortcut carries its app id.
function registerAppId() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'set-app-id.ps1'), '-Lnk', MENU_LNK, '-Id', APP_ID], { windowsHide: true });
    config.appId = true;
  } catch {
    config.appId = false;
  }
  saveConfig();
}

const autostartOn = () => fs.existsSync(STARTUP_LNK);
function setAutostart(on) {
  if (on) makeShortcut(STARTUP_LNK, '--background');
  else fs.rmSync(STARTUP_LNK, { force: true });
}

if (has('--install')) {
  (async () => {
    setAutostart(true);
    makeShortcut(MENU_LNK, '');
    registerAppId();
    makeShortcut(desktopLnk(), '');
    // A copy that is already running would keep the old code; stop it so the fresh launch takes over.
    await fetch(`http://localhost:${PORT}/api/quit`, { method: 'POST' })
      .then(() => new Promise(r => setTimeout(r, 1000)), () => {});
    console.log('WinDrop will now start automatically every time you log in.');
    console.log('Shortcuts added to your Desktop and Start menu.');
    spawn(process.execPath, [__filename, '--launch'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  })();
  return;
}

if (has('--uninstall')) {
  setAutostart(false);
  fs.rmSync(MENU_LNK, { force: true });
  fs.rmSync(desktopLnk(), { force: true });
  fetch(`http://localhost:${PORT}/api/quit`, { method: 'POST' }).catch(() => {}).finally(() => {
    console.log('WinDrop removed from startup and stopped.');
  });
  return;
}

// Start a hidden copy of the server (no console window) and exit.
if (has('--launch')) {
  try { if (fs.statSync(LOG).size > 1024 * 1024) fs.rmSync(LOG); } catch {}
  const log = fs.openSync(LOG, 'a');
  spawn(process.execPath, [__filename, ...(BACKGROUND ? ['--background'] : [])], {
    detached: true,
    windowsHide: true,
    cwd: __dirname,
    stdio: ['ignore', log, log],
  }).unref();
  return;
}

// ---------- setup ----------
fs.mkdirSync(SAVE_DIR, { recursive: true });
fs.rmSync(SHARE_DIR, { recursive: true, force: true });
fs.mkdirSync(SHARE_DIR, { recursive: true });
for (const f of fs.readdirSync(SAVE_DIR)) {
  if (f.endsWith('.windrop-part')) fs.rmSync(path.join(SAVE_DIR, f), { force: true }); // left over from a crash
}

const clients = new Set();     // open event streams: { res, role, pid, device, cid, focused }
const received = [];           // recent files received from phones, newest first
const shared = [];             // files this PC offers to phones
const reserved = new Set();    // file names currently being written
const uploads = new Map();     // id -> upload in progress
const uploadKeys = new Map();  // phone's file key -> upload id (lets a phone resume after reconnecting)
const cancelled = new Set();   // upload ids cancelled on the PC

// ---------- helpers ----------
const isV4 = a => a.family === 'IPv4' || a.family === 4;

// All usable network addresses, best guess first (Wi-Fi before Ethernet, home ranges first).
function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|wsl|virtual|vmware|vbox|hyper-v|loopback|bluetooth/i.test(name)) continue;
    for (const a of addrs || []) {
      if (isV4(a) && !a.internal && !a.address.startsWith('169.254.')) found.push({ name, ip: a.address });
    }
  }
  const rank = ({ name, ip }) =>
    (/wi-?fi|wlan|wireless/i.test(name) ? 0 : 10) + (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  found.sort((a, b) => rank(a) - rank(b));
  return found.length ? found : [{ name: 'This PC only', ip: '127.0.0.1' }];
}

// The QR code only carries the address; the phone still has to type the pairing code.
const urlFor = host => `http://${host}:${PORT}/`;

// Requests arriving through the Cloudflare tunnel also come from 127.0.0.1 (cloudflared runs on this
// PC), so anything carrying Cloudflare's headers is treated as coming from the internet.
const viaInternet = req => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);

function isLocal(req) {
  if (viaInternet(req)) return false;
  const ip = req.socket.remoteAddress;
  const host = (req.headers.host || '').toLowerCase();
  const origin = req.headers.origin;
  const localHost = host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}`;
  const okOrigin = !origin || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && localHost && okOrigin;
}

function json(res, code, body) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function emit(role, type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (!role || c.role === role) c.res.write(msg);
}


// Cloudflare's free tunnel holds back live event streams, so phones on the internet poll instead
// (every few seconds). A phone counts as connected while its polls keep arriving.
const pollers = new Map(); // pid -> { device, via, viaRoom, lastSeen }
const POLL_GRACE = 12000;

function peers() {
  const byPid = new Map();
  for (const c of clients) if (c.role === 'phone') byPid.set(c.pid, { pid: c.pid, device: c.device, via: c.via });
  for (const [pid, p] of pollers) if (Date.now() - p.lastSeen < POLL_GRACE) byPid.set(pid, { pid, device: p.device, via: p.via });
  return [...byPid.values()];
}

function handlePoll(req, res, q) {
  const pid = (q.get('pid') || '').slice(0, 64);
  if (pid) {
    const fresh = !pollers.has(pid) || Date.now() - pollers.get(pid).lastSeen >= POLL_GRACE;
    pollers.set(pid, {
      device: (q.get('device') || 'Phone').slice(0, 40),
      via: viaInternet(req) ? 'internet' : 'wifi',
      viaRoom: q.get('t') === roomToken,
      token: q.get('t') || '',
      lastSeen: Date.now(),
    });
    if (fresh) emit('desktop', 'peers', peers());
  }
  json(res, 200, { host: HOST_NAME, shared });
}

setInterval(() => {
  let changed = false;
  for (const [pid, p] of pollers) if (Date.now() - p.lastSeen >= POLL_GRACE) { pollers.delete(pid); changed = true; }
  if (changed) emit('desktop', 'peers', peers());
}, 3000);

// ---------- Internet mode: room code + Cloudflare tunnel ----------
// When the phone is on a different network, cloudflared gives this PC a temporary public https
// address. Phones that open it must enter the room code before they can send or receive anything.
const CLOUDFLARED = path.join(__dirname, 'bin', 'cloudflared.exe');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L mix-ups
const internet = { on: false, status: 'off', url: null, error: null };
let roomToken = crypto.randomBytes(12).toString('hex');
let tunnelProc = null;
let tunnelRetry = 0;
const joinAttempts = [];

function newRoomCode() {
  const pick = () => Array.from(crypto.randomBytes(4), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  config.roomCode = `${pick()}-${pick()}`;
  saveConfig();
  roomToken = crypto.randomBytes(12).toString('hex');
  dropRoomGuests();
}

// Disconnect phones that joined with the room code (used when the code changes or Internet mode stops).
function dropRoomGuests() {
  for (const c of clients) if (c.viaRoom) { c.res.end(); clients.delete(c); }
  for (const [pid, p] of pollers) if (p.viaRoom) pollers.delete(pid);
  emit('desktop', 'peers', peers());
}

const internetState = () => ({
  on: internet.on,
  status: internet.status,
  url: internet.url,
  code: config.roomCode || null,
  error: internet.error,
});
const publishInternet = () => emit('desktop', 'internet', internetState());

function startTunnel() {
  if (tunnelProc || !internet.on) return;
  if (!fs.existsSync(CLOUDFLARED)) {
    Object.assign(internet, { status: 'error', error: 'cloudflared.exe is missing from the WinDrop\\bin folder.' });
    return publishInternet();
  }
  Object.assign(internet, { status: 'starting', url: null, error: null });
  publishInternet();
  const proc = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  tunnelProc = proc;
  const onOutput = buf => {
    const text = buf.toString();
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
    if (m && !internet.url) internet.url = m[0];
    if (internet.url && internet.status !== 'online' && /Registered tunnel connection/i.test(text)) {
      internet.status = 'online';
      tunnelRetry = 0;
      publishInternet();
      console.log(`Internet mode online: ${internet.url}`);
      if (config.ntfyOn) sendPush('WinDrop is online', `Tap to connect to ${HOST_NAME} from anywhere. Enter your room code when asked.`, internet.url);
    }
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);
  proc.on('error', err => {
    Object.assign(internet, { status: 'error', error: err.message });
    publishInternet();
  });
  proc.on('exit', () => {
    if (tunnelProc === proc) tunnelProc = null;
    internet.url = null;
    if (!internet.on) {
      internet.status = 'off';
      return publishInternet();
    }
    // Lost the tunnel (sleep, network change): try again with back-off.
    Object.assign(internet, { status: 'starting', error: 'Reconnecting…' });
    publishInternet();
    setTimeout(startTunnel, Math.min(30000, 2000 * 2 ** tunnelRetry++));
  });
}

function setInternet(on) {
  internet.on = on;
  config.internetOn = on;
  saveConfig();
  if (on) {
    if (!config.roomCode) newRoomCode();
    startTunnel();
  } else {
    if (tunnelProc) tunnelProc.kill();
    Object.assign(internet, { status: 'off', url: null, error: null });
    dropRoomGuests();
    publishInternet();
  }
}

// Wrong codes are rate limited (per device and overall) so codes can't be guessed.
const caller = req => req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
function tooManyTries(req) {
  const now = Date.now();
  while (joinAttempts.length && now - joinAttempts[0].at > 5 * 60e3) joinAttempts.shift();
  const mine = joinAttempts.filter(a => a.who === caller(req)).length;
  return mine >= 6 || joinAttempts.length >= 30;
}
const recordFail = req => joinAttempts.push({ who: caller(req), at: Date.now() });
const TOO_MANY = { error: 'Too many wrong codes. Wait a few minutes and try again.' };

// Room-code check for Internet mode.
function joinRoom(req, res, q) {
  if (tooManyTries(req)) return json(res, 429, TOO_MANY);
  if (!internet.on || !config.roomCode) return json(res, 403, { error: 'Internet mode is off on the PC.' });
  const code = String(q.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code !== config.roomCode.replace('-', '')) {
    recordFail(req);
    return json(res, 403, { error: 'That room code is not right.' });
  }
  json(res, 200, { token: roomToken });
}

// ---------- pairing on the same Wi-Fi: a temporary 6-digit code shown on the PC ----------
const PIN_LIFETIME = 120e3;
let pin = '';
let pinExpires = 0;
let failsSincePin = 0;

function rotatePin() {
  pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  pinExpires = Date.now() + PIN_LIFETIME;
  failsSincePin = 0;
  emit('desktop', 'pin', pinState());
}
const pinState = () => ({ pin, expires: pinExpires });

const deviceId = token => crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
const lastSeen = new Map(); // device key -> last request time (memory only)

function listDevices() {
  return Object.entries(config.devices)
    .map(([key, d]) => ({ id: deviceId(key), name: d.name, added: d.added, lastSeen: lastSeen.get(key) || null }))
    .sort((a, b) => b.added - a.added);
}

function pairDevice(req, res, q) {
  if (tooManyTries(req)) return json(res, 429, TOO_MANY);
  const given = String(q.get('pin') || '').replace(/\D/g, '');
  if (!pin || Date.now() >= pinExpires || given !== pin) {
    recordFail(req);
    if (++failsSincePin >= 3) rotatePin(); // someone is guessing: change the code
    return json(res, 403, { error: 'That code is not right. Check the code on your PC.' });
  }
  const key = crypto.randomBytes(16).toString('hex');
  const name = (q.get('device') || 'Phone').slice(0, 40);
  config.devices[key] = { name, added: Date.now() };
  saveConfig();
  rotatePin(); // each code works once
  emit('desktop', 'devices', listDevices());
  emit('desktop', 'paired', { name });
  json(res, 200, { token: key });
}

function removeDevice(id) {
  const key = Object.keys(config.devices).find(k => deviceId(k) === id);
  if (!key) return false;
  delete config.devices[key];
  saveConfig();
  for (const c of clients) if (c.token === key) { c.res.end(); clients.delete(c); }
  for (const [pid, p] of pollers) if (p.token === key) pollers.delete(pid);
  emit('desktop', 'devices', listDevices());
  emit('desktop', 'peers', peers());
  return true;
}

function safeName(name) {
  let n = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!n) n = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  return n.slice(0, 200);
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; reserved.has(candidate) || fs.existsSync(path.join(dir, candidate)); i++) {
    candidate = `${base} (${i})${ext}`;
  }
  reserved.add(candidate);
  return candidate;
}

const STATIC = {
  '/': ['phone.html', 'text/html; charset=utf-8'],
  '/phone': ['phone.html', 'text/html; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/ripple.js': ['ripple.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-256.png': ['icon-256.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

function serveFile(res, file, type) {
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function fmtSize(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i];
}

// ---------- notifications on this PC ----------
const xmlEsc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

// Windows notification with the received photo as a preview, plus Open / Show in folder buttons.
function notifyPcReceived(item) {
  const filePath = path.join(SAVE_DIR, item.name);
  const fileUrl = xmlEsc(pathToFileURL(filePath).href);
  const folderUrl = xmlEsc(pathToFileURL(SAVE_DIR).href);
  const logo = xmlEsc(pathToFileURL(path.join(PUBLIC, 'icon-256.png')).href);
  const preview = /\.(jpe?g|png|gif|bmp)$/i.test(item.name) && item.size < 3 * 1024 * 1024
    ? `<image placement="hero" src="${fileUrl}"/>`
    : '';
  const xml =
    `<toast activationType="protocol" launch="${fileUrl}">` +
    '<visual><binding template="ToastGeneric">' +
    `<text>${xmlEsc(item.device)} sent you a file</text>` +
    `<text>${xmlEsc(item.name)}</text>` +
    `<text placement="attribution">${xmlEsc(fmtSize(item.size))} · Downloads\\WinDrop</text>` +
    `<image placement="appLogoOverride" hint-crop="circle" src="${logo}"/>` +
    preview +
    '</binding></visual>' +
    '<actions>' +
    `<action content="Open" activationType="protocol" arguments="${fileUrl}"/>` +
    `<action content="Show in folder" activationType="protocol" arguments="${folderUrl}"/>` +
    '</actions></toast>';
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'toast.ps1')], {
    env: { ...process.env, WD_XML: xml, WD_APPID: config.appId ? APP_ID : POWERSHELL_APP_ID },
    windowsHide: true,
    stdio: 'ignore',
  }).on('error', () => {});
}

// Only pop a Windows notification when the WinDrop window isn't the one you're looking at.
const desktopFocused = () => [...clients].some(c => c.role === 'desktop' && c.focused);

// ---------- notifications on the phone (optional, via the free ntfy app) ----------
// iPhone Safari only allows real notifications for https sites, and WinDrop runs on plain http
// inside your Wi-Fi. ntfy (App Store, free, no account) delivers them instead. Only the file name
// and size are sent to ntfy.sh, under a random topic name.
let pendingPush = [];
let pushTimer = null;

function sendPush(title, message, click) {
  if (!config.ntfyTopic) return Promise.resolve(false);
  return fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: config.ntfyTopic, title, message, tags: ['inbox_tray'], ...(click ? { click } : {}) }),
  }).then(r => r.ok, () => false);
}

function queuePhonePush(item) {
  if (!config.ntfyOn) return;
  pendingPush.push(item);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const items = pendingPush.splice(0);
    const title = items.length === 1 ? `${HOST_NAME} sent you a file` : `${HOST_NAME} sent you ${items.length} files`;
    const list = items.slice(0, 3).map(i => `${i.name} (${fmtSize(i.size)})`).join('\n');
    sendPush(title, `${list}${items.length > 3 ? `\n+${items.length - 3} more` : ''}\nOpen WinDrop to save.`);
  }, 1500); // several files dropped at once -> one notification
}

// ---------- phone -> PC (chunked, resumable) ----------
const publicUpload = u => ({ id: u.id, name: u.name, size: u.size, received: u.received, pid: u.pid, device: u.device });

function startUpload(res, q) {
  const key = (q.get('key') || '').slice(0, 400);
  const size = Number(q.get('size'));
  if (!Number.isFinite(size) || size < 0) return json(res, 400, { error: 'Missing file size.' });

  const existing = key && uploads.get(uploadKeys.get(key));
  if (existing && existing.size === size) {
    existing.lastSeen = Date.now();
    return json(res, 200, { id: existing.id, name: existing.name, received: existing.received });
  }

  const name = uniqueName(SAVE_DIR, safeName(q.get('name')));
  const u = {
    id: crypto.randomUUID(),
    key,
    name,
    size,
    received: 0,
    busy: false,
    lastSeen: Date.now(),
    pid: (q.get('pid') || '').slice(0, 64),
    device: (q.get('device') || 'Phone').slice(0, 40),
    finalPath: path.join(SAVE_DIR, name),
  };
  u.partPath = u.finalPath + '.windrop-part';
  try {
    fs.writeFileSync(u.partPath, '');
  } catch {
    reserved.delete(name);
    return json(res, 500, { error: 'Could not create the file on the PC.' });
  }
  uploads.set(u.id, u);
  if (key) uploadKeys.set(key, u.id);
  emit('desktop', 'incoming', publicUpload(u));
  json(res, 200, { id: u.id, name, received: 0 });
}

function uploadChunk(req, res, q) {
  const id = q.get('id');
  const u = uploads.get(id);
  if (!u) {
    req.resume();
    return cancelled.has(id)
      ? json(res, 410, { error: 'Cancelled on the PC.' })
      : json(res, 404, { error: 'Upload not found.' });
  }
  const offset = Number(q.get('offset'));
  if (u.busy || offset !== u.received) {
    req.resume();
    return json(res, 409, { received: u.received });
  }

  u.busy = true;
  u.lastSeen = Date.now();
  let got = 0;
  let lastTick = 0;
  let settled = false;
  const expected = Number(req.headers['content-length']);
  const out = fs.createWriteStream(u.partPath, { flags: 'r+', start: u.received });

  const settle = ok => {
    if (settled) return false;
    settled = true;
    u.busy = false;
    u.lastSeen = Date.now();
    if (ok) u.received += got;
    return true;
  };

  req.on('data', chunk => {
    got += chunk.length;
    const now = Date.now();
    if (now - lastTick > 150) {
      lastTick = now;
      emit('desktop', 'progress', { id: u.id, pid: u.pid, got: u.received + got, total: u.size });
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (settled) return;
    if ((expected && got !== expected) || u.received + got > u.size) {
      settle(false);
      return json(res, 400, { error: 'Piece arrived incomplete.', received: u.received });
    }
    settle(true);
    emit('desktop', 'progress', { id: u.id, pid: u.pid, got: u.received, total: u.size });
    json(res, 200, { received: u.received });
  });
  out.on('error', () => {
    if (settle(false)) json(res, 500, { error: 'Could not write to disk. Is the drive full?', received: u.received });
  });
  res.on('close', () => {
    if (settle(false)) out.destroy();
  });
}

function finishUpload(res, q) {
  const u = uploads.get(q.get('id'));
  if (!u) return json(res, cancelled.has(q.get('id')) ? 410 : 404, { error: 'Upload not found.' });
  if (u.busy || u.received !== u.size) return json(res, 409, { received: u.received });
  try {
    fs.truncateSync(u.partPath, u.size);
    fs.renameSync(u.partPath, u.finalPath);
  } catch {
    return json(res, 500, { error: 'Could not save the file on the PC.' });
  }
  reserved.delete(u.name);
  uploads.delete(u.id);
  uploadKeys.delete(u.key);
  const item = { ...publicUpload(u), time: Date.now() };
  received.unshift(item);
  received.splice(50);
  emit('desktop', 'done', item);
  if (!desktopFocused()) notifyPcReceived(item);
  json(res, 200, { ok: true, name: u.name });
}

function dropUpload(u, byPc) {
  uploads.delete(u.id);
  uploadKeys.delete(u.key);
  reserved.delete(u.name);
  if (byPc) cancelled.add(u.id);
  fs.rm(u.partPath, { force: true }, () => {});
  emit('desktop', 'failed', { id: u.id, pid: u.pid, name: u.name, cancelled: true });
}

// Forget uploads a phone abandoned more than a day ago.
setInterval(() => {
  for (const u of uploads.values()) if (!u.busy && Date.now() - u.lastSeen > 24 * 3600e3) dropUpload(u, false);
}, 10 * 60e3);

// ---------- PC -> phone ----------
function handleShare(req, res, q) {
  const id = crypto.randomUUID();
  const name = safeName(q.get('name'));
  const filePath = path.join(SHARE_DIR, id);
  const out = fs.createWriteStream(filePath);
  req.pipe(out);
  out.on('error', () => json(res, 500, { error: 'Could not store the file.' }));
  out.on('finish', () => {
    const item = { id, name, size: fs.statSync(filePath).size, time: Date.now() };
    shared.unshift(item);
    emit(null, 'shared', shared);
    queuePhonePush(item);
    json(res, 200, item);
  });
}

function handleUnshare(res, id) {
  const i = shared.findIndex(s => s.id === id);
  if (i < 0) return json(res, 404, { error: 'not found' });
  shared.splice(i, 1);
  fs.rm(path.join(SHARE_DIR, id), { force: true }, () => {});
  emit(null, 'shared', shared);
  json(res, 200, { ok: true });
}

// Supports Range requests so big downloads can resume.
function handleDownload(req, res, id) {
  const item = shared.find(s => s.id === id);
  if (!item) return json(res, 404, { error: 'This file is no longer shared.' });
  const filePath = path.join(SHARE_DIR, id);
  const size = item.size;
  const ascii = item.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- live events ----------
function handleEvents(req, res, q, role) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const client = {
    res,
    role,
    pid: (q.get('pid') || crypto.randomUUID()).slice(0, 64),
    device: (q.get('device') || 'Phone').slice(0, 40),
    cid: q.get('cid') || '',
    focused: q.get('focused') === '1',
    via: viaInternet(req) ? 'internet' : 'wifi',
    viaRoom: q.get('t') === roomToken,
    token: q.get('t') || '',
  };
  clients.add(client);
  const hello = role === 'desktop'
    ? { host: HOST_NAME, received, shared, peers: peers(), uploads: [...uploads.values()].map(publicUpload), pin: pinState(), devices: listDevices() }
    : { host: HOST_NAME, shared, mdns: mdnsReady ? MDNS_HOST : null, port: PORT };
  res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
  if (role === 'phone') emit('desktop', 'peers', peers());
  req.on('close', () => {
    clients.delete(client);
    if (role === 'phone') emit('desktop', 'peers', peers());
  });
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 15000);

function openInExplorer(file) {
  const argv = file ? [`/select,"${path.join(SAVE_DIR, safeName(file))}"`] : [`"${SAVE_DIR}"`];
  spawn('explorer.exe', argv, { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
}

// ---------- mDNS: answer "windrop-<pc>.local" so phones find this PC even when its IP changes ----------
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
let mdnsReady = false;

function readName(buf, off) {
  const labels = [];
  let end = -1;
  for (let guard = 0; guard < 64; guard++) {
    const len = buf[off];
    if (len === undefined) throw new Error('bad name');
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    if (len === 0) {
      if (end < 0) end = off + 1;
      return { name: labels.join('.'), end };
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  throw new Error('bad name');
}

const encodeName = name => Buffer.concat([
  ...name.split('.').map(l => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])),
  Buffer.from([0]),
]);

const ipToInt = ip => ip.split('.').reduce((a, b) => ((a << 8) | Number(b)) >>> 0, 0);
function addressFacing(remote) {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (!isV4(a) || a.internal) continue;
      const mask = ipToInt(a.netmask);
      if (((ipToInt(a.address) & mask) >>> 0) === ((ipToInt(remote) & mask) >>> 0)) return a.address;
    }
  }
  return null;
}

function startMdns() {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const joined = new Set();
  const join = () => {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (!isV4(a) || a.internal || joined.has(a.address)) continue;
        try { sock.addMembership(MDNS_ADDR, a.address); joined.add(a.address); } catch {}
      }
    }
  };
  sock.on('error', err => {
    console.log(`Auto-connect name unavailable (${err.message}); phones will use the IP address.`);
    mdnsReady = false;
    try { sock.close(); } catch {}
  });
  sock.on('message', (msg, rinfo) => {
    try {
      if (msg.length < 12 || msg[2] & 0x80) return; // ignore responses
      let off = 12;
      for (let i = 0, n = msg.readUInt16BE(4); i < n; i++) {
        const { name, end } = readName(msg, off);
        const type = msg.readUInt16BE(end);
        const cls = msg.readUInt16BE(end + 2);
        off = end + 4;
        if (name.toLowerCase() !== MDNS_HOST || (type !== 1 && type !== 255)) continue;
        const ip = addressFacing(rinfo.address);
        if (!ip) return;
        const legacy = rinfo.port !== MDNS_PORT;
        const qname = encodeName(MDNS_HOST);
        const header = Buffer.alloc(12);
        header.writeUInt16BE(legacy ? msg.readUInt16BE(0) : 0, 0);
        header.writeUInt16BE(0x8400, 2);         // response, authoritative
        header.writeUInt16BE(legacy ? 1 : 0, 4); // questions
        header.writeUInt16BE(1, 6);              // answers
        const question = legacy ? Buffer.concat([qname, Buffer.from([0, 1, 0, 1])]) : Buffer.alloc(0);
        const rr = Buffer.alloc(10);
        rr.writeUInt16BE(1, 0);                         // A record
        rr.writeUInt16BE(legacy ? 1 : 0x8001, 2);       // IN (+ cache flush)
        rr.writeUInt32BE(legacy ? 10 : 120, 4);         // TTL
        rr.writeUInt16BE(4, 8);
        const packet = Buffer.concat([header, question, qname, rr, Buffer.from(ip.split('.').map(Number))]);
        if (legacy || cls & 0x8000) sock.send(packet, rinfo.port, rinfo.address);
        if (!legacy) {
          try { sock.setMulticastInterface(ip); } catch {}
          sock.send(packet, MDNS_PORT, MDNS_ADDR);
        }
        return;
      }
    } catch {}
  });
  sock.bind(MDNS_PORT, () => {
    try { sock.setMulticastTTL(255); } catch {}
    join();
    mdnsReady = true;
    setInterval(join, 30000); // pick up Wi-Fi reconnects / new networks
  });
}

// ---------- routes ----------
const server = http.createServer({ requestTimeout: 0 }, (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;
  const local = isLocal(req);

  try {
    if (m === 'GET' && STATIC[p]) return serveFile(res, ...STATIC[p]);
    if (m === 'GET' && p === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ app: 'windrop' }));
    }
    if (m === 'GET' && p === '/desktop') {
      return local ? serveFile(res, 'desktop.html', 'text/html; charset=utf-8') : json(res, 403, { error: 'forbidden' });
    }
    if (m === 'POST' && p === '/api/room/join') return joinRoom(req, res, q);
    if (m === 'POST' && p === '/api/pair') return pairDevice(req, res, q);
    const t = q.get('t');
    const paired = !!(t && config.devices[t]) || (internet.on && t === roomToken);
    if (!local && !paired) return json(res, 401, { error: 'Not paired. Enter the code shown on your PC.' });
    if (t && config.devices[t]) lastSeen.set(t, Date.now());

    if (m === 'GET' && p === '/api/events') return handleEvents(req, res, q, local && q.get('role') === 'desktop' ? 'desktop' : 'phone');
    if (m === 'POST' && p === '/api/upload/start') return startUpload(res, q);
    if (m === 'PUT' && p === '/api/upload/chunk') return uploadChunk(req, res, q);
    if (m === 'POST' && p === '/api/upload/finish') return finishUpload(res, q);
    if (m === 'DELETE' && p === '/api/upload') {
      const u = uploads.get(q.get('id'));
      if (u) dropUpload(u, local);
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/shared') return json(res, 200, shared);
    if (m === 'GET' && p === '/api/poll') return handlePoll(req, res, q);
    if (m === 'GET' && p.startsWith('/api/download/')) return handleDownload(req, res, p.slice('/api/download/'.length));

    if (!local) return json(res, 403, { error: 'forbidden' });
    if (m === 'GET' && p === '/api/info') {
      return json(res, 200, {
        host: HOST_NAME,
        saveDir: SAVE_DIR,
        mdns: mdnsReady ? MDNS_HOST : null,
        autostart: autostartOn(),
        phoneNotify: { on: !!config.ntfyOn, topic: config.ntfyTopic || null },
        internet: internetState(),
        pin: pinState(),
        devices: listDevices(),
        networks: lanAddresses().map(n => ({ name: n.name, ip: n.ip, url: urlFor(n.ip) })),
      });
    }
    if (m === 'DELETE' && p.startsWith('/api/devices/')) {
      return removeDevice(p.slice('/api/devices/'.length)) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
    }
    if (m === 'POST' && p === '/api/pin/new') {
      rotatePin();
      return json(res, 200, pinState());
    }
    if (m === 'POST' && p === '/api/internet') {
      setInternet(q.get('on') === '1');
      return json(res, 200, internetState());
    }
    if (m === 'POST' && p === '/api/internet/new-code') {
      newRoomCode();
      publishInternet();
      return json(res, 200, internetState());
    }
    if (m === 'POST' && p === '/api/focus') {
      for (const c of clients) if (c.role === 'desktop' && c.cid === q.get('cid')) c.focused = q.get('on') === '1';
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/phone-notify') {
      config.ntfyOn = q.get('on') === '1';
      if (config.ntfyOn && !config.ntfyTopic) config.ntfyTopic = 'windrop-' + crypto.randomBytes(8).toString('hex');
      saveConfig();
      return json(res, 200, { on: config.ntfyOn, topic: config.ntfyTopic || null });
    }
    if (m === 'POST' && p === '/api/phone-notify/test') {
      return sendPush('WinDrop is set up', `Your iPhone will be notified when ${HOST_NAME} sends you files.`)
        .then(ok => json(res, ok ? 200 : 502, ok ? { ok } : { error: 'Could not reach ntfy.sh. Is this PC online?' }));
    }
    if (m === 'POST' && p === '/api/test-notification') {
      notifyPcReceived({ name: 'Test notification.txt', size: 1234, device: 'WinDrop' });
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/autostart') {
      setAutostart(q.get('on') === '1');
      return json(res, 200, { autostart: autostartOn() });
    }
    if (m === 'POST' && p === '/api/share') return handleShare(req, res, q);
    if (m === 'DELETE' && p.startsWith('/api/share/')) return handleUnshare(res, p.slice('/api/share/'.length));
    if (m === 'POST' && p === '/api/open') {
      openInExplorer(q.get('file'));
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/quit') {
      json(res, 200, { ok: true });
      emit('desktop', 'quit', {});
      return setTimeout(() => process.exit(0), 300);
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

function openWindow() {
  const u = `http://localhost:${PORT}/desktop`;
  exec(`start "" msedge --app=${u} --window-size=1180,780`, err => { if (err) exec(`start "" "${u}"`); });
}

process.on('exit', () => { if (tunnelProc) tunnelProc.kill(); });

server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Already running: just bring up the window (unless this was the silent login start).
  if (!BACKGROUND) openWindow();
  setTimeout(() => process.exit(0), 800);
});

server.listen(PORT, '0.0.0.0', () => {
  startMdns();
  rotatePin();
  setInterval(() => { if (Date.now() >= pinExpires) rotatePin(); }, 1000);
  if (config.internetOn) setInternet(true);
  console.log('');
  console.log(`  WinDrop is running  (${new Date().toLocaleString()})`);
  console.log(`  Phone link : ${urlFor(lanAddresses()[0].ip)}`);
  console.log(`  Auto name  : http://${MDNS_HOST}:${PORT}`);
  console.log(`  Saving to  : ${SAVE_DIR}`);
  console.log('');
  if (!BACKGROUND) openWindow();
});
