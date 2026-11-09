import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const require = createRequire(import.meta.url);
const workerSource = fs.readFileSync(new URL('../qishui-account/media-worker.cjs', import.meta.url), 'utf8');
const requestSource = fs.readFileSync(new URL('../qishui-account/media-request.cjs', import.meta.url), 'utf8');
const gatewaySource = fs.readFileSync(new URL('../qishui-account/media-helper.cjs', import.meta.url), 'utf8');
const testRoot = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(testRoot, '.media-worker-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(testRoot));
    assert.ok(path.basename(resolved).startsWith('.media-worker-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

function flac(durationMs = 10000) {
  const bytes = Buffer.alloc(256);
  bytes.write('fLaC'); bytes[4] = 0x80; bytes.writeUIntBE(34, 5, 3);
  const samples = BigInt(Math.round(44100 * durationMs / 1000));
  bytes.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | samples, 18);
  return bytes;
}

function loadWorker(root, options = {}) {
  const fsMock = { ...fs, existsSync: value => String(value).endsWith('.exe') || fs.existsSync(value),
    promises: { ...fs.promises, ...options.promises } };
  const prefix = workerSource.slice(0, workerSource.indexOf('\nconst input = readline.createInterface({ input: process.stdin });'));
  assert.ok(prefix.length > 1000);
  const context = vm.createContext({
    Buffer, URL, AbortController, process: { env: { APPDATA: root } },
    setTimeout(fn, delay) { return delay === 26000 ? { fakeTimer: true } : setTimeout(fn, delay); },
    clearTimeout(timer) { if (!timer?.fakeTimer) clearTimeout(timer); },
    fetch: options.fetch || (() => { throw new Error('Unexpected network request'); }),
    require(name) {
      if (name === 'node:fs') return fsMock;
      if (name === 'node:child_process') return { spawn: options.spawn || (() => { throw new Error('Unexpected process'); }) };
      if (name === './media-request.cjs') return { getTrackMetadata() {}, getSearchMetadata() {} };
      if (name === './local-env.cjs') return require('../qishui-account/local-env.cjs');
      if (name.endsWith('device.node')) throw new Error('Native decoder must not run in unit tests');
      return require(name);
    },
  });
  new vm.Script(prefix + '\nglobalThis.testApi = { download, convert, prepareStream, validCachedFlac, stopEncoder };').runInContext(context);
  return context.testApi;
}

function encoder(output, events = []) {
  const child = new EventEmitter(); child.stdout = new PassThrough();
  child.kill = () => { events.push('kill'); setImmediate(() => { child.stdout.end(); events.push('close'); child.emit('close', 1); }); };
  if (output) {
    fs.writeFileSync(output, flac());
    setImmediate(() => {
      // Deliberately deliver exit before the final stdout progress event.
      child.emit('exit', 0);
      child.stdout.end('out_time_us=10000000\n');
      setImmediate(() => { events.push('close'); child.emit('close', 0); });
    });
  }
  return child;
}

test('download handles partial FileHandle writes without truncating audio', async t => {
  const root = fixture(t), payload = Buffer.alloc(200, 0x5a), written = [];
  let closed = false;
  const api = loadWorker(root, {
    fetch: async () => ({ ok: true, headers: { get: () => '200' }, body: (async function* () { yield payload; })() }),
    promises: { open: async () => ({
      async write(chunk, offset, length) { const size = Math.min(length, 11); written.push(Buffer.from(chunk.subarray(offset, offset + size))); return { bytesWritten: size }; },
      async close() { closed = true; },
    }) },
  });
  await api.download('https://v1-luna.douyinvod.com/test', path.join(root, 'audio'));
  assert.deepEqual(Buffer.concat(written), payload);
  assert.equal(closed, true);
});

test('conversion waits for close so final progress is included', async t => {
  const root = fixture(t), output = path.join(root, 'result.flac');
  const api = loadWorker(root, { spawn(command, args) {
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    return encoder(output);
  } });
  await api.convert(path.join(root, 'input.audio'), output, '', 10000);
});

test('cached FLAC must have a valid header and the current authorized duration', async t => {
  const root = fixture(t), file = path.join(root, 'cache.flac'), api = loadWorker(root);
  fs.writeFileSync(file, Buffer.alloc(256)); assert.equal(await api.validCachedFlac(file, 10000), false);
  fs.writeFileSync(file, flac()); assert.equal(await api.validCachedFlac(file, 10000), true);
  assert.equal(await api.validCachedFlac(file, 20000), false);
  fs.writeFileSync(file, flac().subarray(0, 20)); assert.equal(await api.validCachedFlac(file, 10000), false);
});

test('a bad existing cache is regenerated only after a full authorized response', async t => {
  const root = fixture(t), cache = path.join(root, 'MyGo Music', 'plugin-data', 'qishui-account', 'media-cache');
  fs.mkdirSync(cache, { recursive: true });
  const name = crypto.createHash('sha256').update('test-account:123:higher:10000').digest('hex') + '.flac';
  fs.writeFileSync(path.join(cache, name), Buffer.alloc(256));
  let conversions = 0;
  const api = loadWorker(root, {
    fetch: async () => ({ ok: true, headers: { get: () => '200' }, body: (async function* () { yield Buffer.alloc(200); })() }),
    spawn(command, args) { conversions++; return encoder(args.at(-1)); },
  });
  const data = { risk_result: 0, track: { duration: 10000 }, track_player: { video_model_type: 1,
    video_model: JSON.stringify({ video_duration: 10, video_list: [{ main_url: 'https://v1-luna.douyinvod.com/test', video_meta: { quality: 'higher' } }] }) } };
  const result = await api.prepareStream({ accountId: 'test-account', trackId: '123', cacheDir: cache }, data);
  assert.equal(result.type, 'flac'); assert.equal(conversions, 1);
  assert.equal(await api.validCachedFlac(path.join(cache, name), 10000), true);
  data.track_player.video_model_type = 2;
  await assert.rejects(api.prepareStream({ accountId: 'test-account', trackId: '123', cacheDir: cache }, data), /完整音频/);
  assert.equal(conversions, 1, 'a cached file must not turn a preview authorization into full playback');
});

test('encoder cleanup waits for its close event before returning', async t => {
  const root = fixture(t), events = [], output = path.join(root, 'out');
  const api = loadWorker(root, { spawn: () => encoder(null, events) });
  const conversion = api.convert('input', output, '', 10000);
  const rejected = assert.rejects(conversion, /音频转换未完成/);
  await api.stopEncoder(); await rejected;
  assert.deepEqual(events, ['kill', 'close']);
});

test('published UGC clip model 3 requires matching media type and complete clip duration', async t => {
  const root = fixture(t), cache = path.join(root, 'MyGo Music', 'plugin-data', 'qishui-account', 'media-cache');
  fs.mkdirSync(cache, { recursive: true });
  const name = crypto.createHash('sha256').update('ugc_clip:test-account:123:higher:10000').digest('hex') + '.flac';
  fs.writeFileSync(path.join(cache, name), flac());
  const api = loadWorker(root);
  const message = { accountId: 'test-account', trackId: '123', mediaType: 'ugc_clip', cacheDir: cache };
  const data = { risk_result: 0, track: { duration: 10000, media_type: 'ugc_clip' }, track_player: { video_model_type: 3,
    video_model: JSON.stringify({ video_duration: 10, video_list: [{ main_url: 'https://v1-luna.douyinvod.com/test', video_meta: { quality: 'higher' } }] }) } };
  const result = await api.prepareStream(message, data);
  assert.equal(result.type, 'flac');
  assert.ok(result.url.endsWith(name));
  await assert.rejects(api.prepareStream({ ...message, mediaType: 'track' }, data), /完整音频/);
  await assert.rejects(api.prepareStream(message, { ...data, track: { ...data.track, media_type: 'track' } }), /完整音频/);
  await assert.rejects(api.prepareStream(message, { ...data, track_player: { ...data.track_player, video_model_type: 2 } }), /完整音频/);
  const short = { ...data, track_player: { ...data.track_player, video_model: JSON.stringify({ video_duration: 5, video_list: [] }) } };
  await assert.rejects(api.prepareStream(message, short), /时长不足/);
});

test('gateway discards native stdout and validates private result envelopes', async () => {
  const input = new PassThrough(), worker = new EventEmitter(), output = [];
  worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.kill = () => {};
  const timers = [];
  const context = vm.createContext({
    __dirname: '.', AbortController,
    process: { stdin: input, stdout: { write: text => output.push(text) }, execPath: 'node', exit() {}, exitCode: 0 },
    setTimeout(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {},
    require: name => name === 'node:child_process' ? { spawn: () => worker }
      : name === './native-sdk.cjs' ? { prepareSdk: async () => {} } : require(name),
  });
  new vm.Script(gatewaySource).runInContext(context);
  input.write('{"operation":"lyrics"}\n');
  await new Promise(resolve => setImmediate(resolve));
  worker.stdout.write('native internal diagnostic\n');
  worker.stdout.write('MYGO_MEDIA_RESULT:null\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(output.length, 2);
  const result = JSON.parse(output[1]);
  assert.equal(result.ok, false); assert.equal(result.code, 'unavailable');
  assert.equal(output.join('').includes('native internal'), false);
  assert.equal(context.process.exitCode, 1);
  input.end(); worker.stdout.end(); worker.stdin.end();
});

test('signed requests reject nested status_info errors including expired sessions', async () => {
  const device = { aid: 386088, did: '123456789012345', iid: '987654321012345', identityType: 'fresh-plugin-pseudonymous', channel: 'mygo' };
  const jar = { 'sessionid|/': { name: 'sessionid', value: 'test-only', path: '/', expires: 0 } };
  let responseData = { status_code: 0, status_info: { code: 1000016 } }, requestBody;
  const context = vm.createContext({
    Buffer, URL, AbortController, setTimeout, clearTimeout, Intl, module: { exports: {} },
    fetch: async (url, options) => {
      requestBody = options.body && JSON.parse(options.body);
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(responseData) };
    },
    require: name => name.endsWith('bdms.node') ? { init() {}, generateHttpSignatureHeaders: () => 'x-test\r\ntest\r\n' }
      : require(name === './local-env.cjs' ? '../qishui-account/local-env.cjs' : name),
  });
  new vm.Script(requestSource).runInContext(context);
  const api = context.module.exports;
  await assert.rejects(api.getTrackMetadata({ trackId: '123', device, jar }), e => e.code === 'signIn');
  responseData = { status_info: { status_code: 123 } };
  await assert.rejects(api.getSearchMetadata({ query: 'test', device, jar }), e => e.code === 'qishuiApi' && e.statusCode === 123);
  responseData = { status_code: 0 };
  await api.getTrackMetadata({ trackId: '123', mediaType: 'ugc_clip', device, jar });
  assert.equal(requestBody.media_type, 'ugc_clip');
  await assert.rejects(api.getTrackMetadata({ trackId: '123', mediaType: 'ugc_video', device, jar }), e => e.code === 'unsupported');
});
