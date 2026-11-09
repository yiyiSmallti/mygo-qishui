'use strict';

// Fresh plugin-owned device registration. No official app profile is read.
// Assisted-by: Cindy (https://cindy.app)
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { sodaAddon, osVersion } = require('./local-env.cjs');

const API = 'https://api.qishui.com/service/2/desktop/device_register/';
const AID = 386088;
const VERSION = '3.7.0';
const ID = /^[1-9]\d{8,24}$/;

function failure(message) {
  const error = new Error(message);
  error.code = 'QISHUI_DEVICE';
  return error;
}

function validDevice(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.schema === 1 && value.aid === AID
    && typeof value.did === 'string' && ID.test(value.did)
    && typeof value.iid === 'string' && ID.test(value.iid)
    && typeof value.cdid === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.cdid)
    && typeof value.serial === 'string' && /^[0-9a-f]{64}$/i.test(value.serial)
    && value.identityType === 'fresh-plugin-pseudonymous'
    && value.channel === 'mygo' && value.clientVersion === VERSION;
}

function codec(input) {
  const addon = sodaAddon('device.node');
  if (!addon || !fs.existsSync(addon)) throw Object.assign(failure('缺少汽水设备编码组件，请重新准备免安装组件。'), { code: 'setup' });
  const result = spawnSync(process.execPath, [__filename, '--codec-worker'], {
    input, cwd: __dirname, timeout: 12000, windowsHide: true, maxBuffer: 131072,
  });
  // Never relay native stderr, paths, stack traces or arbitrary native output.
  if (result.error && result.error.code === 'ETIMEDOUT') throw failure('汽水设备编码超时，请稍后重试。');
  if (result.error || result.status !== 0 || !result.stdout || !result.stdout.length)
    throw Object.assign(failure('汽水设备编码组件未能初始化，请检查 Node.js 与组件架构是否一致。'), { code: 'setup' });
  return result.stdout;
}

async function ensureDevice(existing) {
  if (validDevice(existing)) {
    return {
      schema: 1, aid: AID, registeredAt: typeof existing.registeredAt === 'string' ? existing.registeredAt : '',
      did: existing.did, iid: existing.iid, cdid: existing.cdid, serial: existing.serial,
      identityType: 'fresh-plugin-pseudonymous', channel: 'mygo', clientVersion: VERSION,
    };
  }
  try {
    if (!['win32', 'darwin'].includes(process.platform)) throw failure('当前设备注册组件仅适用于 Windows 和 macOS。');
    const cdid = randomUUID();
    // Deliberately use a new installation pseudonym, not a hardware serial.
    const serial = createHash('sha256').update('MyGo qishui plugin:' + randomUUID()).digest('hex');
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const channel = 'mygo';
    const url = new URL(API);
    Object.entries({
      aid: AID, channel, os: os.type(), os_version: osVersion(),
      device_platform: 'PC', app_version: VERSION,
    }).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const header = {
      device_id: '', install_id: '', os: 'Windows', device_platform: 'PC',
      sdk_version: '1.0', sdk_version_code: 1, aid: AID, mc: '00:00:00:00:00:00',
      channel, package: 'com.soda.music', language: Intl.DateTimeFormat().resolvedOptions().locale,
      app_version: VERSION, os_version: osVersion(), device_model: 'no detected',
      time_zone: timezone, tz_name: timezone, tz_offset: 0, resolution: 'no detected',
      app_region: 'cn', app_language: 'zh-CN', display_name: 'MyGo Music',
      pc_uuid: cdid, pc_serial: serial,
    };
    const body = codec(zlib.gzipSync(Buffer.from(JSON.stringify({
      header, gen_time: Date.now(), magic_tag: 'ss_app_log',
    }))));
    const response = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' }, body,
    });
    if (!response.ok) throw failure('汽水设备注册失败（HTTP ' + response.status + '）。');
    const text = await response.text();
    if (!text || text.length > 1048576) throw failure('汽水设备注册返回了无效数据。');
    let data;
    try { data = JSON.parse(text); } catch { throw failure('汽水设备注册返回了无效数据。'); }
    if (!data || typeof data !== 'object'
      || typeof data.device_id_str !== 'string' || !ID.test(data.device_id_str)
      || typeof data.install_id_str !== 'string' || !ID.test(data.install_id_str)
      || (data.status_code != null && Number(data.status_code) !== 0))
      throw failure('汽水未能签发有效的设备标识。');
    return {
      schema: 1, aid: AID, registeredAt: new Date().toISOString(),
      did: data.device_id_str, iid: data.install_id_str, cdid, serial,
      identityType: 'fresh-plugin-pseudonymous', channel, clientVersion: VERSION,
    };
  } catch (error) {
    if (error && ['QISHUI_DEVICE', 'setup'].includes(error.code)) throw error;
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
      throw failure('连接汽水设备注册接口超时，请稍后重试。');
    throw failure('无法完成汽水设备注册，请检查网络后重试。');
  }
}

module.exports = { ensureDevice };

// Importing this module performs no native calls, probes or network requests.
if (require.main === module && process.argv[2] === '--codec-worker') {
  try {
    const addon = require(sodaAddon('device.node'));
    if (typeof addon.applogDecorated !== 'function') throw new Error();
    const input = fs.readFileSync(0);
    if (!input.length || input.length > 65536) throw new Error();
    const output = addon.applogDecorated(input);
    if (!Buffer.isBuffer(output) && !(output instanceof Uint8Array)) throw new Error();
    if (!output.length || output.length > 131072) throw new Error();
    process.stdout.write(Buffer.from(output));
  } catch {
    process.stderr.write('QISHUI_DEVICE_CODEC_FAILED');
    process.exitCode = 1;
  }
}
