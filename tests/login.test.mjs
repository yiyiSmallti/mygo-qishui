import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, createContext } from 'node:vm';

const source = await readFile(new URL('../qishui-account/index.js', import.meta.url), 'utf8');
const KEY = 'qishui-session-v1';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const accountData = { status_code: 0, my_info: { id: '7631943856258566161', nickname: '测试账号' } };
const initialSession = () => ({
  jar: { 'sessionid|/': { name: 'sessionid', value: 'test-session', path: '/', expires: 0 } },
  account: { id: 'old-id', name: '原账号' },
});
const response = (json, cookies = [], status = 200) => ({
  status, ok: status >= 200 && status < 300,
  headers: { getSetCookie: () => cookies, get: () => cookies.join(', ') },
  text: async () => typeof json === 'string' ? json : JSON.stringify(json),
});
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function harness(steps = [], saved) {
  const data = new Map(saved ? [[KEY, clone(saved)]] : []);
  const calls = [], writes = [], prompts = [], removed = [];
  let timerId = 0;
  const context = createContext({
    URL, AbortController, TypeError,
    setTimeout(fn, delay) {
      // Only accelerate poll waits; request timeout callbacks must not fire.
      if (delay === 2000) queueMicrotask(fn);
      return ++timerId;
    },
    clearTimeout() {},
    host: {
      platform: 'windows',
      storage: {
        get: k => clone(data.get(k)),
        set: (k, v) => { if (k === KEY) writes.push(clone(v)); data.set(k, clone(v)); },
        remove: k => { removed.push(k); data.delete(k); },
      },
      signInPrompt: p => prompts.push(clone(p)),
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(new URL(url).origin, 'https://api.qishui.com');
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      const step = steps.shift();
      assert.ok(step, `Unexpected network request: ${new URL(url).pathname}`);
      return typeof step === 'function' ? await step(url, options) : step;
    },
  });
  const module = new SourceTextModule(source, { context });
  await module.link(() => { throw new Error('Plugin must not import external modules'); });
  await module.evaluate();
  return { api: module.namespace, data, calls, writes, prompts, removed, steps };
}

test('signed-out account does not make a network request', async () => {
  const h = await harness();
  assert.equal(await h.api.account(), null);
  assert.equal(h.calls.length, 0);
});

test('session invalidation clears local credentials', async () => {
  const h = await harness([response({ status_code: 1000016 })], initialSession());
  assert.equal(await h.api.account(), null);
  assert.equal(h.data.has(KEY), false);
  assert.deepEqual(h.removed, [KEY]);
});

test('temporary network failures preserve credentials and show a useful message', async () => {
  const h = await harness([() => { throw new TypeError('fetch failed'); }], initialSession());
  await assert.rejects(h.api.account(), /无法连接汽水音乐/);
  assert.equal(h.data.has(KEY), true);
  assert.equal(h.removed.length, 0);
});

test('signOut clears the local session without issuing a remote destructive request', async () => {
  const h = await harness([], initialSession());
  h.api.signOut();
  assert.equal(h.data.has(KEY), false);
  assert.equal(await h.api.account(), null);
  assert.equal(h.calls.length, 0);
});

test('signOut during account validation prevents stale login from being restored', async () => {
  const pending = deferred(), reached = deferred();
  const h = await harness([() => { reached.resolve(); return pending.promise; }], initialSession());
  const checking = h.api.account();
  await reached.promise;
  h.api.signOut();
  pending.resolve(response(accountData));
  assert.equal(await checking, null);
  assert.equal(h.data.has(KEY), false);
  assert.equal(h.writes.length, 0);
});

test('redirects are rejected without following or leaking credentials', async () => {
  const h = await harness([response('', [], 302)], initialSession());
  await assert.rejects(h.api.account(), /跳转验证/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.data.has(KEY), true);
});

test('unsupported numeric account IDs fail instead of losing precision', async () => {
  const h = await harness([response({ status_code: 0, my_info: { id: 7631943856258566161, nickname: '测试账号' } })], initialSession());
  await assert.rejects(h.api.account(), /账号标识不完整/);
  assert.equal(h.writes.length, 0);
});

test('malformed account payloads preserve the stored account and report a useful error', async () => {
  for (const payload of [null, [], 42, { status_code: 'invalid', my_info: { id: 'id', nickname: 'name' } }]) {
    const h = await harness([response(payload)], initialSession());
    await assert.rejects(h.api.account(), error => error.name !== 'TypeError' && /账号|数据|校验/.test(error.message));
    assert.equal(h.data.has(KEY), true);
    assert.equal(h.writes.length, 0);
  }
});
