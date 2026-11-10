'use strict';
// Uses only the current account's server-authorized playback response.
// Vendor decodeSpade is invoked exactly as in its installed player; keys and
// signed URLs stay in this temporary worker and are never logged or persisted.
// Assisted-by: Cindy (https://cindy.app)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { setTimeout: wait } = require('node:timers/promises');
const { getTrackMetadata, getSearchMetadata } = require('./media-request.cjs');
const { sodaAddon } = require('./local-env.cjs');
const { decryptFile, inspectFile } = require('./mp4-cenc.cjs');
// Set from the request: MyGo's own data folder for this plugin, per OS.
let CACHE = '';
const controller = new AbortController();
const temporary = [];
let stage = 'metadata';
const timer = setTimeout(() => controller.abort(), 26000);
function fail(message, code = 'unavailable') { const e = new Error(message); e.code = code; e.safeMediaError = true; throw e; }
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
  if (!spade) return Buffer.alloc(0);
  if (typeof spade !== 'string' || spade.length > 16384) fail('汽水返回的播放授权格式无效。');
  let key;
  try { key = require(sodaAddon('device.node')).decodeSpade(spade); }
  catch { fail('本机汽水播放组件无法处理这首歌的播放授权。'); }
  if (typeof key === 'string' && /^[a-fA-F0-9]{32}$/.test(key)) return Buffer.from(key, 'hex');
  if (Buffer.isBuffer(key) && key.length === 16) return Buffer.from(key);
  fail('本机播放组件返回的授权格式暂不受支持。');
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
async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal: controller.signal })) hash.update(chunk);
  return hash.digest('hex');
}
async function validCachedMp4(file, expectedMs, expectedCodec) {
  try {
    const stat = await fs.promises.lstat(file), receiptStat = await fs.promises.lstat(file + '.json');
    if (!stat.isFile() || stat.isSymbolicLink() || !receiptStat.isFile() || receiptStat.isSymbolicLink()
        || receiptStat.size > 4096) return false;
    const receipt = JSON.parse(await fs.promises.readFile(file + '.json', 'utf8'));
    if (receipt.schema !== 1 || receipt.codec !== expectedCodec || receipt.size !== stat.size
        || !Number.isFinite(receipt.durationMs)
        || Math.abs(receipt.durationMs - expectedMs) > 2000 || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return false;
    await inspectFile(file, { expectedMs, expectedCodec, signal: controller.signal });
    return receipt.sha256 === await fileHash(file);
  } catch (error) {
    if (controller.signal.aborted) fail('音频处理已取消。');
    return false;
  }
}
async function discardCache(file) {
  for (const candidate of [file, file + '.json']) {
    try { await fs.promises.unlink(candidate); }
    catch (error) { if (error.code !== 'ENOENT') fail('无法清理损坏的音频缓存，请关闭当前播放后重试。'); }
  }
}
async function publishCache(output, receiptFile, destination, expectedMs, codec) {
  const lock = destination + '.lock', deadline = Date.now() + 5000;
  const lease = path.join(lock, process.pid + '-' + crypto.randomBytes(8).toString('hex'));
  while (true) {
    if (controller.signal.aborted) fail('音频处理已取消。');
    try {
      await fs.promises.mkdir(lock, { mode: 0o700 });
      fs.writeFileSync(lease, '', { flag: 'wx', mode: 0o600 });
      break;
    }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code !== 'EEXIST') throw error;
      // A crash can leave this empty publication lock behind. It is held
      // only for renaming finished files, never during network requests.
      let stat;
      try { stat = await fs.promises.lstat(lock); }
      catch (changed) { if (changed.code === 'ENOENT') continue; throw changed; }
      if (stat.isDirectory() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 30000) {
        const owners = await fs.promises.readdir(lock).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        let abandoned = owners.length === 0;
        if (owners.length === 1 && /^[1-9][0-9]*-[a-f0-9]{16}$/.test(owners[0])) {
          try { process.kill(Number(owners[0].split('-')[0]), 0); }
          catch (error) { if (error.code === 'ESRCH') abandoned = true; }
          if (abandoned) {
            try { await fs.promises.unlink(path.join(lock, owners[0])); }
            catch (changed) { if (changed.code !== 'ENOENT') throw changed; }
          }
        }
        if (abandoned) {
          // A new owner has a different lease name. rmdir cannot remove an
          // active nonempty lock even if an old stat raced with publication.
          try { await fs.promises.rmdir(lock); }
          catch (changed) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(changed.code)) throw changed; }
          continue;
        }
      }
      if (Date.now() >= deadline) fail('另一个播放请求正在写入音频缓存，请稍后重试。');
      await wait(50, undefined, { signal: controller.signal });
    }
  }
  try {
    if (await validCachedMp4(destination, expectedMs, codec)) return;
    await discardCache(destination);
    await fs.promises.rename(output, destination);
    await fs.promises.rename(receiptFile, destination + '.json');
  } finally {
    await fs.promises.unlink(lease);
    await fs.promises.rmdir(lock);
  }
}
function trimCache(destination) {
  const entries = fs.readdirSync(CACHE).filter(n => /^[a-f0-9]{64}\.(?:flac|m4a)$/.test(n)).flatMap(n => {
    const file = cacheFile(n), info = fs.lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() ? [{ file, size: info.size, time: info.mtimeMs }] : [];
  }).sort((a, b) => a.time - b.time);
  let bytes = entries.reduce((sum, e) => sum + e.size, 0);
  for (const entry of entries) {
    if (bytes <= 512 * 1024 * 1024) break;
    if (entry.file === destination) continue;
    try {
      fs.unlinkSync(entry.file); bytes -= entry.size;
      if (entry.file.endsWith('.m4a')) {
        try { fs.unlinkSync(entry.file + '.json'); } catch (error) { if (error.code !== 'ENOENT') continue; }
      }
    } catch { /* A player can still have an older cache open on Windows. */ }
  }
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
  const codec = selected.video_meta.codec_type;
  if (!['aac', 'flac'].includes(codec) || !['m4a', 'mp4'].includes(selected.video_meta.vtype))
    fail('汽水返回的音频编码或封装暂不受支持。', 'unsupported');
  const mediaPrefix = mediaType === 'track' ? '' : mediaType + ':';
  const identity = mediaPrefix + message.accountId + ':' + message.trackId + ':' + sourceQuality + ':' + duration;
  const legacyDigest = crypto.createHash('sha256').update(identity).digest('hex');
  const digest = crypto.createHash('sha256').update('cenc-v1:' + identity + ':' + codec).digest('hex');
  fs.mkdirSync(CACHE, { recursive: true });
  const legacy = cacheFile(legacyDigest + '.flac');
  let destination = cacheFile(digest + '.m4a'), type = 'm4a';
  // Old conversions remain usable, but only after the fresh authorization
  // and duration checks above. They never authorize preview-only responses.
  if (await validCachedFlac(legacy, modelMs)) { destination = legacy; type = 'flac'; }
  else if (!(await validCachedMp4(destination, modelMs, codec))) {
    const nonce = crypto.randomBytes(6).toString('hex');
    const output = cacheFile(digest + '-' + nonce + '.part');
    const receiptFile = cacheFile(digest + '-' + nonce + '.receipt-part');
    temporary.push(output, receiptFile);
    let key;
    try {
      key = authorizedKey(selected);
      stage = 'download';
      await download(allowedAudio(selected.main_url), output);
      stage = 'decrypt';
      const info = await decryptFile(output, { key, expectedMs: modelMs, expectedCodec: codec, signal: controller.signal });
      stage = 'cache';
      const receipt = { schema: 1, codec, size: info.size, durationMs: info.durationMs, sha256: await fileHash(output) };
      await fs.promises.writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      await publishCache(output, receiptFile, destination, modelMs, codec);
      if (!(await validCachedMp4(destination, modelMs, codec))) fail('音频缓存校验失败，请重试。');
    } finally { if (key) key.fill(0); }
  }
  const stat = fs.statSync(destination);
  if (stat.size < 128) fail('音频缓存不完整，请刷新后重试。');
  trimCache(destination);
  return { url: pathToFileURL(destination).href, type, quality, size: stat.size,
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
  controller.abort();
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
    const stageNames = { metadata: '读取播放信息', download: '读取音频', decrypt: '解密音频', cache: '写入音频缓存' };
    const networkCode = error?.cause?.code || error?.code;
    const hint = typeof networkCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(networkCode) ? '（' + networkCode + '）' : '';
    result = { ok: false, code: error.safeMediaError ? error.code : 'unavailable',
      message: error.safeMediaError ? error.message : (stageNames[stage] || '播放音乐') + '失败' + hint + '，请稍后重试。' };
  } finally {
    clearTimeout(timer);
    for (const file of temporary) { try { fs.unlinkSync(file); } catch {} }
  }
  fs.writeSync(1, 'MYGO_MEDIA_RESULT:' + JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
});
