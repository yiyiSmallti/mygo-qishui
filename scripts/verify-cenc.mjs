// Generates CENC audio, runs the plugin decryptor and compares packet hashes
// with an independent FFmpeg oracle. FFmpeg is a verification-only dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const output = path.resolve(process.argv[2] || 'cenc-verification');
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qishui-cenc-check-'));
const ffmpeg = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const key = crypto.randomBytes(16), kid = crypto.randomBytes(16);
const results = [];
function exec(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  // Errors and arguments can contain authorization: never persist them.
  assert.equal(r.status, 0, `${path.basename(command)} failed`);
  return r.stdout;
}
function hash(file, encrypted = false) {
  return exec(ffmpeg, ['-v', 'error', ...(encrypted ? ['-decryption_key', key.toString('hex')] : []),
    '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();
}
function headerOffset(b, type) {
  const p = b.indexOf(Buffer.from(type));
  assert.ok(p >= 4 && b.readUInt32BE(p - 4) >= 8, `missing ${type}`);
  return p - 4;
}
function encryptedVariant(original, ivSize, subsamples) {
  const b = fs.readFileSync(original);
  const senc = headerOffset(b, 'senc'), oldSize = b.readUInt32BE(senc), count = b.readUInt32BE(senc + 12);
  assert.equal(b.readUInt32BE(senc + 8), 0, 'generator must use whole samples');
  assert.equal(oldSize, 16 + count * 8);
  const packets = JSON.parse(exec(ffprobe, ['-v', 'error', '-decryption_key', key.toString('hex'),
    '-show_packets', '-select_streams', 'a:0', '-show_entries', 'packet=pos,size', '-of', 'json', original])).packets;
  assert.equal(packets.length, count);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const iv = Buffer.alloc(16); b.copy(iv, 0, senc + 16 + i * 8, senc + 24 + i * 8);
    entries.push(iv.subarray(0, ivSize));
    if (subsamples) {
      const start = Number(packets[i].pos), length = Number(packets[i].size);
      const clear1 = Math.min(3, length), protected1 = Math.min(11, length - clear1);
      const clear2 = Math.min(5, length - clear1 - protected1), end1 = clear1 + protected1;
      const dec = crypto.createDecipheriv('aes-128-ctr', key, iv);
      const plain = Buffer.concat([dec.update(b.subarray(start, start + length)), dec.final()]);
      const enc = crypto.createCipheriv('aes-128-ctr', key, iv);
      // Two protected spans share a counter; clear bytes do not consume it.
      plain.copy(b, start);
      enc.update(plain.subarray(clear1, end1)).copy(b, start + clear1);
      enc.update(plain.subarray(end1 + clear2)).copy(b, start + end1 + clear2);
      enc.final();
      const sizes = Buffer.alloc(14); sizes.writeUInt16BE(2);
      sizes.writeUInt16BE(clear1, 2); sizes.writeUInt32BE(protected1, 4);
      sizes.writeUInt16BE(clear2, 8); sizes.writeUInt32BE(length - end1 - clear2, 10);
      entries.push(sizes);
    }
  }
  const replacement = Buffer.concat([Buffer.alloc(16), ...entries]);
  replacement.writeUInt32BE(replacement.length); replacement.write('senc', 4);
  replacement.writeUInt32BE(subsamples ? 2 : 0, 8); replacement.writeUInt32BE(count, 12);
  const delta = replacement.length - oldSize;
  for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl']) {
    const p = headerOffset(b, type); b.writeUInt32BE(b.readUInt32BE(p) + delta, p);
  }
  const tenc = headerOffset(b, 'tenc'); b[tenc + 15] = ivSize;
  const saiz = headerOffset(b, 'saiz');
  // This fixture has a default per-sample auxiliary size, never a size array.
  assert.equal(b.readUInt32BE(saiz + 8), 0);
  assert.notEqual(b[saiz + 12], 0);
  b[saiz + 12] = ivSize + (subsamples ? 14 : 0);
  return Buffer.concat([b.subarray(0, senc), replacement, b.subarray(senc + oldSize)]);
}

try {
  const { decryptFile, inspectFile } = require('../qishui-account/mp4-cenc.cjs');
  for (const codec of ['aac', 'flac']) {
    const encrypted = path.join(scratch, `${codec}.mp4`);
    exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=44100:duration=3',
      '-ac', '2', '-c:a', codec, ...(codec === 'aac' ? ['-b:a', '128k'] : ['-strict', '-2']),
      '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', key.toString('hex'),
      '-encryption_kid', kid.toString('hex'), '-f', 'mp4', encrypted]);
    const expected = hash(encrypted, true);
    for (const variant of ['iv8', 'iv16', 'subsamples']) {
      const file = path.join(scratch, `${codec}-${variant}.m4a`);
      fs.writeFileSync(file, variant === 'iv8' ? fs.readFileSync(encrypted)
        : encryptedVariant(encrypted, variant === 'iv16' ? 16 : 8, variant === 'subsamples'));
      assert.equal(hash(file, true), expected, 'oracle must accept the generated variant');
      const before = fs.statSync(file).size;
      const result = await decryptFile(file, { key, expectedMs: 3000, expectedCodec: codec });
      assert.equal(result.codec, codec); assert.equal(result.encrypted, false);
      assert.equal(fs.statSync(file).size, before, 'sample offsets must stay unchanged');
      assert.equal(hash(file), expected, 'compressed audio packets must remain identical');
      exec(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
      await inspectFile(file, { expectedMs: 3000, expectedCodec: codec });
      const clearHash = hash(file);
      await decryptFile(file, { key: Buffer.alloc(0), expectedMs: 3000, expectedCodec: codec });
      assert.equal(hash(file), clearHash, 'clear MP4 needs no transformation');
      results.push({ codec, variant, packetHashMatched: true, fullDecode: true, offsetsPreserved: true });
    }
    for (const [name, mutate] of [
      ['unsupported-scheme', b => b.write('cbcs', headerOffset(b, 'schm') + 12)],
      ['invalid-iv-size', b => { b[headerOffset(b, 'tenc') + 15] = 7; }],
      ['mismatched-senc-count', b => b.writeUInt32BE(0, headerOffset(b, 'senc') + 12)],
      ['invalid-sample-count', b => b.writeUInt32BE(0x7fffffff, headerOffset(b, 'stsz') + 16)],
      ['outside-mdat', b => b.writeUInt32BE(0, headerOffset(b, 'stco') + 16)],
      ['unsupported-sample-description', b => b.writeUInt32BE(2, headerOffset(b, 'stsc') + 24)],
    ]) {
      const b = fs.readFileSync(encrypted); mutate(b);
      const file = path.join(scratch, `${codec}-${name}.m4a`); fs.writeFileSync(file, b);
      await assert.rejects(decryptFile(file, { key, expectedMs: 3000, expectedCodec: codec }));
      assert.deepEqual(fs.readFileSync(file), b, 'invalid metadata must fail before mutation');
      results.push({ codec, case: name, rejectedBeforeMutation: true });
    }
    await assert.rejects(decryptFile(encrypted, { key: Buffer.alloc(3), expectedMs: 3000, expectedCodec: codec }));
    await assert.rejects(decryptFile(encrypted, { key, expectedMs: 30000, expectedCodec: codec }));
    await assert.rejects(decryptFile(encrypted, { key, expectedMs: 3000, expectedCodec: codec === 'aac' ? 'flac' : 'aac' }));
    await assert.rejects(decryptFile(encrypted, { key, expectedMs: 3000, expectedCodec: codec,
      signal: AbortSignal.abort() }));
    results.push({ codec, invalidKeyDurationCodecAndCancellationRejected: true });
    if (codec === 'aac') {
      const cancelled = path.join(scratch, 'cancelled.m4a'); fs.copyFileSync(encrypted, cancelled);
      const control = new AbortController();
      const work = decryptFile(cancelled, { key, expectedMs: 3000, expectedCodec: codec, signal: control.signal });
      setImmediate(() => control.abort());
      await assert.rejects(work);
      results.push({ codec, cancelledDuringDecryption: true });
    }
  }
  fs.writeFileSync(path.join(output, 'generated-media.json'), JSON.stringify({ ok: true, results }, null, 2));
  console.log(`verify-cenc: PASS (${results.length} cases); ${path.join(output, 'generated-media.json')}`);
} finally {
  key.fill(0); kid.fill(0);
  fs.rmSync(scratch, { recursive: true, force: true });
}
