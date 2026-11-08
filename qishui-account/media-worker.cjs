'use strict';
// Uses only the current account's server-authorized playback response.
// Vendor decodeSpade is invoked exactly as in its installed player; keys and
// signed URLs stay in this temporary worker and are never logged or persisted.
// Assisted-by: Cindy (https://cindy.app)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { getTrackMetadata, getSearchMetadata } = require('./media-request.cjs');
const { ffmpegPath, sodaAddon } = require('./local-env.cjs');
const FFMPEG = ffmpegPath();
// Set from the request: MyGo's own data folder for this plugin, per OS.
let CACHE = '';
const controller = new AbortController();
let encoder, temporary = [], stage = 'metadata';
const timer = setTimeout(() => { controller.abort(); if (encoder) encoder.kill(); }, 26000);
function fail(message, code = 'unavailable') { const e = new Error(message); e.code = code; e.safeMediaError = true; throw e; }
async function stopEncoder() {
  const child = encoder;
  if (!child) return;
  await new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true; clearTimeout(deadline); child.removeListener('close', done); resolve();
    };
    const deadline = setTimeout(done, 750);
    child.once('close', done);
    try { child.kill(); } catch { done(); }
  });
  if (encoder === child) encoder = null;
}
function allowedAudio(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password &&
        (url.hostname.endsWith('.douyinvod.com') || url.hostname.endsWith('.qishui.com'))) return url.href;
  } catch {}
  return '';
}
// Only <...>/plugin-data/qishui-account/media-cache, as host.dataDir gives it.
function useCacheDir(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/.test(value)) fail('音频缓存位置无效。');
  const dir = path.resolve(value), owner = path.dirname(dir);
  if (path.basename(dir) !== 'media-cache' || path.basename(owner) !== 'qishui-account'
      || path.basename(path.dirname(owner)) !== 'plugin-data') fail('音频缓存位置无效。');
  CACHE = dir;
}
function cacheFile(name) {
  if (!CACHE) fail('音频缓存位置无效。');
  const full = path.resolve(CACHE, name);
  if (path.dirname(full) !== path.resolve(CACHE)) fail('音频缓存位置无效。');
  return full;
}
async function download(url, target) {
  const response = await fetch(url, { redirect: 'error', signal: controller.signal });
  if (!response.ok || !response.body) fail('汽水音频暂时无法读取，请稍后重试。');
  const limit = 120 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); fail('这首歌文件较大，请选择较低音质重试。'); }
  const handle = await fs.promises.open(target, 'wx', 0o600);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) { controller.abort(); fail('这首歌文件较大，请选择较低音质重试。'); }
      // FileHandle.write may write fewer bytes than requested (for example when
      // the volume is nearly full); a successful call is not a full-chunk promise.
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) fail('音频缓存写入失败，请检查磁盘空间。');
        offset += bytesWritten;
      }
    }
  } finally { await handle.close(); }
  if (size < 128) fail('汽水返回的音频文件不完整。');
}
function authorizedKey(stream) {
  const spade = stream.encrypt_info?.spade_a;
  if (!spade) return '';
  if (typeof spade !== 'string' || spade.length > 16384) fail('汽水返回的播放授权格式无效。');
  let key;
  try { key = require(sodaAddon('device.node')).decodeSpade(spade); }
  catch { fail('本机汽水播放组件无法处理这首歌的播放授权。'); }
  if (typeof key === 'string' && /^[a-fA-F0-9]{32}$/.test(key)) return key;
  if (Buffer.isBuffer(key) && key.length === 16) return key.toString('hex');
  fail('本机播放组件返回的授权格式暂不受支持。');
}
async function convert(input, output, key, expectedMs) {
  if (!FFMPEG || !fs.existsSync(FFMPEG)) fail(process.platform === 'darwin' ? '未找到 FFmpeg，请先用 Homebrew 安装 ffmpeg。' : '未找到本机音频转换组件，请重新配置插件。', 'setup');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
    ...(key ? ['-decryption_key', key] : []), '-i', input, '-map', '0:a:0',
    '-vn', '-sn', '-dn', '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', '0',
    '-f', 'flac', '-progress', 'pipe:1', '-nostats', '-y', output];
  await new Promise((resolve, reject) => {
    let duration = 0;
    const child = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    encoder = child;
    let spawnFailed = false;
    const progress = readline.createInterface({ input: child.stdout });
    progress.on('line', line => { const m = /^out_time_us=(\d+)$/.exec(line); if (m) duration = Number(m[1]) / 1000; });
    child.once('error', () => { spawnFailed = true; });
    // close follows stdio closure. exit may arrive before the final progress
    // record and incorrectly make a complete conversion look truncated.
    child.once('close', code => {
      progress.close();
      if (encoder === child) encoder = null;
      if (spawnFailed) reject(Object.assign(new Error('无法启动音频转换组件。'), { safeMediaError: true, code: 'setup' }));
      else if (code !== 0 || controller.signal.aborted) reject(Object.assign(new Error('音频转换未完成，请重试或选择较低音质。'), { safeMediaError: true, code: 'unavailable' }));
      else if (duration < expectedMs - 2000) reject(Object.assign(new Error('返回的音频未达到整首时长，未将其作为完整歌曲播放。'), { safeMediaError: true, code: 'unavailable' }));
      else resolve();
    });
  });
  const handle = await fs.promises.open(output, 'r');
  const signature = Buffer.alloc(4);
  try { await handle.read(signature, 0, 4, 0); } finally { await handle.close(); }
  if (signature.toString() !== 'fLaC') fail('音频转换结果无效。');
}
async function validCachedFlac(file, expectedMs) {
  let handle;
  try {
    const info = await fs.promises.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 128) return false;
    handle = await fs.promises.open(file, 'r');
    const header = Buffer.alloc(42);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    // STREAMINFO is the first FLAC metadata block and contains the declared
    // sample count. Check it on reuse as well as after a new conversion.
    if (bytesRead !== 42 || header.toString('ascii', 0, 4) !== 'fLaC'
        || (header[4] & 0x7f) !== 0 || header.readUIntBE(5, 3) !== 34) return false;
    const audio = header.readBigUInt64BE(18);
    const sampleRate = Number(audio >> 44n);
    const samples = Number(audio & 0xfffffffffn);
    if (sampleRate <= 0 || samples <= 0) return false;
    return Math.abs(samples * 1000 / sampleRate - expectedMs) <= 2000;
  } catch { return false; }
  finally { if (handle) await handle.close(); }
}
async function prepareStream(message, data) {
  useCacheDir(message.cacheDir);
  if (Number(data.risk_result || 0) !== 0) fail('汽水暂未允许播放这首歌，请在官方客户端检查。');
  const player = data.track_player;
  const mediaType = message.mediaType || 'track';
  // The official protocol explicitly defines Full=1, Preview=2, Clip=3.
  // A published UGC clip is playable in full as that clip; it is not the
  // subscription preview of a longer track. Keep the request and response
  // media types aligned before accepting model type 3.
  const authorizedClip = mediaType === 'ugc_clip' && data.track?.media_type === 'ugc_clip'
    && Number(player?.video_model_type) === 3;
  if (!player || (Number(player.video_model_type) !== 1 && !authorizedClip)) fail('汽水当前未向此账号提供这首歌的完整音频。');
  if (!['track', 'ugc_clip'].includes(mediaType)) fail('当前播放连接暂不支持此汽水媒体类型。', 'unsupported');
  if (data.track?.media_type && data.track.media_type !== mediaType) fail('汽水返回的媒体类型与本次请求不一致。');
  let model;
  try { model = JSON.parse(player.video_model); } catch { fail('汽水暂未返回可用的完整播放信息。'); }
  const duration = Number(data.track?.duration), modelMs = Number(model.video_duration) * 1000;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(modelMs) || modelMs < duration - 2000) fail('汽水返回的音频时长不足，未将试听作为整首播放。');
  const choices = Array.isArray(model.video_list) ? model.video_list.filter(s => s && allowedAudio(s.main_url)) : [];
  const preferred = message.quality === 'lossless' ? ['lossless', 'highest', 'higher', 'medium']
    : message.quality === 'high' ? ['highest', 'higher', 'medium'] : ['higher', 'medium'];
  let selected;
  for (const quality of preferred) { selected = choices.find(s => s.video_meta?.quality === quality); if (selected) break; }
  if (!selected) fail('汽水未返回当前播放器支持的音频档位。');
  const sourceQuality = selected.video_meta.quality;
  const quality = sourceQuality === 'lossless' ? 'lossless' : sourceQuality === 'highest' ? 'high' : 'standard';
  const mediaPrefix = mediaType === 'track' ? '' : mediaType + ':';
  const digest = crypto.createHash('sha256').update(mediaPrefix + message.accountId + ':' + message.trackId + ':' + sourceQuality + ':' + duration).digest('hex');
  fs.mkdirSync(CACHE, { recursive: true });
  const destination = cacheFile(digest + '.flac');
  if (!(await validCachedFlac(destination, modelMs))) {
    if (fs.existsSync(destination)) {
      try { await fs.promises.unlink(destination); }
      catch { fail('无法清理损坏的音频缓存，请关闭当前播放后重试。'); }
    }
    const nonce = crypto.randomBytes(6).toString('hex');
    const input = cacheFile(digest + '-' + nonce + '.audio');
    const output = cacheFile(digest + '-' + nonce + '.part');
    temporary.push(input, output);
    let key = authorizedKey(selected);
    stage = 'download';
    await download(allowedAudio(selected.main_url), input);
    stage = 'convert';
    await convert(input, output, key, modelMs);
    stage = 'cache';
    key = '';
    if (!(await validCachedFlac(output, modelMs))) fail('转换后的音频时长或格式无效。');
    if (!fs.existsSync(destination)) await fs.promises.rename(output, destination);
  }
  const stat = fs.statSync(destination);
  if (stat.size < 128) fail('音频缓存不完整，请刷新后重试。');
  // Bounded cache: remove old files only in this plugin-owned cache directory.
  const entries = fs.readdirSync(CACHE).filter(n => /^[a-f0-9]{64}\.flac$/.test(n)).map(n => {
    const file = cacheFile(n); const info = fs.statSync(file); return { file, size: info.size, time: info.mtimeMs };
  }).sort((a, b) => a.time - b.time);
  let bytes = entries.reduce((sum, e) => sum + e.size, 0);
  for (const entry of entries) {
    if (bytes <= 512 * 1024 * 1024) break;
    if (entry.file === destination) continue;
    try { fs.unlinkSync(entry.file); bytes -= entry.size; } catch {}
  }
  return { url: pathToFileURL(destination).href, type: 'flac', quality, size: stat.size,
    bitRate: Math.round(stat.size * 8000 / modelMs) };
}
async function run(message) {
  if (!message || typeof message !== 'object' || !['stream', 'lyrics', 'search'].includes(message.operation)) fail('音乐请求无效。');
  const options = { device: message.device, jar: message.jar, signal: controller.signal };
  if (message.operation === 'search') return getSearchMetadata({ ...options, query: message.query, kind: message.kind, cursor: message.cursor, searchId: message.searchId });
  const data = await getTrackMetadata({ ...options, trackId: message.trackId, mediaType: message.mediaType || 'track' });
  if (message.operation === 'lyrics') return { content: typeof data.lyric?.content === 'string' ? data.lyric.content : '' };
  if (typeof message.accountId !== 'string' || !message.accountId) fail('账号信息不完整，请重新登录。', 'signIn');
  return prepareStream(message, data);
}
const input = readline.createInterface({ input: process.stdin });
let processing = false;
input.on('close', () => {
  controller.abort(); if (encoder) encoder.kill();
  if (!processing) { clearTimeout(timer); process.exit(0); }
});
input.once('line', async line => {
  processing = true;
  let result;
  try {
    if (line.length > 262144) fail('音乐请求参数过大。');
    result = { ok: true, value: await run(JSON.parse(line)) };
  }
  catch (error) {
    const stageNames = { metadata: '读取播放信息', download: '读取音频', convert: '转换音频', cache: '写入音频缓存' };
    const networkCode = error?.cause?.code || error?.code;
    const hint = typeof networkCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(networkCode) ? '（' + networkCode + '）' : '';
    result = { ok: false, code: error.safeMediaError ? error.code : 'unavailable',
      message: error.safeMediaError ? error.message : (stageNames[stage] || '播放音乐') + '失败' + hint + '，请稍后重试。' };
  } finally {
    clearTimeout(timer);
    await stopEncoder();
    for (const file of temporary) { try { fs.unlinkSync(file); } catch {} }
  }
  fs.writeSync(1, 'MYGO_MEDIA_RESULT:' + JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
});
