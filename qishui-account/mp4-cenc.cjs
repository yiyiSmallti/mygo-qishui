'use strict';
// CENC audio only: keep the original codec, sample offsets and seek tables.
// Authorization keys are supplied by the caller and never stored in the file.
// Assisted-by: Cindy (https://cindy.app)
const fs = require('node:fs');
const { createDecipheriv } = require('node:crypto');
const { setImmediate: yieldIO } = require('node:timers/promises');

const MAX_FILE = 120 * 1024 * 1024;
const MAX_MOOV = 16 * 1024 * 1024;
const MAX_SAMPLES = 1000000;
function fail(message, code = 'unavailable') {
  const error = new Error(message);
  error.code = code; error.safeMediaError = true;
  throw error;
}
function check(ok, message = '汽水音频文件不完整或结构无效。') { if (!ok) fail(message); }
function unsupported() { fail('汽水返回的音频加密或封装方式暂不受支持。', 'unsupported'); }
function cancelled(signal) { if (signal?.aborted) fail('音频处理已取消。'); }
function safeNumber(n) {
  const value = Number(n);
  check(Number.isSafeInteger(value) && value >= 0);
  return value;
}
function readAt(fd, size, position) {
  check(Number.isSafeInteger(size) && size >= 0 && Number.isSafeInteger(position) && position >= 0);
  const b = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = fs.readSync(fd, b, read, size - read, position + read);
    check(n > 0); read += n;
  }
  return b;
}
function writeAt(fd, b, position) {
  let written = 0;
  while (written < b.length) {
    const n = fs.writeSync(fd, b, written, b.length - written, position + written);
    check(n > 0, '音频缓存写入失败，请检查磁盘空间。'); written += n;
  }
}
function boxes(b, start = 0, end = b.length) {
  const found = [];
  for (let p = start; p < end;) {
    check(end - p >= 8 && found.length < 10000);
    let size = b.readUInt32BE(p), header = 8;
    if (size === 1) {
      check(end - p >= 16);
      size = safeNumber(b.readBigUInt64BE(p + 8)); header = 16;
    } else if (size === 0) size = end - p;
    check(size >= header && size <= end - p);
    found.push({ type: b.toString('ascii', p + 4, p + 8), start: p, data: p + header, end: p + size });
    p += size;
  }
  return found;
}
function one(list, type) {
  const matches = list.filter(x => x.type === type);
  check(matches.length === 1);
  return matches[0];
}
function children(b, box) { return boxes(b, box.data, box.end); }
function body(b, box, minimum) {
  check(box.end - box.data >= minimum);
  return b.subarray(box.data, box.end);
}
function full(b, box, minimum = 4, versions = [0]) {
  const data = body(b, box, minimum);
  if (!versions.includes(data[0])) unsupported();
  return data;
}
function countTable(b, box, stride, start = 8) {
  const data = full(b, box, start);
  const count = data.readUInt32BE(4);
  check(count > 0 && count <= MAX_SAMPLES && data.length === start + count * stride);
  return { data, count };
}
function mediaHeader(b, mdhd) {
  const data = full(b, mdhd, 24, [0, 1]);
  const v1 = data[0] === 1;
  check(data.length >= (v1 ? 36 : 24));
  const timescale = data.readUInt32BE(v1 ? 20 : 12);
  const duration = v1 ? safeNumber(data.readBigUInt64BE(24)) : data.readUInt32BE(16);
  check(timescale > 0 && duration > 0);
  return { timescale, duration };
}
function sampleTable(b, list, mdats) {
  const sizesBox = one(list, 'stsz'), sizes = full(b, sizesBox, 12);
  const fixed = sizes.readUInt32BE(4), count = sizes.readUInt32BE(8);
  check(count > 0 && count <= MAX_SAMPLES && sizes.length === 12 + (fixed ? 0 : count * 4));
  const mapping = countTable(b, one(list, 'stsc'), 12);
  const offsets = list.filter(x => x.type === 'stco' || x.type === 'co64');
  check(offsets.length === 1);
  const wide = offsets[0].type === 'co64';
  const chunks = countTable(b, offsets[0], wide ? 8 : 4);
  check(chunks.count <= count);
  const runs = [];
  for (let i = 0; i < mapping.count; i++) {
    const p = 8 + i * 12, first = mapping.data.readUInt32BE(p);
    const perChunk = mapping.data.readUInt32BE(p + 4), description = mapping.data.readUInt32BE(p + 8);
    check(first > 0 && first <= chunks.count && perChunk > 0 && perChunk <= count);
    if (description !== 1) unsupported();
    check(i === 0 ? first === 1 : first > runs[i - 1].first);
    runs.push({ first, perChunk });
  }
  const samples = [];
  let run = 0;
  for (let chunk = 1; chunk <= chunks.count; chunk++) {
    if (run + 1 < runs.length && chunk >= runs[run + 1].first) run++;
    const p = 8 + (chunk - 1) * (wide ? 8 : 4);
    let position = wide ? safeNumber(chunks.data.readBigUInt64BE(p)) : chunks.data.readUInt32BE(p);
    for (let j = 0; j < runs[run].perChunk; j++) {
      check(samples.length < count);
      const size = fixed || sizes.readUInt32BE(12 + samples.length * 4);
      check(size > 0 && size <= MAX_MOOV);
      check(mdats.some(m => position >= m.start && position + size <= m.end));
      samples.push({ position, size }); position += size;
    }
  }
  check(samples.length === count);
  const sorted = [...samples].sort((a, c) => a.position - c.position);
  for (let i = 1; i < sorted.length; i++) check(sorted[i].position >= sorted[i - 1].position + sorted[i - 1].size);
  return samples;
}
function sampleTime(b, list, count, header, expectedMs, codec) {
  const table = countTable(b, one(list, 'stts'), 8);
  let samples = 0, ticks = 0, maxDelta = 0;
  for (let i = 0; i < table.count; i++) {
    const p = 8 + i * 8, n = table.data.readUInt32BE(p), delta = table.data.readUInt32BE(p + 4);
    check(n > 0 && delta > 0);
    samples += n; ticks += n * delta;
    maxDelta = Math.max(maxDelta, delta);
    check(samples <= count && Number.isSafeInteger(ticks));
  }
  // AAC sample tables can include encoder priming/padding omitted by mdhd.
  // Accept at most two frames (capped at 100 ms), only in that direction.
  const padding = codec === 'aac' ? Math.min(2 * maxDelta, header.timescale / 10) : 1;
  check(samples === count && ticks >= header.duration - 1 && ticks - header.duration <= padding);
  check(Math.abs(header.duration * 1000 / header.timescale - expectedMs) <= 2000,
    '汽水音频未达到当前授权的完整时长。');
  const durationMs = ticks * 1000 / header.timescale;
  check(Math.abs(durationMs - expectedMs) <= 2000, '汽水音频未达到当前授权的完整时长。');
  return durationMs;
}
function audioConfig(data, depth = 0) {
  check(depth <= 4);
  for (let p = 0; p < data.length;) {
    const tag = data[p++]; let size = 0, complete = false;
    for (let i = 0; i < 4; i++) {
      check(p < data.length);
      const value = data[p++]; size = size * 128 + (value & 127);
      if (!(value & 128)) { complete = true; break; }
    }
    check(complete && size <= data.length - p);
    const entry = data.subarray(p, p + size); p += size;
    if (tag === 5) return entry;
    if (tag === 3) {
      check(entry.length >= 3);
      const flags = entry[2]; let start = 3;
      if (flags & 128) start += 2;
      if (flags & 64) { check(start < entry.length); start += 1 + entry[start]; }
      if (flags & 32) start += 2;
      check(start <= entry.length);
      const config = audioConfig(entry.subarray(start), depth + 1);
      if (config) return config;
    } else if (tag === 4) {
      check(entry.length >= 13);
      const config = audioConfig(entry.subarray(13), depth + 1);
      if (config) return config;
    }
  }
  return null;
}
function description(b, stsd, expectedCodec) {
  const data = full(b, stsd, 8);
  if (data.readUInt32BE(4) !== 1) unsupported();
  const entries = boxes(b, stsd.data + 8, stsd.end);
  check(entries.length === 1);
  const entry = entries[0], audio = body(b, entry, 28);
  const version = audio.readUInt16BE(8);
  if (version > 2) unsupported();
  const list = boxes(b, entry.data + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), entry.end);
  let format = entry.type, protection;
  if (format === 'enca') {
    const sinf = one(list, 'sinf'), fields = children(b, sinf);
    format = body(b, one(fields, 'frma'), 4).toString('ascii', 0, 4);
    const schm = full(b, one(fields, 'schm'), 12);
    if (schm.toString('ascii', 4, 8) !== 'cenc') unsupported();
    const tenc = full(b, one(children(b, one(fields, 'schi')), 'tenc'), 24, [0, 1]);
    if ((tenc[0] === 1 && tenc[5] !== 0) || tenc[6] !== 1 || ![8, 16].includes(tenc[7])) unsupported();
    protection = { ivSize: tenc[7], sinf };
  } else if (list.some(x => x.type === 'sinf')) unsupported();
  const codec = format === 'mp4a' ? 'aac' : format === 'fLaC' ? 'flac' : '';
  if (!codec || codec !== expectedCodec) unsupported();
  // Keep codec configuration intact; MyGo reads it after restoring the entry.
  const config = one(list, codec === 'aac' ? 'esds' : 'dfLa');
  const configData = full(b, config, codec === 'aac' ? 6 : 42);
  if (codec === 'aac') {
    const asc = audioConfig(configData.subarray(4));
    check(asc && asc.length >= 2);
    // Original MyGo's AAC decoder supports AAC-LC; do not publish HE-AAC
    // or other profiles as if its decoder could play them.
    if (asc[0] >> 3 !== 2) fail('当前 MyGo 暂不支持这首歌返回的 AAC 编码规格。', 'unsupported');
  }
  return { codec, format, entry, protection };
}
function encryption(b, list, samples, ivSize) {
  for (const group of list.filter(x => x.type === 'sgpd' || x.type === 'sbgp')) {
    if (full(b, group, 8, [0, 1, 2]).toString('ascii', 4, 8) === 'seig') unsupported();
  }
  const box = one(list, 'senc'), data = full(b, box, 8);
  const flags = data.readUIntBE(1, 3);
  if ((flags & ~2) !== 0) unsupported();
  check(data.readUInt32BE(4) === samples.length);
  let p = 8;
  for (const sample of samples) {
    check(data.length - p >= ivSize);
    sample.iv = data.subarray(p, p + ivSize); p += ivSize;
    if (flags & 2) {
      check(data.length - p >= 2);
      const count = data.readUInt16BE(p); p += 2;
      check(count <= 10000 && data.length - p >= count * 6);
      const spans = []; let consumed = 0;
      for (let i = 0; i < count; i++) {
        const clear = data.readUInt16BE(p), encrypted = data.readUInt32BE(p + 2); p += 6;
        consumed += clear; const start = consumed; consumed += encrypted;
        check(consumed <= sample.size);
        spans.push({ start, size: encrypted });
      }
      check(count === 0 || consumed === sample.size);
      sample.spans = count === 0 ? [{ start: 0, size: sample.size }] : spans;
    } else sample.spans = [{ start: 0, size: sample.size }];
  }
  check(p === data.length);
  return [box, ...list.filter(x => x.type === 'saiz' || x.type === 'saio')];
}
function parse(fd, size, { expectedMs, expectedCodec, allowEncrypted = false }) {
  check(size >= 128 && size <= MAX_FILE);
  check(Number.isFinite(expectedMs) && expectedMs > 0);
  if (!['aac', 'flac'].includes(expectedCodec)) unsupported();
  let moov, position;
  const mdats = [], removeTop = [];
  for (let p = 0, count = 0; p < size; count++) {
    check(size - p >= 8 && count < 10000);
    const head = readAt(fd, Math.min(16, size - p), p);
    let length = head.readUInt32BE(0), header = 8;
    const type = head.toString('ascii', 4, 8);
    if (length === 1) { check(head.length === 16); length = safeNumber(head.readBigUInt64BE(8)); header = 16; }
    else if (length === 0) length = size - p;
    check(length >= header && length <= size - p);
    if (type === 'moof') unsupported();
    if (type === 'moov') {
      check(!moov && length <= MAX_MOOV);
      moov = readAt(fd, length, p); position = p;
    } else if (type === 'mdat') mdats.push({ start: p + header, end: p + length });
    else if (type === 'pssh') { check(length <= MAX_MOOV); removeTop.push({ start: p, size: length }); }
    p += length;
  }
  check(moov && mdats.length > 0);
  const root = children(moov, one(boxes(moov), 'moov'));
  if (root.some(x => x.type === 'mvex')) unsupported();
  const tracks = root.filter(x => x.type === 'trak');
  if (tracks.length !== 1) unsupported();
  const mdia = children(moov, one(children(moov, tracks[0]), 'mdia'));
  check(body(moov, one(mdia, 'hdlr'), 12).toString('ascii', 8, 12) === 'soun');
  const header = mediaHeader(moov, one(mdia, 'mdhd'));
  const stbl = one(children(moov, one(mdia, 'minf')), 'stbl'), list = children(moov, stbl);
  const desc = description(moov, one(list, 'stsd'), expectedCodec);
  const samples = sampleTable(moov, list, mdats);
  const durationMs = sampleTime(moov, list, samples.length, header, expectedMs, desc.codec);
  let remove = [];
  if (desc.protection) {
    if (!allowEncrypted) fail('音频缓存仍处于加密状态，无法直接播放。');
    remove = [desc.protection.sinf, ...encryption(moov, list, samples, desc.protection.ivSize),
      ...root.filter(x => x.type === 'pssh')];
  } else if (list.some(x => ['senc', 'saiz', 'saio'].includes(x.type))) unsupported();
  return { moov, position, samples, desc, remove, removeTop,
    info: { codec: desc.codec, durationMs, samples: samples.length, size, encrypted: Boolean(desc.protection) } };
}
function open(file, flags) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink());
  const fd = fs.openSync(file, flags);
  const now = fs.fstatSync(fd);
  if (!now.isFile() || now.size !== stat.size) { fs.closeSync(fd); fail('音频缓存文件已变化，请重试。'); }
  return { fd, size: now.size };
}
async function inspectFile(file, options) {
  cancelled(options.signal);
  const { fd, size } = open(file, 'r');
  try { return parse(fd, size, options).info; }
  finally { fs.closeSync(fd); }
}
async function decryptFile(file, options) {
  cancelled(options.signal);
  const { fd, size } = open(file, 'r+');
  try {
    const media = parse(fd, size, { ...options, allowEncrypted: true });
    if (!media.info.encrypted) return media.info;
    check(Buffer.isBuffer(options.key) && options.key.length === 16, '这首歌缺少有效的播放解密授权。');
    // Validate every table and subsample before changing a byte. The caller
    // owns this private .part file and publishes it only after success.
    for (let i = 0; i < media.samples.length; i++) {
      if (i % 64 === 0) { await yieldIO(); cancelled(options.signal); }
      const sample = media.samples[i], iv = Buffer.alloc(16);
      sample.iv.copy(iv);
      const decipher = createDecipheriv('aes-128-ctr', options.key, iv);
      const packet = readAt(fd, sample.size, sample.position);
      for (const span of sample.spans) {
        if (span.size) decipher.update(packet.subarray(span.start, span.start + span.size)).copy(packet, span.start);
      }
      check(decipher.final().length === 0);
      writeAt(fd, packet, sample.position);
    }
    cancelled(options.signal);
    media.moov.write(media.desc.format, media.desc.entry.start + 4, 4, 'ascii');
    // Padding boxes retain byte lengths, so all original chunk/seek offsets
    // stay valid. Clear the discarded authorization metadata in those boxes.
    for (const box of media.remove) {
      media.moov.write('free', box.start + 4, 4, 'ascii');
      media.moov.fill(0, box.data, box.end);
    }
    writeAt(fd, media.moov, media.position);
    for (const box of media.removeTop) {
      const padding = Buffer.alloc(box.size); padding.writeUInt32BE(box.size); padding.write('free', 4);
      writeAt(fd, padding, box.start);
    }
    return parse(fd, size, options).info;
  } finally { fs.closeSync(fd); }
}

module.exports = { decryptFile, inspectFile };
