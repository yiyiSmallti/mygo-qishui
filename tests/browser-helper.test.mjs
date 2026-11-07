import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, createContext } from 'node:vm';

const source = await readFile(new URL('../qishui-account/index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../qishui-account/plugin.json', import.meta.url), 'utf8'));
const SESSION = 'qishui-session-v1';
const DEVICE = 'qishui-device-v1';
const DIAGNOSTIC = 'qishui-login-diagnostic-v1';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const account = { id: '7631943856258566161', name: '测试账号' };
const device = { schema: 1, aid: 386088, did: '71234567890123456', iid: '71234567890123457', clientVersion: '3.7.0' };
const qrURL = 'https://bff-pc.qishui.com/light/invoke/scan_login?token=abc123&os=Windows&computer_name=MyGo%20Music';
const qr = () => ({ type: 'qr', url: qrURL, status: 'new' });
const cookie = () => ({ name: 'sessionid', value: 'test-session', path: '/', expires: 0 });
const complete = () => ({ type: 'complete', cookies: [cookie()], account: clone(account) });
const me = (info = { id: account.id, nickname: account.name }) => ({ status_code: 0, my_info: info });
const oldSession = () => ({ jar: { 'sessionid|/': cookie() }, account: { id: 'old-id', name: '原账号' } });
const response = body => ({ status: 200, ok: true, headers: { getSetCookie: () => [] }, text: async () => JSON.stringify(body) });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function harness(messages = [], options = {}) {
  const data = new Map(Object.entries(clone(options.saved || {})));
  const storageWrites = [], prompts = [], fetches = [], spawned = [], inputs = [], timers = new Map();
  let closed = 0, timerId = 0;
  const helper = {
    write: text => inputs.push(text),
    closeStdin: () => { closed++; options.onClose?.(); },
    readLine: async () => {
      const next = messages.length ? messages.shift() : null;
      const value = typeof next === 'function' ? await next() : next;
      return typeof value === 'string' || value === null ? value : JSON.stringify(value);
    },
  };
  const context = createContext({
    URL, AbortController, TypeError,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    host: {
      platform: options.platform || 'windows', arch: 'amd64',
      storage: {
        get: key => clone(data.get(key)),
        set: (key, value) => { data.set(key, clone(value)); storageWrites.push({ key, value: clone(value) }); },
        remove: key => data.delete(key),
      },
      spawn: (command, args) => {
        spawned.push({ command, args: clone(args) });
        if (options.spawnError) throw new Error(options.spawnError);
        return helper;
      },
      signInPrompt: prompt => prompts.push(clone(prompt)),
    },
    fetch: async (url, config) => {
      fetches.push({ url, config });
      assert.equal(new URL(url).origin, 'https://api.qishui.com');
      assert.equal(new URL(url).pathname, '/luna/pc/me');
      assert.equal(config.redirect, 'manual');
      return options.fetch ? options.fetch(url, config) : response(me());
    },
  });
  const module = new SourceTextModule(source, { context });
  await module.link(() => { throw new Error('Plugin must not import modules'); });
  await module.evaluate();
  return { api: module.namespace, data, storageWrites, prompts, fetches, spawned, inputs, timers, get closed() { return closed; } };
}

test('helper transport uses private JSON lines and validates identity before saving the session', async () => {
  let h;
  h = await harness([{ type: 'device', device }, qr(), { ...qr(), status: 'scanned' }, complete()], {
    saved: { [DIAGNOSTIC]: { code: '2156' } },
    fetch: async (url, config) => {
      assert.equal(h.data.has(SESSION), false);
      assert.equal(config.headers.Cookie, 'sessionid=test-session');
      const query = new URL(url).searchParams;
      assert.equal(query.get('device_id'), device.did);
      assert.equal(query.get('install_id'), device.iid);
      assert.equal(Object.keys(config.headers).some(key => /passport/i.test(key)), false);
      return response(me());
    },
  });
  assert.deepEqual(clone(await h.api.signIn()), account);
  assert.deepEqual(h.spawned, [{ command: String.raw`C:\Program Files\nodejs\node.exe`, args: ['./browser-helper.cjs'] }]);
  assert.equal(h.inputs.length, 1);
  assert.ok(h.inputs[0].endsWith('\n'));
  assert.deepEqual(JSON.parse(h.inputs[0]), { type: 'start', device: null });
  assert.deepEqual(h.data.get(DEVICE), device);
  assert.deepEqual(h.data.get(SESSION).account, account);
  assert.equal(h.data.has(DIAGNOSTIC), false);
  assert.ok(h.prompts.some(p => /已扫码/.test(p.text)));
  assert.equal(h.closed, 1);
  assert.equal(h.timers.size, 0);
});

test('only the plugin-owned device record is passed to a new login', async () => {
  const h = await harness([], { saved: { [DEVICE]: device, [SESSION]: oldSession() } });
  await assert.rejects(h.api.signIn(), /辅助程序已退出/);
  assert.deepEqual(JSON.parse(h.inputs[0]), { type: 'start', device });
  assert.equal(h.inputs[0].includes('test-session'), false);
  assert.deepEqual(h.data.get(SESSION), oldSession());
});

test('helper completion without a QR or usable credentials is never a login', async () => {
  for (const messages of [[complete()], [qr(), { ...complete(), cookies: [] }], [qr(), { ...complete(), cookies: [{ ...cookie(), value: 'value\r\nInjected: bad' }] }]]) {
    const h = await harness(messages);
    await assert.rejects(h.api.signIn(), /不完整|尚未取得/);
    assert.equal(h.data.has(SESSION), false);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.closed, 1);
  }
});

test('verified account mismatch leaves the previous account untouched', async () => {
  const h = await harness([qr(), complete()], { saved: { [SESSION]: oldSession() }, fetch: async () => response(me({ id: 'different-user', nickname: '不同账号' })) });
  await assert.rejects(h.api.signIn(), /账号校验结果不一致/);
  assert.deepEqual(h.data.get(SESSION), oldSession());
  assert.equal(h.closed, 1);
});

test('account validation failure never overwrites a saved session', async () => {
  const h = await harness([qr(), complete()], { saved: { [SESSION]: oldSession() }, fetch: async () => response({ status_code: 1000016 }) });
  await assert.rejects(h.api.signIn(), /登录已失效/);
  assert.deepEqual(h.data.get(SESSION), oldSession());
});

test('invalid or changed QR targets are rejected before displaying them', async () => {
  for (const url of [
    'https://example.com/light/invoke/scan_login?token=abc123',
    'http://bff-pc.qishui.com/light/invoke/scan_login?token=abc123',
    'https://user:pass@bff-pc.qishui.com/light/invoke/scan_login?token=abc123',
    'https://bff-pc.qishui.com/other?token=abc123',
    'https://bff-pc.qishui.com/light/invoke/scan_login?token=abc123&token=abc123',
    'https://bff-pc.qishui.com/light/invoke/scan_login',
  ]) {
    const h = await harness([{ ...qr(), url }]);
    await assert.rejects(h.api.signIn(), /二维码来源或会话/);
    assert.equal(h.prompts.some(p => p.qr), false);
    assert.equal(h.data.has(SESSION), false);
  }
  const h = await harness([qr(), { ...qr(), url: qrURL.replace('abc123', 'other-token') }]);
  await assert.rejects(h.api.signIn(), /二维码来源或会话/);
  assert.equal(h.prompts.filter(p => p.qr).length, 1);
});

test('server 2156 stops the bridge and stores a bounded redacted diagnostic', async () => {
  const h = await harness([{ type: 'device', device }, qr(), {
    type: 'error', code: '2156', stage: '扫码确认', status: 'unknown',
    description: '系统繁忙 abc123 https://api.qishui.com/private?secret=abcdef123456 ' + 'x'.repeat(300),
  }, complete()]);
  await assert.rejects(h.api.signIn(), error => /2156/.test(error.message) && !/abc123|https:\/\//.test(error.message));
  const d = h.data.get(DIAGNOSTIC);
  assert.equal(d.version, manifest.version, 'diagnostics identify the installed plugin version');
  assert.equal(d.code, '2156');
  assert.equal(d.stage, '扫码确认');
  assert.ok(d.description.length <= 160);
  assert.equal(JSON.stringify(d).includes('abc123'), false);
  assert.equal(h.data.has(SESSION), false);
  assert.deepEqual(h.data.get(DEVICE), device, 'independently registered device may be reused');
  assert.equal(h.fetches.length, 0);
  assert.equal(h.closed, 1);
});

test('2046 retains explicit security-verification failure', async () => {
  const h = await harness([qr(), { type: 'error', stage: '扫码确认', code: '2046', description: '需要验证' }]);
  await assert.rejects(h.api.signIn(), /额外安全验证/);
  assert.equal(h.data.has(SESSION), false);
});

test('EOF, malformed messages, and unknown events close the helper without saving credentials', async () => {
  for (const item of [null, '{', 'null', '42', { type: 'unexpected' }, 'x'.repeat(262145)]) {
    const h = await harness([item]);
    await assert.rejects(h.api.signIn(), /辅助程序已退出|无效消息|未知消息/);
    assert.equal(h.data.has(SESSION), false);
    assert.equal(h.closed, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('signOut during account verification closes the helper and prevents stale persistence', async () => {
  const waiting = deferred(), reached = deferred();
  const h = await harness([qr(), complete()], { fetch: async () => { reached.resolve(); return waiting.promise; } });
  const signing = h.api.signIn();
  await reached.promise;
  h.api.signOut();
  waiting.resolve(response(me()));
  await assert.rejects(signing, /登录已取消/);
  assert.equal(h.data.has(SESSION), false);
  assert.ok(h.closed >= 1);
});

test('signOut while waiting on helper output stops the attempt', async () => {
  const waiting = deferred(), reached = deferred();
  const h = await harness([async () => { reached.resolve(); return waiting.promise; }], { onClose: () => waiting.resolve(null) });
  const signing = h.api.signIn();
  await reached.promise;
  h.api.signOut();
  await assert.rejects(signing, /登录已取消/);
  assert.equal(h.data.has(SESSION), false);
});

test('a concurrent signIn does not start a second helper', async () => {
  const waiting = deferred(), reached = deferred();
  const h = await harness([async () => { reached.resolve(); return waiting.promise; }], { onClose: () => waiting.resolve(null) });
  const first = h.api.signIn();
  await reached.promise;
  await assert.rejects(h.api.signIn(), /登录窗口已打开/);
  assert.equal(h.spawned.length, 1);
  h.api.signOut();
  await assert.rejects(first, /登录已取消/);
});

test('bridge timeout closes input and prevents indefinite waiting', async () => {
  const waiting = deferred(), reached = deferred();
  const h = await harness([async () => { reached.resolve(); return waiting.promise; }]);
  const signing = h.api.signIn();
  await reached.promise;
  const timeout = [...h.timers.values()].find(item => item.delay === 255000);
  assert.ok(timeout);
  timeout.fn();
  await assert.rejects(signing, /登录已超时/);
  assert.equal(h.data.has(SESSION), false);
  assert.ok(h.closed >= 1);
  assert.equal(h.timers.size, 0);
  waiting.resolve(null);
});

test('unsupported platform and denied process permission do not start network requests', async () => {
  const other = await harness([], { platform: 'darwin' });
  await assert.rejects(other.api.signIn(), /仅适配 Windows/);
  assert.equal(other.spawned.length, 0);
  const denied = await harness([], { spawnError: 'the listener has not allowed this plugin to start programs' });
  await assert.rejects(denied.api.signIn(), /not allowed/);
  assert.equal(denied.fetches.length, 0);
  assert.equal(denied.data.has(SESSION), false);
});
