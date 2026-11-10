// Offline end-to-end replay: real plugin entry, gateway, worker, CENC file
// processing and original MyGo decoder. Only upstream API/CDN and native
// authorization are replaced by generated fixtures in an ephemeral preload.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { SourceTextModule, createContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const out = path.resolve(process.argv[2]), decoder = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const plugin = fileURLToPath(new URL('../qishui-account/', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qishui-pipeline-'));
const dataDir = path.join(temp, 'plugin-data/qishui-account'); fs.mkdirSync(dataDir, { recursive: true });
const stateFile = path.join(temp, 'scenario.json'), events = path.join(temp, 'events.jsonl');
const preload = path.join(temp, 'fixture.cjs'), key = crypto.randomBytes(16), results = [], children = new Set(), references = {};
const ffmpeg = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
fs.writeFileSync(events, '');
const state = value => fs.writeFileSync(stateFile, JSON.stringify(value)); state({});
const eventCount = event => fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)).filter(x => x === event).length;
function command(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  if (r.status !== 0 && exe === decoder) fs.writeFileSync(path.join(out, 'decoder-failure.json'), r.stdout);
  assert.equal(r.status, 0, path.basename(exe) + ' failed'); return r.stdout;
}
function decoded(file) { const result = JSON.parse(command(decoder, [file])); assert.equal(result.ok, true); return result; }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function clean() { assert.ok(!fs.readdirSync(path.join(dataDir, 'media-cache')).some(n => /\.(part|receipt-part|lock)$/.test(n))); }
const session = { account: { id: 'synthetic-account' }, device: { did: '1', iid: '2' },
  jar: { 'sessionid|/': { name: 'sessionid', value: 'synthetic-fixture', path: '/', expires: 0 } } };
const stored = { 'qishui-session-v1': session };
const context = createContext({ URL, AbortController, TypeError, setTimeout, clearTimeout,
  host: {
    platform: process.platform === 'win32' ? 'windows' : 'darwin', arch: process.arch, dataDir,
    setting: k => k === 'nodePath' ? process.execPath : '',
    storage: { get: k => structuredClone(stored[k]), set: (k, v) => { stored[k] = structuredClone(v); }, remove: k => { delete stored[k]; } },
    spawn(exe, args) {
      assert.equal(exe, process.execPath);
      const child = spawn(exe, args, { cwd: plugin, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(preload) } });
      children.add(child); child.stdin.on('error', () => {}); child.once('exit', () => children.delete(child));
      const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const ready = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      return { write: value => child.stdin.write(value), closeStdin: () => child.stdin.end(),
        readLine: async () => { await ready; const row = await lines.next(); return row.done ? null : row.value; } };
    },
  },
});
async function entry() {
  const m = new SourceTextModule(fs.readFileSync(path.join(plugin, 'index.js'), 'utf8'), { context });
  await m.link(() => { throw new Error('Unexpected import'); }); await m.evaluate(); return m.namespace;
}
try {
  for (const codec of ['aac', 'flac']) {
    const encrypted = path.join(temp, codec + '.mp4'), clear = path.join(temp, codec + '-clear.m4a');
    command(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=44100:duration=8',
      '-ac', '2', '-c:a', codec, ...(codec === 'aac' ? ['-b:a', '128k'] : ['-strict', '-2']),
      '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', key.toString('hex'),
      '-encryption_kid', crypto.randomBytes(16).toString('hex'), '-f', 'mp4', encrypted]);
    command(ffmpeg, ['-v', 'error', '-decryption_key', key.toString('hex'), '-i', encrypted,
      '-map', '0:a:0', '-c:a', 'copy', '-strict', '-2', '-f', 'mp4', clear]);
    references[codec] = decoded(clear);
  }
  fs.writeFileSync(preload, `
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),cp=require('node:child_process');
const root=${JSON.stringify(temp)},key=Buffer.from(${JSON.stringify(key.toString('hex'))},'hex');
const state=()=>JSON.parse(fs.readFileSync(path.join(root,'scenario.json'),'utf8'));
const record=e=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify(e)+'\\n');
for(const name of ['spawn','spawnSync','execFile','execFileSync','exec','execSync']) {
 const original=cp[name];cp[name]=function(exe,...args){if(exe!==process.execPath){record('blocked-external');throw new Error('EXTERNAL_EXECUTABLE_BLOCKED');}return original.call(this,exe,...args);};
}
const original=Module._load;Module._load=function(name,parent,...rest){
 if(name==='./native-sdk.cjs')return {prepareSdk:async()=>{}};
 if(name.endsWith('device.node'))return {decodeSpade:()=>Buffer.from(key)};
 if(name==='./media-request.cjs')return {getTrackMetadata:async({trackId,mediaType})=>{
  const s=state(),codec=trackId==='101'?'flac':'aac',file=path.join(root,codec+'.mp4');
  return {risk_result:0,track:{duration:8000,media_type:s.wrongMedia?'track':mediaType},track_player:{video_model_type:s.preview?2:mediaType==='ugc_clip'?3:1,
   video_model:JSON.stringify({video_duration:8,video_list:[{main_url:'https://fixture.douyinvod.com/'+trackId,
    video_meta:{quality:codec==='flac'?'lossless':'higher',codec_type:codec,vtype:codec==='flac'?'mp4':'m4a',size:fs.statSync(file).size},encrypt_info:{spade_a:'synthetic-only'}}]})}};}};
 return original.call(this,name,parent,...rest);
};
global.fetch=async(url,options)=>{
 const u=new URL(url);if(u.hostname!=='fixture.douyinvod.com')throw new Error('UNEXPECTED_NETWORK');
 record('download');const s=state();let b=fs.readFileSync(path.join(root,u.pathname==='/101'?'flac.mp4':'aac.mp4'));
 if(s.scheme){const p=b.indexOf(Buffer.from('schm'));b.write('cbcs',p+8);}
 if(s.truncated)b=b.subarray(0,128);
 if(s.slow){return new Response(new ReadableStream({async pull(c){await new Promise(r=>setTimeout(r,100));if(options.signal.aborted){c.error(new Error('cancelled'));return;}c.enqueue(b.subarray(0,128));}}));}
 return new Response(b,{headers:{'content-length':String(b.length)}});
};
`);
  const api = await entry(); let cached;
  for (const [id, quality] of [['100', 'standard'], ['101', 'lossless']]) {
    const value = await api.stream({ id, quality }), file = fileURLToPath(value.url);
    assert.equal(value.type, 'm4a'); const native = decoded(file), before = eventCount('download'), expected = hash(file);
    assert.equal(native.decodedPcmSha256, references[id === '100' ? 'aac' : 'flac'].decodedPcmSha256);
    await api.stream({ id, quality }); assert.equal(eventCount('download'), before);
    const b = fs.readFileSync(file); b[b.length - 1] ^= 1; fs.writeFileSync(file, b);
    await api.stream({ id, quality }); assert.equal(hash(file), expected); assert.ok(eventCount('download') > before);
    results.push({ case: id === '100' ? 'aac-cold-hot-tamper' : 'flac-cold-hot-tamper', ok: true, native });
    if (id === '100') cached = file;
  }
  state({ preview: true }); const beforePreview = eventCount('download');
  await assert.rejects(api.stream({ id: '100' }), e => /完整音频/.test(e.message));
  assert.equal(eventCount('download'), beforePreview); results.push({ case: 'cached-preview-denied', ok: true }); state({});
  const clip = await api.stream({ id: 'ugc_clip:100' }); decoded(fileURLToPath(clip.url));
  state({ wrongMedia: true }); await assert.rejects(api.stream({ id: 'ugc_clip:100' })); state({});
  results.push({ case: 'ugc-full-clip-and-mismatch', ok: true });
  state({ scheme: true }); await assert.rejects(api.stream({ id: '102' }), e => e.code === 'unsupported'); state({}); clean();
  results.push({ case: 'unsupported-encryption-not-cached', ok: true });
  state({ truncated: true }); await assert.rejects(api.stream({ id: '103' })); state({}); clean();
  results.push({ case: 'truncated-download-cleaned', ok: true });
  fs.unlinkSync(cached); fs.unlinkSync(cached + '.json'); fs.mkdirSync(cached + '.lock');
  const old = new Date(Date.now() - 60000); fs.utimesSync(cached + '.lock', old, old);
  const other = await entry();
  const pair = await Promise.all([api.stream({ id: '100' }), other.stream({ id: '100' })]);
  assert.equal(pair[0].url, pair[1].url); decoded(cached); clean();
  results.push({ case: 'concurrent-publish-and-stale-lock', ok: true });
  state({ slow: true }); const start = eventCount('download');
  const pending = api.stream({ id: '104' }); const rejected = assert.rejects(pending);
  for (let i = 0; i < 100 && eventCount('download') === start; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(eventCount('download') > start); api.signOut(); await rejected;
  await new Promise(r => setTimeout(r, 400)); clean();
  results.push({ case: 'signout-cancels-download-and-cleans-partials', ok: true });
  assert.equal(eventCount('blocked-external'), 0);
  fs.writeFileSync(path.join(out, 'offline-pipeline.json'), JSON.stringify({ ok: true, realAccountsUsed: false,
    ffmpegForbiddenDuringPlayback: true, cases: results }, null, 2));
  console.log('offline-media-pipeline: PASS (' + results.length + ' cases)');
} catch (error) {
  fs.writeFileSync(path.join(out, 'offline-pipeline.json'), JSON.stringify({ ok: false, completed: results,
    error: String(error.message).slice(0, 180) }, null, 2)); throw error;
} finally {
  key.fill(0); for (const child of children) { child.stdin.end(); child.kill(); }
  fs.rmSync(temp, { recursive: true, force: true });
}
