import { mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] || join(root, 'dist/login-helper'));
for (const [os, arch, name] of [['windows', 'amd64', 'qishui-login.exe'], ['darwin', 'arm64', 'qishui-login']]) {
  const target = join(output, `${os}-${arch}`); mkdirSync(target, { recursive: true });
  const path = join(target, name);
  const flags = os === 'windows' ? '-s -w -H=windowsgui' : '-s -w';
  const result = spawnSync('go', ['build', '-buildvcs=false', '-trimpath', `-ldflags=${flags}`, '-o', path, '.'], {
    cwd: join(root, 'login-helper'), env: { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch }, stdio: 'inherit',
  });
  if (result.error || result.status !== 0) throw new Error(`构建 ${os}/${arch} 登录组件失败。`, { cause: result.error });
  chmodSync(path, 0o755);
  if (os === 'darwin' && process.platform === 'darwin') {
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', path], { stdio: 'inherit' });
    if (signed.status !== 0) throw new Error('Mac 登录组件签名失败。');
  }
  console.log(path);
}
