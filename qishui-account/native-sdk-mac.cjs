'use strict';
// Prepare only the pinned native components, never a client installation.
// The official small archive needs no DMG mount or third-party extractor.
// Assisted-by: Cindy (https://cindy.app)
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { sdkInternals: { ownedDir, digest, acquireLock, downloadPinned, fail, cancelled } } = require('./native-sdk.cjs');

const PACKAGE = Object.freeze({
  url: 'https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-darwin_arm64.tgz',
  sha256: '40c6bc80aa32cd1d5c76ad1b05bccc67e5ec22cf779b6dc3617ee5432b88ee04',
  size: 19001509,
});
const FILES = Object.freeze({
  'app.asar': '9b5682f4dc46da89dbd0722b53adedf192f78a652f9164454e32365780890522',
  'app.asar.unpacked/device.node': 'e330f0a9adec183a5fee3005ba42fd293d83e7f1df0610e58e32f387ab79a8b0',
  'app.asar.unpacked/bdms.node': 'bb8858680af4360d4da706caccfbbc73cfdf3f8cafebcb4f521ca7b782cb4bb2',
  'app.asar.unpacked/libMetaSecML.dylib': '078db186b335c8400f5b8bb48762ef8ac36ff055f60576775a4334587bba760c',
});
const CACHE = 'native-sdk-3.7.0-darwin-arm64';
async function directory(dir) {
  const stat = await fs.promises.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('汽水组件目录不完整或包含符号链接，请重新准备组件。');
}
function hasArm64(bytes) {
  if (bytes.length < 12) return false;
  if (bytes.readUInt32LE(0) === 0xfeedfacf) return bytes.readUInt32LE(4) === 0x0100000c;
  const magic = bytes.readUInt32BE(0);
  if (![0xcafebabe, 0xcafebabf].includes(magic)) return false;
  const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabe ? 20 : 32;
  if (count < 1 || count > 32 || 8 + count * stride > bytes.length) return false;
  for (let i = 0; i < count; i++) if (bytes.readUInt32BE(8 + i * stride) === 0x0100000c) return true;
  return false;
}
async function validateFiles(root, signal) {
  await directory(root);
  const resources = path.join(root, 'resources');
  await directory(resources); await directory(path.join(resources, 'app.asar.unpacked'));
  for (const [name, expected] of Object.entries(FILES)) {
    cancelled(signal);
    const file = path.join(resources, name), stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await digest(file, signal) !== expected)
      throw fail('Mac 汽水组件不完整或校验失败，请重新准备组件。');
    if (name.endsWith('.node') || name.endsWith('.dylib')) {
      const handle = await fs.promises.open(file, 'r');
      try {
        const header = Buffer.alloc(4096); const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (!hasArm64(header.subarray(0, bytesRead))) throw fail('Mac 汽水组件架构无效，需要 Apple Silicon ARM64 组件。');
      } finally { await handle.close(); }
    }
  }
  return { asar: path.join(resources, 'app.asar'), unpacked: path.join(resources, 'app.asar.unpacked') };
}
async function cachedMacSdk(dataDir, signal) {
  const root = path.join(ownedDir(dataDir), CACHE);
  try {
    await directory(root);
    const meta = path.join(root, 'sdk.json'), stat = await fs.promises.lstat(meta);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const manifest = JSON.parse(await fs.promises.readFile(meta, 'utf8'));
    if (manifest.schema !== 1 || manifest.version !== '3.7.0' || manifest.arch !== 'arm64'
        || manifest.platform !== 'darwin' || manifest.packageSha256 !== PACKAGE.sha256) return null;
    return await validateFiles(root, signal);
  } catch (error) {
    cancelled(signal);
    if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError || error.code === 'setup') return null;
    throw error;
  }
}
function unpack(archive, destination, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/tar', ['-xzf', archive, '-C', destination, '--', ...Object.keys(FILES)],
      { stdio: 'ignore', signal });
    let timedOut = false, startError;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
    child.once('error', error => { startError = error; });
    child.once('close', code => {
      clearTimeout(timeout);
      if (signal?.aborted) reject(fail('组件准备已取消。'));
      else if (startError) reject(fail('无法启动 macOS 系统 tar，请检查系统归档工具。'));
      else if (timedOut) reject(fail('提取 Mac 汽水组件超时，请重试。'));
      else if (code !== 0) reject(fail('macOS 系统 tar 未能提取汽水组件，请检查归档工具与磁盘空间。'));
      else resolve();
    });
  });
}
async function extractMacPackage({ packageFile, dataDir, signal, onProgress = () => {} }) {
  const owner = ownedDir(dataDir);
  cancelled(signal);
  const stat = await fs.promises.lstat(packageFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== PACKAGE.size || await digest(packageFile, signal) !== PACKAGE.sha256)
    throw fail('Mac 汽水官方归档校验失败，未加载任何组件。请重新下载。');
  await fs.promises.mkdir(owner, { recursive: true }); await directory(owner);
  const staging = await fs.promises.mkdtemp(path.join(owner, '.native-sdk-mac-'));
  const destination = path.join(owner, CACHE), previous = path.join(owner, '.native-sdk-old-' + randomUUID());
  let moved = false, published = false;
  try {
    const resources = path.join(staging, 'resources'); await fs.promises.mkdir(resources);
    onProgress('正在提取 Mac 汽水官方组件…');
    await unpack(packageFile, resources, signal);
    await validateFiles(staging, signal);
    await fs.promises.writeFile(path.join(staging, 'sdk.json'), JSON.stringify({ schema: 1,
      version: '3.7.0', platform: 'darwin', arch: 'arm64', source: PACKAGE.url, packageSha256: PACKAGE.sha256 }) + '\n',
    { flag: 'wx', mode: 0o600 });
    cancelled(signal);
    try { await fs.promises.rename(destination, previous); moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.promises.rename(staging, destination); published = true; }
    catch (error) { if (moved) { await fs.promises.rename(previous, destination); moved = false; } throw error; }
    return { asar: path.join(destination, 'resources/app.asar'), unpacked: path.join(destination, 'resources/app.asar.unpacked') };
  } finally {
    if (!published) await fs.promises.rm(staging, { recursive: true, force: true });
    if (published && moved) await fs.promises.rm(previous, { recursive: true, force: true });
  }
}
async function provision({ dataDir, signal, onProgress = () => {} }) {
  cancelled(signal);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw fail('Mac 免安装组件目前支持 Apple Silicon。请使用 ARM64 Node.js 24 或更新版本。');
  const owner = ownedDir(dataDir);
  await fs.promises.mkdir(owner, { recursive: true }); await directory(owner);
  const use = sdk => { process.env.MYGO_QISHUI_SDK_DIR = path.dirname(path.dirname(sdk.asar)); };
  const cached = await cachedMacSdk(owner, signal);
  if (cached) { use(cached); return; }
  onProgress('正在准备 Mac 免安装汽水组件，首次需下载约 18 MiB…');
  const release = await acquireLock(owner, signal);
  let downloadDir;
  try {
    const ready = await cachedMacSdk(owner, signal);
    if (ready) { use(ready); return; }
    downloadDir = await fs.promises.mkdtemp(path.join(owner, '.native-download-'));
    const file = path.join(downloadDir, 'official-mac.tgz');
    await downloadPinned(file, signal, onProgress, PACKAGE);
    const sdk = await extractMacPackage({ packageFile: file, dataDir: owner, signal, onProgress });
    use(sdk);
  } finally {
    if (downloadDir) await fs.promises.rm(downloadDir, { recursive: true, force: true });
    await release();
  }
}
async function prepareMacSdk(options = {}) {
  try { return await provision(options); }
  catch (error) {
    if (error.code === 'setup') throw error;
    cancelled(options.signal);
    if (['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw fail('无法写入 Mac 汽水组件缓存，请检查磁盘空间和插件数据目录权限。');
    if (error.name === 'TimeoutError') throw fail('下载 Mac 汽水组件超时，请检查网络后重试。');
    throw fail('准备 Mac 汽水组件失败，请检查网络和系统归档工具后重试。');
  }
}

module.exports = { prepareMacSdk, extractMacPackage, cachedMacSdk };
