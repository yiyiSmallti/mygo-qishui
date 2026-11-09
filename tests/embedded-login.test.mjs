import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, createContext } from 'node:vm';

const source = await readFile(new URL('../qishui-account/index.js', import.meta.url), 'utf8');
const SESSION = 'qishui-session-v1';
const DEVICE = 'qishui-device-v1';
const DIAGNOSTIC = 'qishui-login-diagnostic-v1';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const account = { id: '7631943856258566161', name: '测试账号' };
const device = { schema: 1, aid: 386088, did: '71234567890123456', iid: '71234567890123457', clientVersion: '3.7.0' };
const deviceMessage = () => ({ type: 'device', device: clone(device), computerName: 'DESKTOP-QISHUI', osLabel: 'Windows' });
const cookie = () => ({ name: 'sessionid', value: 'test-session', path: '/', expires: 0 });
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
  const storageWrites = [], prompts = [], fetches = [], spawned = [], inputs = [], loginInputs = [], timers = new Map();
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
  const loginHelper = {
    write: text => { loginInputs.push(JSON.parse(text)); options.onLoginStart?.(); },
    closeStdin: () => { closed++; options.onClose?.(); },
    readLine: async () => {
      const result = options.loginRead ? await options.loginRead() : { cookie: 'sessionid=test-session' };
      return JSON.stringify(result.error ? { type: 'error', ...result.error } : { type: 'complete', cookie: result.cookie });
    },
  };
  const context = createContext({
    URL, AbortController, TypeError,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    host: {
      platform: options.platform || 'windows', arch: 'amd64',
      dataDir: options.dataDir,
      storage: {
        get: key => clone(data.get(key)),
        set: (key, value) => { data.set(key, clone(value)); storageWrites.push({ key, value: clone(value) }); },
        remove: key => data.delete(key),
      },
      spawn: (command, args) => {
        spawned.push({ command, args: clone(args) });
        if (options.spawnError) throw new Error(options.spawnError);
        return command.includes("native/") ? loginHelper : helper;
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
  return { api: module.namespace, data, storageWrites, prompts, fetches, spawned, inputs, loginInputs, timers, get closed() { return closed; } };
}

test('helper transport uses private JSON lines and validates identity before saving the session', async () => {
  let h;
  h = await harness([{ type: 'progress', text: '正在准备' }, deviceMessage()], {
    saved: { [DIAGNOSTIC]: { code: '2156' } },
    dataDir: 'C:\\mygo-data',
    loginRead: async () => {
      assert.deepEqual(h.data.get(DEVICE), device);
      assert.equal(h.closed, 1);
      return { cookie: 'sessionid=test-session' };
    },
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
  assert.deepEqual(h.spawned, [{ command: 'node', args: ['./device-helper.cjs'] }, { command: './native/qishui-login.exe', args: [] }]);
  assert.equal(h.inputs.length, 1);
  assert.ok(h.inputs[0].endsWith('\n'));
  assert.deepEqual(JSON.parse(h.inputs[0]), { type: 'start', device: null, dataDir: 'C:\\mygo-data' });
  assert.deepEqual(h.data.get(DEVICE), device);
  assert.deepEqual(h.data.get(SESSION).account, account);
  assert.equal(h.data.has(DIAGNOSTIC), false);
  assert.deepEqual(h.loginInputs, [{ type: 'start', device, computerName: 'DESKTOP-QISHUI', osLabel: 'Windows', timeoutMs: 240000 }]);
  assert.equal(h.fetches.length, 1);
  assert.equal(h.closed, 2);
  assert.equal(h.timers.size, 0);
});

test('only the plugin-owned device record is passed to a new login', async () => {
  const h = await harness([], { saved: { [DEVICE]: device, [SESSION]: oldSession() } });
  await assert.rejects(h.api.signIn(), /辅助程序已退出/);
  assert.deepEqual(JSON.parse(h.inputs[0]), { type: 'start', device });
  assert.equal(h.inputs[0].includes('test-session'), false);
  assert.deepEqual(h.data.get(SESSION), oldSession());
});

test('unusable embedded credentials are never a login', async () => {
  for (const result of [{ cookie: '' }, { cookie: 'sessionid=value\r\nInjected: bad' }]) {
    const h = await harness([deviceMessage()], { saved: { [SESSION]: oldSession() }, loginRead: async () => result });
    await assert.rejects(h.api.signIn());
    assert.deepEqual(h.data.get(SESSION), oldSession());
    assert.equal(h.fetches.length, 0);
    assert.equal(h.closed, 2);
  }
});

test('server identity is authoritative when embedded login succeeds', async () => {
  const verified = { id: 'different-user', name: '不同账号' };
  const h = await harness([deviceMessage()], { saved: { [SESSION]: oldSession() }, fetch: async () => response(me({ id: verified.id, nickname: verified.name })) });
  assert.deepEqual(clone(await h.api.signIn()), verified);
  assert.deepEqual(h.data.get(SESSION).account, verified);
  assert.equal(h.fetches.length, 1);
  assert.equal(h.closed, 2);
});

test('account validation failure never overwrites a saved session', async () => {
  const h = await harness([deviceMessage()], { saved: { [SESSION]: oldSession() }, fetch: async () => response({ status_code: 1000016 }) });
  await assert.rejects(h.api.signIn(), /登录已失效/);
  assert.deepEqual(h.data.get(SESSION), oldSession());
});

test('embedded login errors preserve the previous session', async () => {
  for (const code of ['closed', 'timeout', 'load', '2046']) {
    const h = await harness([deviceMessage()], { saved: { [SESSION]: oldSession() }, loginRead: async () => ({ error: { code, message: '登录失败' } }) });
    await assert.rejects(h.api.signIn());
    assert.deepEqual(h.data.get(SESSION), oldSession());
    assert.equal(h.fetches.length, 0);
    assert.equal(h.closed, 2);
  }
});

test('EOF, malformed messages, and unknown events close the helper without saving credentials', async () => {
  for (const item of [null, '{', 'null', '42', { type: 'unexpected' }, { type: 'qr', url: 'https://example.com/' }, { type: 'complete', cookies: [cookie()] }, 'x'.repeat(262145)]) {
    const h = await harness([item]);
    await assert.rejects(h.api.signIn(), /辅助程序已退出|无效消息|未知消息/);
    assert.equal(h.data.has(SESSION), false);
    assert.equal(h.closed, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('signOut during account verification closes the helper and prevents stale persistence', async () => {
  const waiting = deferred(), reached = deferred();
  const h = await harness([deviceMessage()], { fetch: async () => { reached.resolve(); return waiting.promise; } });
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
  const stock = await harness([deviceMessage()]);
  assert.deepEqual(clone(await stock.api.signIn()), account);
  assert.equal(stock.spawned.length, 2);
  const other = await harness([], { platform: 'linux' });
  await assert.rejects(other.api.signIn(), /仅适配 Windows 和 macOS/);
  assert.equal(other.spawned.length, 0);
  const denied = await harness([], { spawnError: 'the listener has not allowed this plugin to start programs' });
  await assert.rejects(denied.api.signIn(), /not allowed/);
  assert.equal(denied.fetches.length, 0);
  assert.equal(denied.data.has(SESSION), false);
});
