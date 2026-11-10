'use strict';
// Extract only the native SDK from the pinned official package. Never execute
// an installer or read the official client's profile.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { sodaComponents } = require('./local-env.cjs');

const PACKAGE = Object.freeze({
  url: 'https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-win32_x64.exe',
  sha256: 'e58578aec410e2c9c24835e92a1dc74d0fda982be1cf1003034538255baab0e4',
  size: 150602608,
  // This contiguous 7z payload is bound to the exact installer digest above.
  offset: 1830149, archiveSize: 148177964,
});
const FILES = Object.freeze({
  'resources/app.asar': 'af3f3763148db43df750f721daeaa2e6927da6d7f220e06fb82d249cd9817aed',
  'resources/app.asar.unpacked/device.node': 'e5d15041797a3efe42f0327b90348ca03d7e0df3efc8d2a5865c56ad7dce03ad',
  'resources/app.asar.unpacked/bdms.node': '73017455010b58aabae15b5560f82463f425acf1f4a813d91370abd1f35fac0f',
  'resources/app.asar.unpacked/metasecml.dll': '53f322a7731cf64e6187d2fde1bb07558c2ab0a64fa6db0ef7c95d618ea9a226',
});
const CACHE = 'native-sdk-3.7.0-x64';
function fail(message) { return Object.assign(new Error(message), { code: 'setup' }); }
function cancelled(signal) { if (signal?.aborted) throw fail('组件准备已取消。'); }
function ownedDir(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw fail('MyGo 未提供有效的插件数据目录。');
  const dir = path.resolve(value);
  if (path.basename(dir) !== 'qishui-account' || path.basename(path.dirname(dir)) !== 'plugin-data') throw fail('组件只能保存在 MyGo 的汽水插件数据目录。');
  return dir;
}
async function digest(file, signal) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file, { signal })) hash.update(bytes);
  return hash.digest('hex');
}
async function validateFiles(root, signal) {
  for (const [name, expected] of Object.entries(FILES)) {
    cancelled(signal);
    const file = path.join(root, name), stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await digest(file, signal) !== expected) throw fail('汽水组件不完整或校验失败，请重新准备组件。');
    if (name.endsWith('.node') || name.endsWith('.dll')) {
      const handle = await fs.promises.open(file, 'r');
      try {
        const header = Buffer.alloc(4096); const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const pe = header.readUInt32LE(0x3c);
        if (header.toString('ascii', 0, 2) !== 'MZ' || pe + 6 > bytesRead
            || header.readUInt32LE(pe) !== 0x4550 || header.readUInt16LE(pe + 4) !== 0x8664) throw fail('汽水组件架构无效，需要 Windows x64 组件。');
      } finally { await handle.close(); }
    }
  }
  return { asar: path.join(root, 'resources', 'app.asar'), unpacked: path.join(root, 'resources', 'app.asar.unpacked') };
}
async function cachedWindowsSdk(dataDir, signal) {
  const root = path.join(ownedDir(dataDir), CACHE);
  try {
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'sdk.json'), 'utf8'));
    if (manifest.schema !== 1 || manifest.packageSha256 !== PACKAGE.sha256) return null;
    return await validateFiles(root, signal);
  } catch (error) { cancelled(signal); return null; }
}
function unpack(archive, destination, signal) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    const child = spawn(command, ['-xf', archive, '-C', destination, ...Object.keys(FILES)],
      { windowsHide: true, stdio: 'ignore', signal });
    const timeout = setTimeout(() => child.kill(), 60000);
    child.once('error', () => { clearTimeout(timeout); reject(fail('无法启动系统 tar。请更新 Windows 的归档工具后重试。')); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (signal?.aborted) reject(fail('组件准备已取消。'));
      else if (code !== 0) reject(fail('系统 tar 未能解开汽水组件。请更新 Windows 的归档工具后重试；插件没有运行安装程序。'));
      else resolve();
    });
  });
}
async function extractWindowsPackage({ packageFile, dataDir, signal, onProgress = () => {} }) {
  const owner = ownedDir(dataDir);
  cancelled(signal);
  const stat = await fs.promises.stat(packageFile);
  if (stat.size !== PACKAGE.size || await digest(packageFile, signal) !== PACKAGE.sha256) throw fail('汽水官方安装包校验失败，未加载任何组件。请重新下载。');
  await fs.promises.mkdir(owner, { recursive: true });
  if ((await fs.promises.lstat(owner)).isSymbolicLink()) throw fail('插件数据目录不能是符号链接。');
  const temporary = await fs.promises.mkdtemp(path.join(owner, '.native-sdk-'));
  const archive = path.join(temporary, 'payload.7z');
  const destination = path.join(owner, CACHE), previous = path.join(owner, '.native-sdk-old-' + randomUUID());
  let moved = false, published = false;
  try {
    onProgress('正在提取汽水官方组件…');
    await pipeline(fs.createReadStream(packageFile, { start: PACKAGE.offset, end: PACKAGE.offset + PACKAGE.archiveSize - 1 }), fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    await unpack(archive, temporary, signal);
    await fs.promises.unlink(archive);
    await validateFiles(temporary, signal);
    await fs.promises.writeFile(path.join(temporary, 'sdk.json'), JSON.stringify({ schema: 1, version: '3.7.0', arch: 'x64', source: PACKAGE.url, packageSha256: PACKAGE.sha256 }) + '\n', { flag: 'wx', mode: 0o600 });
    cancelled(signal);
    try { await fs.promises.rename(destination, previous); moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.promises.rename(temporary, destination); published = true; }
    catch (error) { if (moved) { await fs.promises.rename(previous, destination); moved = false; } throw error; }
    return { asar: path.join(destination, 'resources', 'app.asar'), unpacked: path.join(destination, 'resources', 'app.asar.unpacked') };
  } finally {
    if (!published) await fs.promises.rm(temporary, { recursive: true, force: true });
    if (moved && published) await fs.promises.rm(previous, { recursive: true, force: true });
  }
}
async function download(file, signal, onProgress, packageInfo = PACKAGE) {
  const stalled = new AbortController();
  let idle;
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => stalled.abort(fail('下载汽水组件长时间未收到数据，请检查网络后重试。')), 45000); };
  resetIdle();
  const combined = AbortSignal.any([signal || new AbortController().signal, stalled.signal, AbortSignal.timeout(600000)]);
  try {
    const response = await fetch(packageInfo.url, { redirect: 'error', signal: combined });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw fail('下载汽水官方组件失败（HTTP ' + response.status + '），请检查网络后重试。'); }
    const size = Number(response.headers.get('content-length'));
    if (size && size !== packageInfo.size) { await response.body.cancel(); throw fail('汽水官方安装包大小已变化，未加载组件，请更新插件。'); }
    const output = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    let received = 0, percent = -10;
    async function* bounded() {
      for await (const bytes of response.body) {
        resetIdle();
        received += bytes.length;
        if (received > packageInfo.size) throw fail('汽水官方安装包大小异常，已停止下载。');
        const current = Math.floor(received * 100 / packageInfo.size / 10) * 10;
        if (current > percent) { percent = current; onProgress('正在下载汽水官方组件（' + current + '%）…'); }
        yield bytes;
      }
      if (received !== packageInfo.size) throw fail('汽水官方组件下载不完整，请重试。');
    }
    try { await pipeline(bounded(), output, { signal: combined }); }
    catch (error) { if (combined.reason?.name === 'TimeoutError') throw fail('下载汽水组件超时，请检查网络后重试。'); if (combined.reason?.code === 'setup') throw combined.reason; throw error; }
  } finally { clearTimeout(idle); }
}
async function lockState(lock) {
  const stat = await fs.promises.stat(lock);
  let raw = '', owner;
  try { raw = await fs.promises.readFile(path.join(lock, 'owner.json'), 'utf8'); owner = JSON.parse(raw); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  let stale = Date.now() - stat.mtimeMs > 10000;
  if (Number.isInteger(owner?.pid) && owner.pid > 0) {
    stale = false;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') stale = true; }
  }
  return { stat, raw, owner, stale };
}
function sameLock(a, b) {
  return a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino && a.stat.birthtimeMs === b.stat.birthtimeMs;
}
async function recoverLock(lock, observed) {
  // Re-check under an exclusive child directory: an earlier stale observation
  // must never delete a lock already acquired by another waiting process.
  const guard = path.join(lock, '.recovering');
  let guarded, removed = false;
  try {
    await fs.promises.mkdir(guard);
    guarded = await lockState(lock);
    if (!sameLock(observed, guarded) || observed.raw !== guarded.raw) return;
    await fs.promises.rm(lock, { recursive: true, force: true });
    removed = true;
  } catch (error) {
    if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error;
    if (error.code === 'EEXIST') {
      // An old parent lock can have a freshly acquired recovery guard. Only
      // the guard's own age can distinguish interrupted recovery from a
      // second caller currently repairing the same abandoned parent lock.
      try {
        const recovery = await fs.promises.stat(guard);
        if (Date.now() - recovery.mtimeMs > 30000)
          throw fail('上次组件准备的恢复被中断。请退出 MyGo，删除插件数据目录中的 .native-sdk-lock，再重新登录。');
      } catch (changed) { if (changed.code !== 'ENOENT') throw changed; }
    }
  } finally {
    if (guarded && !removed) {
      try { if (sameLock(guarded, await lockState(lock))) await fs.promises.rmdir(guard); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    }
  }
}
async function acquireLock(owner, signal) {
  const lock = path.join(owner, '.native-sdk-lock'), deadline = Date.now() + 660000;
  const token = randomUUID();
  while (true) {
    cancelled(signal);
    try {
      await fs.promises.mkdir(lock);
      const acquired = { stat: await fs.promises.stat(lock) };
      try { await fs.promises.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx' }); }
      catch (error) {
        try { if (sameLock(acquired, await lockState(lock))) await fs.promises.rm(lock, { recursive: true, force: true }); }
        catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; }
        throw error;
      }
      return async () => {
        try {
          const current = await lockState(lock);
          if (current.owner?.token === token) await fs.promises.rm(lock, { recursive: true, force: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { const state = await lockState(lock); if (state.stale) await recoverLock(lock, state); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() > deadline) throw fail('另一项组件准备尚未结束，请稍后重试。');
      await delay(500, undefined, { signal });
    }
  }
}
async function prepareSdk({ dataDir, signal, onProgress = () => {} } = {}) {
  if (process.platform === 'darwin' && process.arch === 'arm64') return require('./native-sdk-mac.cjs').prepareMacSdk({ dataDir, signal, onProgress });
  if (sodaComponents()) return;
  if (process.platform !== 'win32') throw fail('当前免安装组件支持 Windows x64 和 Apple Silicon Mac。请使用对应架构的 Node.js。');
  if (process.arch !== 'x64') throw fail('免安装组件目前支持 Windows x64。请改用 x64 Node.js 24 或更新版本。');
  return prepareWindowsSdk({ dataDir, signal, onProgress });
}
async function prepareWindowsSdk(options = {}) {
  try { return await provisionWindowsSdk(options); }
  catch (error) {
    if (error.code === 'setup') throw error;
    cancelled(options.signal);
    if (error.name === 'TimeoutError') throw fail('下载汽水组件超时，请检查网络后重试。');
    if (['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw fail('无法写入汽水组件缓存，请检查磁盘空间和插件数据目录权限。');
    throw fail('准备汽水组件失败，请检查网络和系统归档工具后重试。');
  }
}
async function provisionWindowsSdk({ dataDir, signal, onProgress = () => {} } = {}) {
  const owner = ownedDir(dataDir);
  await fs.promises.mkdir(owner, { recursive: true });
  if ((await fs.promises.lstat(owner)).isSymbolicLink()) throw fail('插件数据目录不能是符号链接。');
  const use = sdk => { process.env.MYGO_QISHUI_SDK_DIR = path.dirname(path.dirname(sdk.asar)); };
  const cached = await cachedWindowsSdk(owner, signal);
  if (cached) { use(cached); return; }
  onProgress('正在准备免安装汽水组件，首次需下载约 144 MiB…');
  const release = await acquireLock(owner, signal);
  let downloadDir;
  try {
    const ready = await cachedWindowsSdk(owner, signal);
    if (ready) { use(ready); return; }
    downloadDir = await fs.promises.mkdtemp(path.join(owner, '.native-download-'));
    const file = path.join(downloadDir, 'official.exe');
    await download(file, signal, onProgress);
    const sdk = await extractWindowsPackage({ packageFile: file, dataDir: owner, signal, onProgress });
    use(sdk);
  } finally {
    if (downloadDir) await fs.promises.rm(downloadDir, { recursive: true, force: true });
    await release();
  }
}
module.exports = { prepareSdk, prepareWindowsSdk, extractWindowsPackage, cachedWindowsSdk,
  sdkInternals: { ownedDir, digest, acquireLock, downloadPinned: download, fail, cancelled } };
