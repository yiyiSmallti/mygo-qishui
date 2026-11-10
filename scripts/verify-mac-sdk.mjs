// End-to-end preparation from the pinned official archive. Does not install,
// launch or read an official application's profile; never prints native data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const output = path.resolve(process.argv[2]), official = path.resolve(process.argv[3]);
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qishui-mac-sdk-'));
const owner = path.join(temp, 'path with spaces 中文', 'plugin-data/qishui-account');
const checks = [], originalFetch = global.fetch, originalOverride = process.env.MYGO_QISHUI_SDK_DIR;
let downloads = 0;
global.fetch = (...args) => { downloads++; return originalFetch(...args); };
function result(value) { fs.writeFileSync(path.join(output, 'mac-sdk.json'), JSON.stringify(value, null, 2)); }
try {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const { prepareSdk } = require('../qishui-account/native-sdk.cjs');
  const { prepareMacSdk, extractMacPackage, cachedMacSdk } = require('../qishui-account/native-sdk-mac.cjs');
  // This existing override disables installed-app discovery, including when
  // the machine running the check happens to have the official app installed.
  process.env.MYGO_QISHUI_SDK_DIR = path.join(temp, 'no-installed-client');
  await assert.rejects(prepareMacSdk({ dataDir: temp }), e => e.code === 'setup');
  await assert.rejects(prepareMacSdk({ dataDir: owner, signal: AbortSignal.abort() }), e => e.code === 'setup');
  assert.equal(downloads, 0);
  const bad = path.join(temp, 'not-official.tgz'); fs.writeFileSync(bad, 'not an archive');
  await assert.rejects(extractMacPackage({ packageFile: bad, dataDir: owner }), e => e.code === 'setup');
  checks.push({ case: 'invalid-owner-cancel-and-package-rejected', ok: true });
  fs.mkdirSync(owner, { recursive: true });
  const lock = path.join(owner, '.native-sdk-lock'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'abandoned-test-lock' }));
  const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
  const before = downloads;
  const preparations = await Promise.allSettled([prepareSdk({ dataDir: owner }), prepareSdk({ dataDir: owner })]);
  for (const item of preparations) if (item.status === 'rejected') throw item.reason;
  assert.equal(downloads - before, 1, 'concurrent callers share the real official download');
  const sdk = await cachedMacSdk(owner); assert.ok(sdk);
  assert.equal(process.env.MYGO_QISHUI_SDK_DIR, path.dirname(path.dirname(sdk.asar)));
  const cacheRoot = process.env.MYGO_QISHUI_SDK_DIR;
  assert.deepEqual(fs.readdirSync(owner), [path.basename(cacheRoot)]);
  assert.ok(!fs.readdirSync(cacheRoot).some(n => n.endsWith('.app')));
  checks.push({ case: 'cold-official-download-concurrent-prepare-spaced-path', ok: true, downloads: 1 });
  global.fetch = () => { throw new Error('OFFLINE_CACHE_MUST_NOT_FETCH'); };
  await prepareSdk({ dataDir: owner });
  checks.push({ case: 'offline-cache-reuse', ok: true });
  global.fetch = (...args) => { downloads++; return originalFetch(...args); };
  const probe = path.join(temp, 'native-probe.cjs');
  const plugin = fileURLToPath(new URL('../qishui-account', import.meta.url));
  fs.writeFileSync(probe, `
const fs=require('node:fs'),path=require('node:path');
const roots=['/Applications/汽水音乐.app',path.join(require('node:os').homedir(),'Applications/汽水音乐.app')];
const check=p=>{if(typeof p==='string'&&roots.some(root=>p===root||p.startsWith(root+'/')))throw new Error('OFFICIAL_APP_ACCESS');};
for(const key of ['existsSync','statSync','lstatSync','readFileSync','readdirSync','accessSync']){const f=fs[key];fs[key]=function(p,...rest){check(p);return f.call(this,p,...rest);};}
try {
 const {sodaComponents}=require(${JSON.stringify(path.join(plugin, 'local-env.cjs'))});
 const sdk=sodaComponents();if(!sdk)throw new Error('MISSING_PRIVATE_SDK');
 const device=require(path.join(sdk.unpacked,'device.node'));
 const encoded=device.applogDecorated(Buffer.from('{}'));
 const bdms=require(path.join(sdk.unpacked,'bdms.node'));bdms.init({deviceId:'123456789012345'});
 const signature=bdms.generateHttpSignatureHeaders('https://api.qishui.com/luna/pc/track_v2','user-agent\\r\\nLunaPC/3.7.0\\r\\n');
 process.stdout.write('MAC_SDK_RESULT:'+JSON.stringify({ok:encoded.length>0&&typeof signature==='string'&&signature.length>0,deviceCodec:encoded.length>0,signing:typeof signature==='string'&&signature.length>0,decodeSpadeAvailable:typeof device.decodeSpade==='function'})+'\\n');
}catch(e){process.stdout.write('MAC_SDK_RESULT:'+JSON.stringify({ok:false,errorName:e.name,code:e.code})+'\\n');process.exitCode=1;}
`);
  const child = spawnSync(process.execPath, [probe], { env: process.env, encoding: 'utf8', timeout: 20000 });
  const line = child.stdout?.split('\n').find(l => l.startsWith('MAC_SDK_RESULT:'));
  assert.ok(line, 'native probe must return a safe result'); const native = JSON.parse(line.slice(15));
  assert.equal(child.status, 0); assert.equal(native.ok, true);
  checks.push({ case: 'native-device-and-signing-load-with-installed-app-blocked', ...native });
  fs.appendFileSync(path.join(sdk.unpacked, 'bdms.node'), 'corrupt');
  assert.equal(await cachedMacSdk(owner), null);
  await extractMacPackage({ packageFile: official, dataDir: owner });
  assert.ok(await cachedMacSdk(owner));
  checks.push({ case: 'corruption-rejected-and-real-archive-restored', ok: true });
  const abortExtract = new AbortController(); let scheduled;
  await assert.rejects(extractMacPackage({ packageFile: official, dataDir: owner, signal: abortExtract.signal,
    onProgress: () => { scheduled = setTimeout(() => abortExtract.abort(), 1); } }), e => e.code === 'setup');
  clearTimeout(scheduled);
  assert.ok(await cachedMacSdk(owner));
  assert.deepEqual(fs.readdirSync(owner), [path.basename(cacheRoot)]);
  checks.push({ case: 'cancelled-extraction-keeps-good-cache-and-cleans-staging', ok: true });
  const registered = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(plugin, 'device-helper.cjs')], { cwd: plugin,
      env: { ...process.env, MYGO_QISHUI_SDK_DIR: cacheRoot }, stdio: ['pipe', 'pipe', 'ignore'] });
    const reader = readline.createInterface({ input: child.stdout }); let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer);
      reader.close(); child.stdin.end(); if (error) { child.kill(); reject(error); } else resolve(value); };
    const timer = setTimeout(() => finish(new Error('DEVICE_REGISTRATION_TIMEOUT')), 45000);
    child.once('error', () => finish(new Error('DEVICE_HELPER_START_FAILED')));
    child.once('exit', () => { if (!settled) finish(new Error('DEVICE_HELPER_EXITED')); });
    child.stdin.on('error', () => {});
    reader.on('line', line => {
      if (!line.startsWith('{')) return; let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'device') finish(null, { deviceRegistered: Boolean(message.device?.did && message.device?.iid),
        macLabel: message.osLabel === 'Mac', computerNamePresent: Boolean(message.computerName) });
      else if (message.type === 'error') finish(Object.assign(new Error('DEVICE_REGISTRATION_FAILED'), { code: message.code }));
    });
    child.stdin.write(JSON.stringify({ type: 'start', dataDir: owner }) + '\n');
  });
  assert.equal(registered.deviceRegistered, true); assert.equal(registered.macLabel, true);
  checks.push({ case: 'real-device-helper-anonymous-registration', ok: true, ...registered });
  const other = path.join(temp, 'cancel', 'plugin-data/qishui-account'), control = new AbortController();
  await assert.rejects(prepareMacSdk({ dataDir: other, signal: control.signal,
    onProgress: text => { if (text.includes('正在下载')) control.abort(); } }), e => e.code === 'setup');
  assert.deepEqual(fs.readdirSync(other), []);
  checks.push({ case: 'cancelled-real-download-cleans-lock-and-staging', ok: true });
  const sizes = ['app.asar', 'app.asar.unpacked/device.node', 'app.asar.unpacked/bdms.node', 'app.asar.unpacked/libMetaSecML.dylib']
    .map(n => { const file = path.join(path.dirname(sdk.asar), n); return { name: n, bytes: fs.statSync(file).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }; });
  assert.ok(sizes.reduce((n, f) => n + f.bytes, 0) < 12 * 1024 * 1024);
  result({ ok: true, platform: process.platform, arch: process.arch, officialAppInstalledOrModified: false,
    officialAppDiscoveryBlocked: true, checks, files: sizes });
  console.log('mac-sdk: PASS (' + checks.length + ' cases)');
} catch (error) {
  result({ ok: false, completed: checks, error: error.code || error.name }); throw error;
} finally {
  global.fetch = originalFetch;
  if (originalOverride === undefined) delete process.env.MYGO_QISHUI_SDK_DIR;
  else process.env.MYGO_QISHUI_SDK_DIR = originalOverride;
  fs.rmSync(temp, { recursive: true, force: true });
}
