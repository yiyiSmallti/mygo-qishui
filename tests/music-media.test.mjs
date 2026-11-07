import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, createContext } from 'node:vm';

const source = await readFile(new URL('../qishui-account/index.js', import.meta.url), 'utf8');
const SESSION = 'qishui-session-v1';
const DEVICE = 'qishui-device-v1';
const TRACK = '7631943856258566161';
const HASH = 'a'.repeat(64);
const CACHE = 'file:///C:/Users/22589/AppData/Roaming/MyGo%20Music/plugin-data/qishui-account/media-cache/';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const session = () => ({
  jar: { 'sessionid|/': { name: 'sessionid', value: 'fake-private-session', path: '/', expires: 0 } },
  account: { id: '7631943856258566100', name: '测试账号' },
  device: { schema: 1, aid: 386088, did: '71234567890123456', iid: '71234567890123457' },
});
const streamValue = (overrides = {}) => ({ url: CACHE + HASH + '.flac', type: 'flac', quality: 'standard', bitRate: 256000, size: 1024, ...overrides });
const ok = value => ({ ok: true, value });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function harness(replies = [], options = {}) {
  const stored = new Map(Object.entries(clone(options.saved ?? { [SESSION]: session() })));
  const spawned = [], inputs = [], helpers = [], timers = new Map();
  let timerId = 0;
  const context = createContext({
    URL, AbortController, TypeError,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    host: {
      platform: 'windows', arch: 'amd64',
      storage: {
        get: key => clone(stored.get(key)),
        set: (key, value) => stored.set(key, clone(value)),
        remove: key => stored.delete(key),
      },
      spawn(command, args) {
        spawned.push({ command, args: clone(args) });
        const reply = replies.shift();
        const started = deferred();
        const helper = {
          closes: 0, started,
          write(text) { inputs.push(text); },
          closeStdin() { helper.closes++; options.onClose?.(helper); },
          async readLine() {
            started.resolve();
            const result = typeof reply === 'function' ? await reply() : reply;
            return result === null || result === undefined || typeof result === 'string' ? result : JSON.stringify(result);
          },
        };
        helpers.push(helper);
        return helper;
      },
      signInPrompt() { throw new Error('Media requests must not open login prompts'); },
    },
    fetch: async () => { throw new Error('Media RPC tests must not make network requests'); },
  });
  const module = new SourceTextModule(source, { context });
  await module.link(() => { throw new Error('Unexpected plugin import'); });
  await module.evaluate();
  return { api: module.namespace, stored, spawned, helpers, inputs, timers };
}

test('stream returns only a validated local FLAC cache and passes credentials over private stdin', async () => {
  const value = streamValue();
  const h = await harness([ok(value)]);
  assert.deepEqual(clone(await h.api.stream({ id: TRACK, quality: 'high' })), value);
  assert.deepEqual(h.spawned, [{ command: String.raw`C:\Program Files\nodejs\node.exe`, args: ['./media-helper.cjs'] }]);
  assert.equal(h.inputs.length, 1);
  assert.ok(h.inputs[0].endsWith('\n'));
  const input = JSON.parse(h.inputs[0]);
  assert.equal(input.operation, 'stream');
  assert.equal(input.trackId, TRACK);
  assert.equal(input.quality, 'high');
  assert.equal(input.accountId, session().account.id);
  assert.deepEqual(input.jar, session().jar);
  assert.equal(JSON.stringify(h.spawned).includes('fake-private-session'), false);
  assert.equal(h.helpers[0].closes, 1);
  assert.equal(h.timers.size, 0);
});

test('UGC clips retain the media type for playback and lyrics, while videos report unsupported', async () => {
  const h = await harness([ok(streamValue()), ok({ content: '' })]);
  await h.api.stream({ id: 'ugc_clip:' + TRACK });
  await h.api.lyrics({ id: 'ugc_clip:' + TRACK });
  for (const line of h.inputs) {
    assert.equal(JSON.parse(line).trackId, TRACK);
    assert.equal(JSON.parse(line).mediaType, 'ugc_clip');
  }
  await assert.rejects(h.api.stream({ id: 'ugc_video:' + TRACK }), e => e.code === 'unsupported');
  assert.equal(h.spawned.length, 2);
});

test('stream rejects HTTP, network shares, non-FLAC and paths outside its local media cache', async t => {
  const invalid = [
    ['HTTP media response', streamValue({ url: 'https://api.qishui.com/audio.flac' })],
    ['plain HTTP', streamValue({ url: 'http://example.invalid/audio.flac' })],
    ['relative path', streamValue({ url: './media-cache/' + HASH + '.flac' })],
    ['network share', streamValue({ url: 'file://server/share/MyGo%20Music/plugin-data/qishui-account/media-cache/' + HASH + '.flac' })],
    ['arbitrary local file', streamValue({ url: 'file:///C:/Windows/' + HASH + '.flac' })],
    ['different plugin', streamValue({ url: CACHE.replace('qishui-account', 'other-plugin') + HASH + '.flac' })],
    ['nested cache path', streamValue({ url: CACHE + 'nested/' + HASH + '.flac' })],
    ['bad hash', streamValue({ url: CACHE + 'short.flac' })],
    ['encoded traversal', streamValue({ url: CACHE + '%2e%2e/' + HASH + '.flac' })],
    ['different file format', streamValue({ url: CACHE + HASH + '.mp3' })],
    ['false format declaration', streamValue({ type: 'mp3' })],
  ];
  for (const [name, value] of invalid) await t.test(name, async () => {
    const h = await harness([ok(value)]);
    await assert.rejects(h.api.stream({ id: TRACK }), e => e.code === 'unavailable');
    assert.equal(h.helpers[0].closes, 1);
  });
});

test('local cache whitelist rejects lookalike roots and URL decorations', async t => {
  const invalid = [
    ['lookalike cache outside app data', 'file:///C:/Temp/MyGo%20Music/plugin-data/qishui-account/media-cache/' + HASH + '.flac'],
    ['another Windows user', CACHE.replace('/Users/22589/', '/Users/Other/') + HASH + '.flac'],
    ['query attached to file URL', CACHE + HASH + '.flac?download=1'],
    ['fragment attached to file URL', CACHE + HASH + '.flac#fragment'],
    ['invalid percent encoding', CACHE.replace('MyGo%20Music', 'MyGo%ZZMusic') + HASH + '.flac'],
  ];
  for (const [name, url] of invalid) await t.test(name, async () => {
    const h = await harness([ok(streamValue({ url }))]);
    await assert.rejects(h.api.stream({ id: TRACK }), e => e.code === 'unavailable');
  });
});

test('same in-flight song and quality share one helper, but different quality does not', async () => {
  const waiting = deferred();
  const h = await harness([() => waiting.promise, ok(streamValue({ quality: 'lossless' }))]);
  const first = h.api.stream({ id: TRACK, quality: 'standard' });
  const duplicate = h.api.stream({ id: TRACK, quality: 'standard' });
  assert.equal(h.spawned.length, 1);
  const other = h.api.stream({ id: TRACK, quality: 'lossless' });
  assert.equal(h.spawned.length, 2);
  waiting.resolve(ok(streamValue()));
  const results = await Promise.all([first, duplicate, other]);
  assert.deepEqual(clone(results[0]), clone(results[1]));
  assert.equal(results[2].quality, 'lossless');
  assert.ok(h.helpers.every(helper => helper.closes === 1));
  assert.equal(h.timers.size, 0);
});

test('finished requests leave the in-flight map so a later retry gets a fresh helper', async () => {
  const h = await harness([ok(streamValue()), ok(streamValue())]);
  await h.api.stream({ id: TRACK });
  await h.api.stream({ id: TRACK });
  assert.equal(h.spawned.length, 2);
});

test('signed-out requests cannot start a media helper', async () => {
  const h = await harness([], { saved: {} });
  await assert.rejects(h.api.stream({ id: TRACK }), e => e.code === 'signIn');
  await assert.rejects(h.api.lyrics({ id: TRACK }), e => e.code === 'signIn');
  assert.equal(h.spawned.length, 0);
});

test('signOut closes pending helpers and rejects late audio without returning it', async () => {
  const waiting = deferred();
  const h = await harness([() => waiting.promise]);
  const pending = h.api.stream({ id: TRACK });
  const rejected = assert.rejects(pending, /账号已变化|已取消/);
  await h.helpers[0].started.promise;
  h.api.signOut();
  assert.ok(h.helpers[0].closes >= 1);
  assert.equal(h.stored.has(SESSION), false);
  waiting.resolve(ok(streamValue()));
  await rejected;
  assert.equal(h.timers.size, 0);
});

test('old-account failure after signOut cannot remove a newly stored account', async () => {
  const waiting = deferred();
  const h = await harness([() => waiting.promise]);
  const pending = h.api.lyrics({ id: TRACK });
  const rejected = assert.rejects(pending, /账号已变化|已取消/);
  await h.helpers[0].started.promise;
  h.api.signOut();
  const replacement = session();
  replacement.account.id = '7631943856258566200';
  h.stored.set(SESSION, replacement);
  waiting.resolve({ ok: false, code: 'signIn', message: '旧账号已经失效' });
  await rejected;
  assert.equal(h.stored.get(SESSION).account.id, replacement.account.id);
});

test('helper expiration clears only the active login while ordinary unavailable errors retain it', async () => {
  for (const code of ['signIn', 'unavailable']) {
    const h = await harness([{ ok: false, code, message: '暂时无法获取这首歌' }]);
    await assert.rejects(h.api.stream({ id: TRACK }), e => e.code === code);
    assert.equal(h.stored.has(SESSION), code !== 'signIn');
    assert.equal(h.helpers[0].closes, 1);
  }
});

test('malformed helper replies fail safely and clean up the process and timer', async () => {
  for (const reply of [null, '{', 'null', '42', 'x'.repeat(4 * 1024 * 1024 + 1), { ok: true, value: null }]) {
    const h = await harness([reply]);
    await assert.rejects(h.api.stream({ id: TRACK }), e => e.code === 'unavailable');
    assert.equal(h.helpers[0].closes, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('timeout closes helper input and returns a bounded failure instead of hanging', async () => {
  const waiting = deferred();
  const h = await harness([() => waiting.promise]);
  const pending = h.api.stream({ id: TRACK });
  const rejected = assert.rejects(pending, e => e.code === 'unavailable' && /超时/.test(e.message));
  await h.helpers[0].started.promise;
  const timeout = [...h.timers.values()].find(timer => timer.delay === 28500);
  assert.ok(timeout);
  timeout.fn();
  await rejected;
  assert.ok(h.helpers[0].closes >= 1);
  assert.equal(h.timers.size, 0);
  waiting.resolve(null);
});

test('lyrics RPC produces absolute millisecond line and word timestamps', async () => {
  const content = '[32570,1100]<0,370,0>听<440,370,0>说，<810,290,0>你\n[35000,1000]没有逐字时间';
  const h = await harness([ok({ content })]);
  assert.deepEqual(clone(await h.api.lyrics({ id: TRACK })), { lines: [
    { start: 32570, end: 33670, text: '听说，你', words: [
      { start: 32570, end: 32940, text: '听' },
      { start: 33010, end: 33380, text: '说，' },
      { start: 33380, end: 33670, text: '你' },
    ] },
    { start: 35000, end: 36000, text: '没有逐字时间' },
  ] });
  const input = JSON.parse(h.inputs[0]);
  assert.equal(input.operation, 'lyrics');
  assert.equal(input.trackId, TRACK);
  assert.equal(h.helpers[0].closes, 1);
});

test('missing lyrics return an empty millisecond line list rather than fabricated lyrics', async () => {
  for (const value of [{}, { content: null }, { content: '[ar:artist]\n[bad]metadata' }]) {
    const h = await harness([ok(value)]);
    assert.deepEqual(clone(await h.api.lyrics({ id: TRACK })), { lines: [] });
  }
});
