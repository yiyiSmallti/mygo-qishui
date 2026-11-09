'use strict';
// Private IPC gateway; native SDK stderr/stdout never enter MyGo's logs.
// Assisted-by: Cindy (https://cindy.app)
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { prepareSdk } = require('./native-sdk.cjs');
let worker, finished = false, preparing = false;
const sdkController = new AbortController();
const input = readline.createInterface({ input: process.stdin });
let timeout;
function arm() { timeout = setTimeout(() => finish({ ok: false, code: 'unavailable', message: '获取音乐超时，请稍后重试或选择较低音质。' }), 28000); }
arm();
function finish(message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  sdkController.abort();
  process.exitCode = message.ok ? 0 : 1;
  process.stdout.write(JSON.stringify(message) + '\n');
  if (worker) worker.stdin.end();
  setTimeout(() => { if (worker && worker.exitCode === null) worker.kill(); process.exit(message.ok ? 0 : 1); }, 1200).unref();
}
input.once('line', async line => {
  if (line.length > 262144) return finish({ ok: false, code: 'unavailable', message: '播放连接参数无效。' });
  let message;
  try { message = JSON.parse(line); if (!message || typeof message !== 'object') throw new Error(); }
  catch { return finish({ ok: false, code: 'unavailable', message: '播放连接参数无效。' }); }
  try {
    clearTimeout(timeout);
    preparing = true;
    await prepareSdk({ dataDir: typeof message.cacheDir === 'string' ? path.dirname(message.cacheDir) : '', signal: sdkController.signal,
      onProgress: text => { if (!finished) process.stdout.write(JSON.stringify({ type: 'progress', text }) + '\n'); } });
    preparing = false;
    if (finished) return;
    process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
    arm();
  } catch (error) {
    preparing = false;
    return finish({ ok: false, code: 'setup', message: error.code === 'setup' ? error.message : '汽水组件准备失败，请检查网络后重试。' });
  }
  worker = spawn(process.execPath, [path.join(__dirname, 'media-worker.cjs')], {
    cwd: __dirname, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  worker.stdin.on('error', () => {});
  const output = readline.createInterface({ input: worker.stdout });
  output.on('line', text => {
    if (!text.startsWith('MYGO_MEDIA_RESULT:') || text.length > 4 * 1024 * 1024) return;
    try {
      const result = JSON.parse(text.slice('MYGO_MEDIA_RESULT:'.length));
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw new Error();
      finish(result);
    } catch { finish({ ok: false, code: 'unavailable', message: '播放组件返回无效数据。' }); }
  });
  worker.on('error', () => finish({ ok: false, code: 'unavailable', message: '无法启动播放组件。' }));
  worker.on('exit', () => { if (!finished) finish({ ok: false, code: 'unavailable', message: '播放组件提前退出，请重试。' }); });
  worker.stdin.write(line + '\n');
});
input.on('close', () => {
  sdkController.abort();
  if (worker) worker.stdin.end();
  if (!finished) {
    finished = true; clearTimeout(timeout);
    // During preparation its finally blocks must remove partial downloads.
    if (!preparing) setTimeout(() => { if (worker && worker.exitCode === null) worker.kill(); process.exit(0); }, 1200).unref();
  }
});
