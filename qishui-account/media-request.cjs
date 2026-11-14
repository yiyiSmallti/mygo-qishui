// First-party media metadata requests for the user's own MyGo Qishui session.
// Protocol source: Soda Music 3.7.0 public installation resources.
// Assisted-by: Cindy (https://cindy.app)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { sodaComponents, osVersion } = require('./local-env.cjs');

const API_ORIGIN = 'https://api.qishui.com';
const TRACK_PATH = '/luna/pc/track_v2';
let signerState;

const NETWORK_DIAGNOSTIC_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ABORT_ERR']);
function fail(message, code, statusCode, networkCode) {
  const error = new Error(message);
  error.code = code;
  error.safeMediaError = true;
  if (Number.isFinite(statusCode)) error.statusCode = statusCode;
  if (NETWORK_DIAGNOSTIC_CODES.has(networkCode)) error.networkCode = networkCode;
  throw error;
}

function readInstalledVersion(asarPath) {
  let fd;
  try {
    fd = fs.openSync(asarPath, 'r');
    const prefix = Buffer.alloc(8);
    if (fs.readSync(fd, prefix, 0, 8, 0) !== 8) throw new Error();
    const headerSize = prefix.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 8 * 1024 * 1024) throw new Error();
    const bytes = Buffer.alloc(headerSize);
    if (fs.readSync(fd, bytes, 0, headerSize, 8) !== headerSize) throw new Error();
    const jsonLength = bytes.readUInt32LE(4);
    if (jsonLength > headerSize - 8) throw new Error();
    const header = JSON.parse(bytes.subarray(8, 8 + jsonLength).toString('utf8'));
    const entry = header.files?.['package.json'];
    const offset = Number(entry?.offset);
    if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 65536
        || !Number.isSafeInteger(offset) || offset < 0) throw new Error();
    const content = Buffer.alloc(entry.size);
    if (fs.readSync(fd, content, 0, content.length, 8 + headerSize + offset) !== content.length) throw new Error();
    const metadata = JSON.parse(content.toString('utf8'));
    if (metadata.name !== 'SodaMusic' || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error();
    return metadata.version;
  } catch {
    fail('无法读取汽水签名组件版本，请重新准备组件。', 'setup');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateDevice(device) {
  if (!device || String(device.aid) !== '386088'
      || typeof device.did !== 'string' || !/^\d{1,32}$/.test(device.did)
      || typeof device.iid !== 'string' || !/^\d{1,32}$/.test(device.iid)
      || device.identityType !== 'fresh-plugin-pseudonymous' || device.channel !== 'mygo') {
    fail('本插件的汽水设备信息不完整，请重新登录。', 'signIn');
  }
}

function cookieHeader(jar, route) {
  if (!jar || typeof jar !== 'object' || Array.isArray(jar)) fail('汽水账号尚未登录，请先登录。', 'signIn');
  const cookies = Object.values(jar).filter(cookie => {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return false;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || /[\r\n;]/.test(cookie.value)) return false;
    if (cookie.expires && cookie.expires <= Date.now()) return false;
    const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
    return route === cookiePath || route.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/');
  }).sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  if (!cookies.some(cookie => ['sessionid', 'sessionid_ss'].includes(cookie.name) && cookie.value)) {
    fail('汽水登录已失效，请重新登录。', 'signIn');
  }
  return cookies.map(cookie => cookie.name + '=' + cookie.value).join('; ');
}

function getSigner(device, soda) {
  if (signerState) {
    if (signerState.did !== device.did || signerState.unpacked !== soda.unpacked) {
      fail('汽水播放连接的设备已变化，请重新打开播放连接。', 'deviceChanged');
    }
    return signerState;
  }
  const version = readInstalledVersion(soda.asar);
  try {
    const signer = require(path.join(soda.unpacked, 'bdms.node'));
    if (typeof signer.init !== 'function' || typeof signer.generateHttpSignatureHeaders !== 'function') throw new Error();
    signer.init({ deviceId: device.did });
    signerState = { signer, did: device.did, version, unpacked: soda.unpacked };
    return signerState;
  } catch {
    fail('无法加载汽水签名组件，请检查 Node.js 与组件架构，并重新准备组件。', 'setup');
  }
}

function addSignature(signer, url, headers) {
  let signature;
  try {
    const lines = Object.entries(headers).map(([name, value]) => name + '\r\n' + value).join('\r\n');
    signature = signer.generateHttpSignatureHeaders(url, lines);
  } catch {
    fail('汽水音乐请求签名失败，请重新打开播放连接。', 'setup');
  }
  if (typeof signature !== 'string' || !signature.trim()) fail('汽水音乐签名组件未返回有效结果。', 'setup');
  const pairs = signature.split('\r\n').filter(item => item.trim());
  if (pairs.length % 2) fail('汽水音乐签名结果格式无效。', 'setup');
  for (let i = 0; i < pairs.length; i += 2) {
    const name = pairs[i], value = pairs[i + 1];
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)
        || /^(cookie|authorization|host|user-agent|content-length|content-type)$/i.test(name)) {
      fail('汽水音乐签名组件返回了异常请求头。', 'setup');
    }
    headers[name] = value;
  }
}

/**
 * Return authorized metadata only. The caller must keep response URLs and
 * encryption metadata inside its local playback worker; do not log/cache them.
 * No storage, official app profile, BDTicket state or membership flags are read.
 */
async function requestMetadata({ route, params = {}, payload, label, device, jar, soda = sodaComponents(), signal, timeoutMs = 12000 }) {
  validateDevice(device);
  const cookie = cookieHeader(jar, route);
  if (signal?.aborted) fail('已取消获取' + label + '。', 'cancelled');
  if (!soda || !path.isAbsolute(soda.asar) || !path.isAbsolute(soda.unpacked)) fail('未找到汽水签名组件，请重新准备免安装组件。', 'setup');
  const { signer, version } = getSigner(device, soda);
  const url = new URL(route, API_ORIGIN);
  // The request platform must match bdms.node: a Mac signature sent with
  // device_platform=windows makes TrackV2 return HTTP 200 with an empty body.
  const mac = os.platform() === 'darwin';
  const query = {
    aid: '386088', app_name: 'luna_pc',
    region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
    device_id: device.did, cdid: '', iid: device.iid, fp: device.did,
    version_name: version, channel: device.channel,
    network_carrier: '', ac: 'wifi', tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
    resolution: '', device_platform: mac ? 'mac' : 'windows', device_type: mac ? 'Mac' : 'Windows', os_version: osVersion(),
    ...params,
  };
  // Unknown official build/version-code fields are deliberately not invented.
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers = {
    accept: 'application/json',
    cookie,
    'user-agent': 'LunaPC/' + version,
    ...(body === undefined ? {} : {
      'content-type': 'application/json; charset=utf-8',
      'X-SS-STUB': crypto.createHash('md5').update(body).digest('hex').toUpperCase(),
    }),
  };
  addSignature(signer, url.href, headers);
  const controller = new AbortController();
  const timeout = Math.max(1000, Math.min(20000, Number.isFinite(timeoutMs) ? timeoutMs : 12000));
  const timer = setTimeout(() => controller.abort(), timeout);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST', headers, body, redirect: 'manual', signal: controller.signal,
    });
    if (response.headers.get('bdturing-verify') || response.headers.get('x-tt-verify-passport-decision')) {
      await response.body?.cancel();
      fail('汽水音乐要求额外账号验证，当前连接无法完成该验证。', 'verificationRequired');
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail('汽水音乐接口暂时不可用（HTTP ' + response.status + '）。', 'qishuiApi', response.status);
    }
    const raw = await response.text();
    if (!raw.trim()) fail('汽水音乐未返回' + label + '，请稍后重试。', 'emptyResponse');
    if (raw.length > 4 * 1024 * 1024) fail('汽水音乐返回的' + label + '过大。', 'invalidResponse');
    let result;
    try { result = JSON.parse(raw); } catch { fail('汽水音乐返回的' + label + '格式无效。', 'invalidResponse'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('汽水音乐未返回有效' + label + '。', 'invalidResponse');
    const statusFields = [result.status_code, result.status_info?.code, result.status_info?.status_code]
      .filter(value => value !== undefined && value !== null && value !== '');
    const errorCode = statusFields.find(value => !Number.isFinite(Number(value)) || Number(value) !== 0);
    if (errorCode !== undefined) {
      const code = Number(errorCode);
      if (!Number.isFinite(code)) fail('汽水音乐返回了无法识别的状态。', 'invalidResponse');
      if (code === 1000016) fail('汽水登录已失效，请重新登录。', 'signIn', code);
      if (code !== 0) fail('汽水音乐接口返回错误（' + code + '）。', 'qishuiApi', code);
    }
    return result;
  } catch (error) {
    if (signal?.aborted) fail('已取消获取' + label + '。', 'cancelled');
    if (controller.signal.aborted) fail('获取汽水' + label + '超时，请稍后重试。', 'timeout');
    if (error?.safeMediaError === true) throw error;
    // Never propagate a native/network error containing signed request details.
    fail('无法连接汽水音乐接口，请检查网络后重试。', 'network', undefined, error?.cause?.code || error?.code);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function getTrackMetadata({ trackId, mediaType = 'track', device, jar, soda, signal, timeoutMs } = {}) {
  if (typeof trackId !== 'string' || !/^\d{1,32}$/.test(trackId)) fail('歌曲标识无效。', 'invalidTrack');
  // Official ugc_clip items use TrackV2 with their original media_type. Video
  // items use a different endpoint/contract and must not be sent as tracks.
  if (!['track', 'ugc_clip'].includes(mediaType)) fail('当前播放连接暂不支持此汽水媒体类型。', 'unsupported');
  return requestMetadata({
    route: TRACK_PATH,
    payload: { track_id: trackId, media_type: mediaType, queue_type: '', scene_name: 'search' },
    label: '歌曲信息', device, jar, soda, signal, timeoutMs,
  });
}

async function getSearchMetadata({ query, kind = 'track', cursor = '0', searchId, device, jar, soda, signal, timeoutMs } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300 || /[\u0000-\u001f\u007f]/.test(query)) {
    fail('请输入有效的汽水音乐搜索词。', 'invalidSearch');
  }
  if (!['track', 'album', 'artist', 'playlist'].includes(kind)) fail('汽水音乐搜索类型无效。', 'invalidSearch');
  if (typeof cursor !== 'string' || cursor.length > 1024 || /[\u0000-\u001f\u007f]/.test(cursor)) {
    fail('汽水音乐搜索分页信息无效。', 'invalidSearch');
  }
  if (searchId !== undefined && (typeof searchId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(searchId))) {
    fail('汽水音乐搜索会话无效。', 'invalidSearch');
  }
  return requestMetadata({
    route: '/luna/pc/search/' + kind,
    params: {
      q: query.trim(), cursor, search_id: searchId || crypto.randomUUID(), search_method: 'input',
      debug_params: '', from_search_id: '', search_scene: '',
    },
    label: '搜索结果', device, jar, soda, signal, timeoutMs,
  });
}

module.exports = { getTrackMetadata, getSearchMetadata };
