import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
files.push('research/music-recommend.test.mjs', 'research/music-likes.test.mjs');
const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
