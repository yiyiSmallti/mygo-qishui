'use strict';
// Private IPC gateway; native SDK stderr/stdout never enter MyGo's logs.
// Assisted-by: Cindy (https://cindy.app)
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
let worker, finished = false;
const input = readline.createInterface({ input: process.stdin });
const timeout = setTimeout(() => finish({ ok: false, code: 'unavailable', message: '获取音乐超时，请稍后重试或选择较低音质。' }), 28000);
function finish(message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  process.exitCode = message.ok ? 0 : 1;
  process.stdout.write(JSON.stringify(message) + '\n');
  if (worker) worker.stdin.end();
  // Give cancellation enough time to close FFmpeg before deleting temporary
  // files. The host receives the result immediately, independently of cleanup.
  setTimeout(() => { if (worker && worker.exitCode === null) worker.kill(); process.exit(message.ok ? 0 : 1); }, 1200).unref();
}
input.once('line', line => {
  if (line.length > 262144) return finish({ ok: false, code: 'unavailable', message: '播放连接参数无效。' });
  try { JSON.parse(line); } catch { return finish({ ok: false, code: 'unavailable', message: '播放连接参数无效。' }); }
  worker = spawn(process.execPath, [path.join(__dirname, 'media-worker.cjs')], {
    cwd: __dirname, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  worker.stdin.on('error', () => {});
  const output = readline.createInterface({ input: worker.stdout });
  output.on('line', text => {
    if (!text.startsWith('MYGO_MEDIA_RESULT:') || text.length > 4 * 1024 * 1024) return;
    try {
      const message = JSON.parse(text.slice('MYGO_MEDIA_RESULT:'.length));
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.ok !== 'boolean') throw new Error();
      finish(message);
    }
    catch { finish({ ok: false, code: 'unavailable', message: '播放组件返回无效数据。' }); }
  });
  worker.on('error', () => finish({ ok: false, code: 'unavailable', message: '无法启动播放组件。' }));
  worker.on('exit', () => { if (!finished) finish({ ok: false, code: 'unavailable', message: '播放组件提前退出，请重试。' }); });
  worker.stdin.write(line + '\n');
});
input.on('close', () => {
  if (worker) worker.stdin.end();
  if (!finished) {
    finished = true; clearTimeout(timeout);
    setTimeout(() => { if (worker && worker.exitCode === null) worker.kill(); process.exit(0); }, 1200).unref();
  }
});
