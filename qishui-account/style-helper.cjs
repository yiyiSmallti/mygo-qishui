// The short-lived launcher hands ownership to a detached, user-confirmed dialog.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('platform');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024) throw new Error('input');
  }
  if (JSON.parse(input).type !== 'open-layout-installer') throw new Error('input');
  const root = path.join(__dirname, 'native');
  const executable = path.join(root, 'style-installer.exe');
  if (!fs.statSync(executable).isFile()) throw new Error('payload');
  let child, timer, handedOff = false, readyShown = false;
  try {
    child = spawn(executable, ['--parent', String(process.ppid)], {
      cwd: root, detached: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false,
    });
    const result = await new Promise((resolve, reject) => {
      let output = '';
      timer = setTimeout(() => reject(new Error('timeout')), 12000);
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 1024) { reject(new Error('output')); return; }
        const end = output.indexOf('\n');
        if (end !== -1) {
          try { resolve(JSON.parse(output.slice(0, end))); } catch { reject(new Error('output')); }
        }
      });
      child.stdout.once('close', () => reject(new Error('closed')));
    });
    clearTimeout(timer);
    if (result.ready !== true || !['ready', 'busy'].includes(result.code)) throw new Error('setup');
    if (result.code === 'ready') {
      // The native installer now owns its transaction, even on transport error.
      handedOff = true;
      await new Promise((resolve, reject) => {
        child.stdin.once('error', reject);
        child.stdin.end('continue\n', resolve);
      });
    }
    child.stdin.destroy(); child.stdout.destroy(); child.unref();
    readyShown = true;
    emit({ type: 'ready', status: result.code });
  } finally {
    clearTimeout(timer);
    if (child) {
      if (!handedOff && !readyShown) child.kill();
      child.stdin?.destroy(); child.stdout?.destroy(); child.unref();
    }
  }
}
main().catch(() => { emit({ type: 'error', code: 'setup' }); process.exitCode = 1; });
