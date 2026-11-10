// Build once for distribution; listeners do not need Git, Go or PowerShell.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2]) throw new Error('用法：node scripts/build-style-player.mjs <未修改的 MyGo 0.1.22 源码目录> [输出目录]');
const input = resolve(process.argv[2]);
const output = resolve(process.argv[3] || join(root, 'dist/style-support/windows-amd64'));
if (!/version:\s*["']0\.1\.22["']/.test(readFileSync(join(input, 'mygo.config.ts'), 'utf8')) ||
    !readFileSync(join(input, 'go.mod'), 'utf8').startsWith('module mygo-music\n')) throw new Error('仅支持 MyGo Music v0.1.22 源码。');
const temporary = mkdtempSync(join(tmpdir(), 'mygo-layout-build-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('构建样式增强失败。', { cause: result.error });
}
try {
  const source = join(temporary, 'source');
  cpSync(input, source, { recursive: true, filter(path) {
    if (path === input) return true;
    const name = basename(path);
    return !name.startsWith('.') && !['node_modules', 'dist', 'cmd', 'plugin-data', 'media-cache', 'artifacts'].includes(name) && !name.startsWith('build');
  } });
  const patch = join(root, 'patches/mygo-0.1.22-layout-only.patch');
  run('git', ['apply', '--check', patch], source);
  run('git', ['apply', patch], source);
  const build = join(temporary, 'build');
  run('go', ['tool', 'mygo', 'build', '-platform', 'windows/amd64', '-skip-installer', '-o', build], source);
  mkdirSync(output, { recursive: true });
  const binary = join(build, 'windows-amd64/MyGo Music.exe');
  if (!existsSync(binary)) throw new Error('构建未生成 Windows 主程序。');
  copyFileSync(binary, join(output, 'MyGo Music.exe'));
  run('go', ['run', './cmd/style-source', '-root', source, '-out', join(output, 'corresponding-source.zip')], join(root, 'login-helper'));
  console.log(output);
} finally { rmSync(temporary, { recursive: true, force: true }); }
