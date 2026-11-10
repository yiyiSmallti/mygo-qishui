// Read-only account requests, isolated cache, real helpers and MyGo decoders.
// Never print credentials, native stdout, signed URLs or encryption metadata.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { createContext, SourceTextModule } from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../', import.meta.url)), pluginDir = path.join(repo, 'qishui-account');
const output = path.resolve(process.argv[2]);
const decoder = path.resolve(process.argv[3]);
const sdkArchive = process.argv[4] ? path.resolve(process.argv[4]) : '';
const profile = process.env.MYGO_QISHUI_DATA || path.join(process.platform === 'win32' ? process.env.APPDATA
  : path.join(os.homedir(), 'Library/Application Support'), 'MyGo Music/plugin-data/qishui-account');
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qishui-live-cenc-'));
const owner = path.join(temp, 'plugin-data/qishui-account'); fs.mkdirSync(owner, { recursive: true });
const storageFile = path.join(profile, 'storage.json'), original = fs.readFileSync(storageFile);
const stored = JSON.parse(original), children = new Set(), cases = [];
const events = path.join(temp, 'events.jsonl'), guard = path.join(temp, 'guard.cjs');
fs.writeFileSync(events, '');
fs.writeFileSync(guard, `
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const record=event=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({event,pid:process.pid})+'\\n');
const officialApps=['/Applications/汽水音乐.app',path.join(require('node:os').homedir(),'Applications/汽水音乐.app')];
for(const name of ['existsSync','statSync','lstatSync','readFileSync','readdirSync','accessSync']){const original=fs[name];fs[name]=function(file,...args){if(typeof file==='string'&&officialApps.some(root=>file===root||file.startsWith(root+'/'))){record('blocked-official-app-access');throw new Error('OFFICIAL_APP_ACCESS');}return original.call(this,file,...args);};}
for(const method of ['spawn','spawnSync','execFile','execFileSync','exec','execSync']) {
 const original=cp[method];cp[method]=function(command,...args){
  if(command!==process.execPath){record('blocked-external-process');throw new Error('EXTERNAL_EXECUTABLE_BLOCKED');}
  record('node-helper');return original.call(this,command,...args);
 };
}
const fetch=global.fetch;global.fetch=function(url,...args){const u=new URL(url);if(u.hostname.endsWith('.douyinvod.com')||u.hostname.endsWith('.qishui.com')&&u.hostname!=='api.qishui.com')record('audio-fetch');return fetch.call(this,url,...args);};
`);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const eventList = () => fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
const downloads = () => eventList().filter(e => e.event === 'audio-fetch').length;
const report = () => fs.writeFileSync(path.join(output, 'live-media.json'), JSON.stringify({
  ok: cases.length > 0 && cases.every(c => c.ok), platform: process.platform, node: process.version,
  ffmpegBlockedInPlayback: true, externalProcessAttempts: eventList().filter(e => e.event === 'blocked-external-process').length,
  originalStorageUnchanged: crypto.createHash('sha256').update(original).digest('hex') === digest(storageFile), cases,
  officialAppAccessAttempts: eventList().filter(e => e.event === 'blocked-official-app-access').length,
}, null, 2));
function decode(file) {
  const child = spawnSync(decoder, [file], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
  let value; try { value = JSON.parse(child.stdout); } catch { throw new Error('MYGO_DECODER_NO_RESULT'); }
  assert.equal(child.status, 0, 'MYGO_DECODER_FAILED'); assert.equal(value.ok, true);
  return value;
}
const context = createContext({ URL, AbortController, TypeError, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('UNEXPECTED_PLUGIN_FETCH'); },
  host: {
    platform: process.platform === 'win32' ? 'windows' : 'darwin', arch: process.arch,
    dataDir: owner, setting: k => k === 'nodePath' ? process.execPath : '',
    storage: { get: k => clone(stored[k]), set: (k, v) => { stored[k] = clone(v); }, remove: k => { delete stored[k]; } },
    signInPrompt() { throw new Error('SIGN_IN_OUTSIDE_SCOPE'); },
    spawn(command, args) {
      assert.equal(command, process.execPath);
      const child = spawn(command, args, { cwd: pluginDir, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(guard)}` } });
      children.add(child); child.stdin.on('error', () => {}); child.once('exit', () => children.delete(child));
      const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const ready = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      return { write: text => child.stdin.write(text), closeStdin: () => child.stdin.end(),
        readLine: async () => { await ready; const line = await lines.next(); return line.done ? null : line.value; } };
    },
  },
});

try {
  if (sdkArchive) {
    assert.equal(process.platform, 'darwin');
    await require(path.join(pluginDir, 'native-sdk-mac.cjs')).extractMacPackage({ packageFile: sdkArchive, dataDir: owner });
  }
  await require(path.join(pluginDir, 'native-sdk.cjs')).prepareSdk({ dataDir: owner });
  const module = new SourceTextModule(fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8'), { context });
  await module.link(() => { throw new Error('UNEXPECTED_IMPORT'); }); await module.evaluate();
  const api = module.namespace;
  const { getSearchMetadata, getTrackMetadata } = require(path.join(pluginDir, 'media-request.cjs'));
  const session = stored['qishui-session-v1']; assert.ok(session?.jar && session?.account?.id);
  const options = { device: session.device || stored['qishui-device-v1'], jar: session.jar };
  function tracks(o, found = [], depth = 0) {
    if (!o || typeof o !== 'object' || depth > 9) return found;
    if (!Array.isArray(o) && o.media_type === 'track' && /^\d{1,32}$/.test(String(o.id || o.track_id || '')))
      found.push(String(o.id || o.track_id));
    for (const v of Object.values(o)) if (v && typeof v === 'object') tracks(v, found, depth + 1);
    return [...new Set(found)];
  }
  const candidates = tracks(await getSearchMetadata({ ...options, query: '海阔天空', kind: 'track' }));
  let id;
  for (const candidate of candidates.slice(0, 5)) {
    const meta = await getTrackMetadata({ ...options, trackId: candidate });
    if (meta.track_player?.video_model_type !== 1) continue;
    const model = JSON.parse(meta.track_player.video_model);
    if (['higher', 'highest', 'lossless'].every(q => model.video_list.some(s => s.video_meta?.quality === q))) { id = candidate; break; }
  }
  assert.ok(id, 'NO_FULL_AAC_AND_FLAC_SAMPLE');
  for (const quality of ['standard', 'high', 'lossless']) {
    let start = Date.now(), before = downloads();
    const cold = await api.stream({ id, quality });
    const preparedMs = Date.now() - start;
    assert.equal(cold.type, 'm4a');
    const file = fileURLToPath(cold.url), hash = digest(file), stat = fs.statSync(file);
    const native = decode(file);
    assert.ok(downloads() > before, 'COLD_CACHE_MUST_DOWNLOAD');
    cases.push({ name: `cold-${quality}`, ok: true, bytes: stat.size, playbackPreparationMs: preparedMs,
      quality: cold.quality, originalMyGoDecoder: native }); report();
    before = downloads(); start = Date.now();
    const hot = await api.stream({ id, quality });
    assert.equal(hot.url, cold.url); assert.equal(digest(file), hash);
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs); assert.equal(downloads(), before);
    cases.push({ name: `cache-${quality}`, ok: true, noAudioDownload: true, ms: Date.now() - start }); report();
    if (quality === 'standard') {
      const b = fs.readFileSync(file); b[b.length - 1] ^= 1; fs.writeFileSync(file, b);
      before = downloads();
      await api.stream({ id, quality });
      assert.ok(downloads() > before); assert.equal(digest(file), hash); decode(file);
      cases.push({ name: 'tampered-cache-regenerated', ok: true }); report();
    }
  }
  const cached = await api.stream({ id, quality: 'standard' }), cachedFile = fileURLToPath(cached.url);
  const expectedHash = digest(cachedFile);
  fs.unlinkSync(cachedFile); fs.unlinkSync(cachedFile + '.json');
  fs.mkdirSync(cachedFile + '.lock');
  const stale = new Date(Date.now() - 60000); fs.utimesSync(cachedFile + '.lock', stale, stale);
  const secondModule = new SourceTextModule(fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8'), { context });
  await secondModule.link(() => { throw new Error('UNEXPECTED_IMPORT'); }); await secondModule.evaluate();
  const simultaneous = await Promise.all([api.stream({ id, quality: 'standard' }),
    secondModule.namespace.stream({ id, quality: 'standard' })]);
  assert.equal(simultaneous[0].url, simultaneous[1].url); assert.equal(digest(cachedFile), expectedHash);
  assert.ok(!fs.readdirSync(path.dirname(cachedFile)).some(n => /\.(part|receipt-part|lock)$/.test(n)));
  cases.push({ name: 'concurrent-helpers-and-stale-publication-lock', ok: true });
  assert.equal(eventList().filter(e => e.event === 'blocked-external-process').length, 0);
  assert.equal(eventList().filter(e => e.event === 'blocked-official-app-access').length, 0);
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), digest(storageFile));
  report(); console.log('LIVE_MEDIA_RESULT:' + JSON.stringify({ ok: true, cases: cases.length }));
} catch (error) {
  cases.push({ name: 'verification-failure', ok: false, code: /^[A-Z_0-9]{1,50}$/.test(error.code || '') ? error.code : undefined,
    mediaCode: ['unavailable', 'unsupported', 'setup', 'signIn'].includes(error.code) ? error.code : undefined,
    safeMediaMessage: ['unavailable', 'unsupported', 'setup', 'signIn'].includes(error.code)
      ? String(error.message).replace(/https?:\/\/\S+/g, '[URL]').replace(/[A-Za-z0-9_+/=%.-]{32,}/g, '[hidden]').slice(0, 180) : undefined,
    assertion: /^(?:[A-Z_]+|MYGO_DECODER_FAILED|NO_FULL_AAC_AND_FLAC_SAMPLE)$/.test(error.message || '') ? error.message : undefined });
  report(); console.log('LIVE_MEDIA_RESULT:' + JSON.stringify({ ok: false, completedCases: cases.length - 1 }));
  process.exitCode = 1;
} finally {
  for (const child of children) { child.stdin.end(); child.kill(); }
  fs.rmSync(temp, { recursive: true, force: true });
}
