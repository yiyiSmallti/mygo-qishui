'use strict';

// Locates complete installed components or the plugin-owned extracted SDK.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function macApplications(name) {
  return ['/Applications', path.join(os.homedir(), 'Applications')].map(dir => path.join(dir, name));
}

/**
 * Soda Music installation pieces: app.asar (version metadata) and the folder
 * holding device.node / bdms.node. The macOS app ships per-architecture
 * unpacked folders, so the one matching this Node process is chosen.
 */
function componentsAt(resources, names = ['app.asar.unpacked']) {
  if (!resources) return null;
  const asar = path.join(resources, 'app.asar');
  const unpacked = names.map(name => path.join(resources, name)).find(dir =>
    ['device.node', 'bdms.node', ...(process.platform === 'win32' ? ['metasecml.dll'] : [])]
      .every(name => fs.existsSync(path.join(dir, name))));
  return unpacked && fs.existsSync(asar) ? { asar, unpacked } : null;
}
function sodaComponents() {
  if (process.env.MYGO_QISHUI_SDK_DIR) return componentsAt(path.join(process.env.MYGO_QISHUI_SDK_DIR, 'resources'));
  if (process.platform === 'darwin') {
    for (const app of macApplications('汽水音乐.app')) {
      const found = componentsAt(path.join(app, 'Contents', 'Resources'), ['app-' + process.arch + '.asar.unpacked', 'app.asar.unpacked']);
      if (found) return found;
    }
  }
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Soda Music'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Soda Music'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Soda Music')].filter(Boolean);
    for (const root of roots) {
      let versions = [];
      try { versions = fs.readdirSync(root).filter(name => /^\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true })); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      for (const dir of [root, ...versions.map(version => path.join(root, version))]) {
        const found = componentsAt(path.join(dir, 'resources'));
        if (found) return found;
      }
    }
  }
  return null;
}

function sodaAddon(name) {
  const soda = sodaComponents();
  return soda ? path.join(soda.unpacked, name) : '';
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

// ComputerName is the user-visible macOS name; os.hostname() may instead
// report its .local network host name. Windows hostname is its computer name.
function deviceName() {
  let value;
  try {
    value = process.platform === 'darwin'
      ? execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      : os.hostname();
  } catch { throw Object.assign(new Error('无法读取系统设备名称，请检查系统的电脑名称设置。'), { code: 'setup' }); }
  const name = value.trim();
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw Object.assign(new Error('系统设备名称为空或包含无效字符，请在系统设置中检查。'), { code: 'setup' });
  return name;
}

module.exports = { sodaComponents, sodaAddon, scanLabel, deviceName, osVersion };
