'use strict';

// Locates the local components the helpers rely on. Windows keeps the paths
// verified on the original machine; macOS uses standard app/Homebrew locations.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SODA_VERSION = '3.7.0';

function firstExisting(candidates) {
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}

function macApplications(name) {
  return ['/Applications', path.join(os.homedir(), 'Applications')].map(dir => path.join(dir, name));
}

/**
 * Soda Music installation pieces: app.asar (version metadata) and the folder
 * holding device.node / bdms.node. The macOS app ships per-architecture
 * unpacked folders, so the one matching this Node process is chosen.
 */
function sodaComponents() {
  if (process.platform === 'darwin') {
    const resources = firstExisting(macApplications('汽水音乐.app').map(app => path.join(app, 'Contents', 'Resources')));
    if (!resources) return null;
    const unpacked = firstExisting(['app-' + process.arch + '.asar.unpacked', 'app.asar.unpacked'].map(name => path.join(resources, name)));
    return unpacked ? { asar: path.join(resources, 'app.asar'), unpacked } : null;
  }
  if (process.platform === 'win32') {
    const roots = ['D:/Users/22589/AppData/Local/Programs/Soda Music',
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Soda Music')];
    const resources = firstExisting(roots.map(root => root && path.join(root, SODA_VERSION, 'resources')));
    return resources ? { asar: path.join(resources, 'app.asar'), unpacked: path.join(resources, 'app.asar.unpacked') } : null;
  }
  return null;
}

function sodaAddon(name) {
  const soda = sodaComponents();
  return soda ? path.join(soda.unpacked, name) : '';
}

function ffmpegPath() {
  if (process.platform === 'darwin') return firstExisting(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
  return 'C:/Users/22589/AppData/Local/Programs/Python/Python311/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe';
}

function browserPath() {
  if (process.platform === 'darwin') {
    return firstExisting([
      ...macApplications('Google Chrome.app/Contents/MacOS/Google Chrome'),
      ...macApplications('Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      ...macApplications('Chromium.app/Contents/MacOS/Chromium'),
    ]);
  }
  return firstExisting(['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe']);
}

// OS version as the desktop client reports it: Windows keeps os.version()
// ("Windows 11 Pro"); macOS uses the product version ("26.0"), not the kernel
// banner os.version() returns there.
function osVersion() {
  if (process.platform !== 'darwin') return os.version();
  try {
    const plist = fs.readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    const match = /<key>ProductVersion<\/key>\s*<string>([\d.]+)<\/string>/.exec(plist);
    if (match) return match[1];
  } catch {}
  return os.release();
}

// Label shown on the phone when scanning, as the official clients send it.
// Device registration only issues IDs for os "Windows" under this aid (Mac,
// macOS, darwin etc. return device_id 0), so device registration keeps that
// identity. Signed media requests separately use the actual SDK platform;
// Mac signatures with device_platform=windows receive an empty TrackV2 body.
function scanLabel() {
  return process.platform === 'darwin' ? 'Mac' : 'Windows';
}

module.exports = { sodaComponents, sodaAddon, ffmpegPath, browserPath, scanLabel, osVersion };
