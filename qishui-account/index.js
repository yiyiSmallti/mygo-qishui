// Independent MyGo plugin. Assisted-by: Cindy (https://cindy.app)
// Calls Qishui Passport directly; never imports another application's session.
const ORIGIN = 'https://api.qishui.com';
const SESSION = 'qishui-session-v1';
const DIAGNOSTIC = 'qishui-login-diagnostic-v1';
const DEVICE = 'qishui-device-v1';
const VERSION = '0.6.6';
const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};
// Node.js runs the helpers. MyGo started from Finder/Dock has no shell PATH,
// so macOS tries the Homebrew and nodejs.org locations before a bare name.
const NODE = {
  windows: ['node', 'C:\\Program Files\\nodejs\\node.exe'],
  darwin: ['/opt/homebrew/bin/node', '/usr/local/bin/node', 'node'],
};
const supportedPlatform = () => typeof host !== 'undefined' && host && Object.prototype.hasOwnProperty.call(NODE, host.platform);

function missingNodeExecutable(error) {
  if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) return true;
  // Go's host.spawn exposes OS start errors as messages, localized on Windows.
  const message = error && typeof error.message === 'string' ? error.message : '';
  return /executable file not found|no such file or directory|the system cannot find the (?:file|path) specified|系统找不到指定的(?:文件|路径)/i.test(message);
}

function spawnHelper(script) {
  if (!supportedPlatform()) throw failure('当前系统暂不支持运行汽水辅助程序。', 'setup');
  const value = typeof host.setting === 'function' ? host.setting('nodePath') : '';
  const configured = typeof value === 'string' ? value.trim() : '';
  if (/[\u0000-\u001f\u007f]/.test(configured)) throw failure('Node.js 路径包含无效字符，请检查插件设置。', 'setup');
  // An explicit choice is authoritative; only automatic discovery falls back.
  for (const command of configured ? [configured] : NODE[host.platform]) {
    try { return host.spawn(command, [script]); }
    catch (error) { if (!missingNodeExecutable(error)) throw error; }
  }
  throw failure(configured
    ? '未找到设置的 Node.js。请在插件设置中检查“Node.js 路径”，填写可执行文件的完整路径，不要加引号。'
    : '未找到 Node.js。请安装 Node.js 24 或更新版本并重启 MyGo，或在插件设置中填写“Node.js 路径”。', 'setup');
}
let generation = 0;
let signingIn = false;
let activeHelper = null;
const mediaProcesses = new Set();
const mediaInflight = new Map();

function failure(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

function platformFailure(result, stage, jar, flow) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure(stage + '未返回有效数据。');
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {};
  const codes = [result.error_code, result.status_code, data.error_code];
  const present = codes.filter(x => x !== undefined && x !== null && x !== '');
  const bad = present.find(x => !Number.isFinite(Number(x)) || Number(x) !== 0);
  if (bad === undefined && (!result.message || result.message === 'success')) return;
  const code = bad !== undefined && /^\d{1,9}$/.test(String(bad)) ? String(Number(bad)) : 'unknown';
  let description = typeof data.description === 'string' ? data.description
    : typeof result.description === 'string' ? result.description : '';
  // Never copy raw payloads, cookies, QR URLs, account IDs or tokens into diagnostics.
  const secrets = Object.values(jar).map(c => c.value).concat(flow ? [flow.token, flow.portrait, flow.trace] : []);
  function collect(value, sensitive, depth) {
    if (depth > 8 || !value) return;
    if (typeof value === 'string') {
      if (sensitive) {
        secrets.push(value);
        for (const piece of value.split(';')) {
          const i = piece.indexOf('=');
          if (i >= 0 && piece.slice(i + 1).trim()) secrets.push(piece.slice(i + 1).trim());
        }
      }
    } else if (typeof value === 'object') {
      for (const key of Object.keys(value)) collect(value[key], sensitive || /cookie|session|token|secret|auth|password|(^|_)sid|(^|_)uid|user_id|phone|email/i.test(key), depth + 1);
    }
  }
  collect(result, false, 0);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    description = description.split(secret).join('[已隐藏]');
    description = description.split(encodeURIComponent(secret)).join('[已隐藏]');
  }
  description = description.replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/[A-Za-z0-9_+/=%.-]{12,}/g, '[已隐藏]')
    .replace(/\b1\d{10}\b/g, '[号码已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160).trim();
  if (!description) description = '平台未提供具体原因';
  const status = ['new', 'scanned', 'confirmed', '1', '2', '3', 'expired'].includes(String(data.status)) ? String(data.status) : 'unknown';
  const reasons = { host: '域名未列入支持列表', scheme: '需要 HTTPS 地址', credentials: '地址包含账号信息', port: '端口不受支持', url: '地址格式无效', length: '地址过长' };
  const entry = data.verificationEntry;
  const verificationEntry = entry && Object.prototype.hasOwnProperty.call(reasons, entry.reason) ? { reason: entry.reason, host: typeof entry.host === 'string' && /^[a-z0-9.-]{1,253}$/.test(entry.host) ? entry.host : '' } : null;
  host.storage.set(DIAGNOSTIC, { version: VERSION, time: new Date().toISOString(), stage, code, status, description, ...(verificationEntry ? { verificationEntry } : {}) });
  const entryDescription = verificationEntry ? '（入口域名：' + (verificationEntry.host || '无法解析') + '；原因：' + reasons[verificationEntry.reason] + '）' : '';
  if (code === '2046') throw failure('汽水要求额外安全验证，尚未登录成功。' + description + entryDescription);
  throw failure(stage + '失败（' + code + '）：' + description + (code === '2156' ? '。手机确认尚未完成电脑端账号连接。' : ''));
}

// Cookies are only used with the single, fixed API origin. Paths are preserved.
function collectCookies(jar, headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
  for (const line of values) {
    const parts = line.split(';').map(x => x.trim());
    const pair = /^([^=\s]+)=(.*)$/.exec(parts.shift() || '');
    if (!pair) continue;
    const attrs = {};
    for (const part of parts) {
      const i = part.indexOf('=');
      attrs[(i < 0 ? part : part.slice(0, i)).toLowerCase()] = i < 0 ? '' : part.slice(i + 1);
    }
    const domain = (attrs.domain || 'api.qishui.com').replace(/^\./, '').toLowerCase();
    if (domain !== 'api.qishui.com' && domain !== 'qishui.com') continue;
    const path = attrs.path || '/';
    const key = pair[1] + '|' + path;
    const maxAge = attrs['max-age'] === undefined ? null : Number(attrs['max-age']);
    const expires = maxAge !== null && Number.isFinite(maxAge)
      ? Date.now() + maxAge * 1000
      : (Date.parse(attrs.expires || '') || 0);
    if (!pair[2] || (expires && expires <= Date.now())) delete jar[key];
    else jar[key] = { name: pair[1], value: pair[2], path, expires };
  }
}

function cookieHeader(jar, path) {
  return Object.values(jar).filter(c => (!c.expires || c.expires > Date.now()) &&
    (path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')))
    .sort((a, b) => b.path.length - a.path.length)
    .map(c => c.name + '=' + c.value).join('; ');
}

function hasSession(jar) {
  return Object.values(jar).some(c => ['sessionid', 'sessionid_ss'].includes(c.name) &&
    c.value && (!c.expires || c.expires > Date.now()));
}

async function request(path, jar, body, flow, contentType) {
  if (!path.startsWith('/') || path.startsWith('//')) throw failure('接口路径无效。');
  const headers = { 'User-Agent': UA[host.platform] || UA.windows, 'Accept': 'application/json, text/javascript' };
  const cookie = cookieHeader(jar, path.split('?')[0]);
  if (cookie) headers.Cookie = cookie;
  if (path.startsWith('/passport/')) {
    const csrf = /(?:^|; )passport_csrf_token=([^;]+)/.exec(cookie)
      || /(?:^|; )passport_csrf_token_default=([^;]+)/.exec(cookie);
    if (csrf) headers['x-tt-passport-csrf-token'] = csrf[1];
    if (flow) {
      headers['x-tt-passport-verify-portrait'] = flow.portrait;
      headers['x-tt-passport-trace-id'] = flow.trace;
    }
  }
  if (body !== undefined) headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(ORIGIN + path, {
      method: body === undefined ? 'GET' : 'POST', headers, body,
      redirect: 'manual', signal: controller.signal,
    });
    // Do not follow authentication redirects or forward credentials elsewhere.
    if (res.status >= 300 && res.status < 400) throw failure('汽水登录接口要求跳转验证，当前插件无法完成。请使用官方客户端验证后重试。');
    if (!res.ok) throw failure('汽水接口暂时不可用（HTTP ' + res.status + '），请稍后重试。');
    collectCookies(jar, res.headers);
    const text = await res.text();
    if (!text.trim()) throw failure('汽水接口返回空内容，可能需要官方安全验证。');
    try { return JSON.parse(text); }
    catch (_) { throw failure('汽水接口未返回有效数据，请稍后重试。'); }
  } catch (e) {
    if (e.name === 'AbortError') throw failure('连接汽水音乐超时，请检查网络后重试。');
    if (e instanceof TypeError) throw failure('无法连接汽水音乐，请检查网络后重试。');
    throw e;
  } finally { clearTimeout(timer); }
}

function readStored() {
  const saved = host.storage.get(SESSION);
  return saved && saved.jar && typeof saved.jar === 'object' ? saved : null;
}

// All authenticated account/music calls remain on the fixed first-party origin.
async function musicApi(route, params = {}, body) {
  if (!route.startsWith('/luna/')) throw failure('音乐接口路径无效。');
  const saved = readStored();
  if (!saved || !hasSession(saved.jar)) throw failure('请先登录汽水音乐。', 'signIn');
  const epoch = generation;
  const device = saved.device || host.storage.get(DEVICE);
  const common = { aid: '386088' };
  if (device && typeof device.did === 'string' && typeof device.iid === 'string') {
    Object.assign(common, { device_id: device.did, install_id: device.iid, iid: device.iid, fp: device.did });
  }
  const query = [];
  for (const [key, value] of Object.entries({ ...common, ...params })) {
    if (value === undefined || value === null) continue;
    for (const item of (Array.isArray(value) ? value : [value])) query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(item)));
  }
  const result = await request(route + '?' + query.join('&'), saved.jar,
    body === undefined ? undefined : JSON.stringify(body), undefined, 'application/json');
  if (epoch !== generation) throw failure('账号已切换，请重新打开页面。');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('汽水音乐接口未返回有效数据。');
  const raw = result.status_code === undefined ? (result.status_info && (result.status_info.code === undefined ? result.status_info.status_code : result.status_info.code)) : result.status_code;
  const code = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
  if (!Number.isFinite(code)) throw failure('汽水音乐接口返回无效状态。');
  if (code === 1000016) { host.storage.remove(SESSION); throw failure('汽水登录已失效，请重新登录。', 'signIn'); }
  if (code) throw failure('汽水暂时无法提供此内容（' + code + '）。');
  host.storage.set(SESSION, { ...saved, jar: saved.jar });
  return result;
}

async function verifyAccount(jar, device) {
  if (!hasSession(jar)) throw failure('尚未取得汽水登录凭据，请重新扫码。', 'signIn');
  const extra = device && typeof device.did === 'string' && typeof device.iid === 'string'
    ? '&device_id=' + encodeURIComponent(device.did) + '&install_id=' + encodeURIComponent(device.iid) : '';
  const result = await request('/luna/pc/me?aid=386088' + extra, jar);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('汽水账号接口未返回有效数据。');
  const code = Number(result.status_code || 0);
  if (!Number.isFinite(code)) throw failure('汽水账号接口返回无效状态。');
  if (code === 1000016) throw failure('汽水登录已失效，请重新扫码。', 'signIn');
  if (code) throw failure('汽水账号校验未通过（' + code + '），请在官方客户端检查账号状态。');
  const info = result.my_info;
  if (!info || !info.nickname) throw failure('未能确认汽水账号身份，请重新登录。');
  const id = info.user_id || info.uid || info.id || info.douyin_id;
  if (!id || (typeof id === 'number' && !Number.isSafeInteger(id))) throw failure('汽水返回的账号标识不完整，无法确认登录。');
  const avatar = imageURL(info.artist_brief && info.artist_brief.url_avatar || info.medium_avatar_url);
  return { id: String(id), name: String(info.nickname), ...(avatar ? { imageUrl: avatar } : {}) };
}

export async function signIn() {
  if (signingIn) throw failure('登录窗口已打开，请完成当前扫码。');
  signingIn = true;
  const epoch = ++generation;
  let helper, timer;
  const closedHelpers = new Set();
  const startedAt = Date.now();
  const closeHelper = () => {
    if (helper && !closedHelpers.has(helper)) {
      const closing = helper; closedHelpers.add(closing);
      try { closing.closeStdin(); } catch (_) {}
      if (typeof closing.kill === 'function') setTimeout(() => { try { closing.kill(); } catch (_) {} }, 1500);
    }
    if (activeHelper === helper) activeHelper = null;
  };
  const current = () => { if (epoch !== generation) throw failure('登录已取消。'); };
  try {
    if (!supportedPlatform()) throw failure('当前内嵌登录版仅适配 Windows 和 macOS。');
    host.signInPrompt({ text: '正在准备汽水插件设备，扫码和二次验证将在插件自带的登录窗口完成，无需打开浏览器。' });
    helper = spawnHelper('./device-helper.cjs'); activeHelper = helper;
    helper.write(JSON.stringify({ type: 'start', device: host.storage.get(DEVICE) || null, ...(typeof host.dataDir === 'string' ? { dataDir: host.dataDir } : {}) }) + '\n');
    let timedOut;
    const timeout = new Promise((_, reject) => { timedOut = reject; });
    const arm = milliseconds => { clearTimeout(timer); timer = setTimeout(() => { closeHelper(); timedOut(failure('登录已超时，请重新登录。')); }, milliseconds); };
    arm(255000);
    let preparing = false, message;
    while (true) {
      const line = await Promise.race([helper.readLine(), timeout]); current();
      if (line === null) throw failure('设备辅助程序已退出，尚未完成账号连接。');
      if (typeof line !== 'string' || line.length > 262144) throw failure('设备辅助程序返回无效消息。');
      try { message = JSON.parse(line); } catch (_) { throw failure('设备辅助程序返回无效消息。'); }
      if (!message || typeof message !== 'object') throw failure('设备辅助程序返回无效消息。');
      if (message.type === 'progress') {
        if (!preparing) { arm(Math.min(255000, 270000 - (Date.now() - startedAt))); preparing = true; }
        host.signInPrompt({ text: typeof message.text === 'string' ? message.text.slice(0, 160) : '正在准备汽水组件…' });
      } else if (message.type === 'device') break;
      else if (message.type === 'error') throw failure(typeof message.description === 'string' ? message.description.slice(0, 220) : '汽水设备初始化失败，请检查网络后重试。', message.code === 'setup' ? 'setup' : undefined);
      else throw failure('设备辅助程序返回未知消息。');
    }
    const device = message.device;
    if (!device || device.schema !== 1 || device.aid !== 386088 || typeof device.did !== 'string' || typeof device.iid !== 'string'
      || !/^[1-9]\d{8,24}$/.test(device.did) || !/^[1-9]\d{8,24}$/.test(device.iid)
      || typeof message.computerName !== 'string' || !message.computerName || message.computerName.length > 255 || /[\u0000-\u001f\u007f]/.test(message.computerName)
      || !['Windows', 'Mac'].includes(message.osLabel)) throw failure('登录设备注册结果无效。');
    host.storage.set(DEVICE, device); closeHelper(); clearTimeout(timer);
    const timeoutMs = Math.min(240000, Math.floor((270000 - (Date.now() - startedAt)) / 1000) * 1000);
    if (timeoutMs < 1000) throw failure('组件准备超过本次登录时限，请重新登录。');
    host.signInPrompt({ text: '请在汽水插件的登录窗口扫码并完成官方验证，成功后窗口会自动关闭。' });
    try { helper = host.spawn(host.platform === 'windows' ? './native/qishui-login.exe' : './native/qishui-login', []); }
    catch (error) { if (missingNodeExecutable(error)) throw failure('插件缺少本机登录组件，请下载对应平台的插件 ZIP 重新安装。', 'setup'); throw error; }
    activeHelper = helper;
    helper.write(JSON.stringify({ type: 'start', device, computerName: message.computerName, osLabel: message.osLabel, timeoutMs }) + '\n');
    arm(timeoutMs + 10000);
    const line = await Promise.race([helper.readLine(), timeout]); current();
    if (typeof line !== 'string' || line.length > 262144) throw failure('登录组件已退出或返回无效消息，请重新登录。');
    let outcome;
    try { outcome = JSON.parse(line); } catch (_) { throw failure('登录组件返回无效消息，请重新登录。'); }
    if (!outcome || !['complete', 'error'].includes(outcome.type)) throw failure('登录组件返回未知消息，请重新登录。');
    const result = outcome.type === 'error' ? { error: { code: outcome.code, message: outcome.message } } : { cookie: outcome.cookie };
    current();
    if (result?.error) {
      const code = result.error.code;
      const description = code === 'closed' ? '内嵌登录窗口已关闭，登录尚未完成。请重新登录，并在完成前保留验证窗口。'
        : code === 'timeout' ? '内嵌登录已超时，请重新登录。'
        : code === 'load' ? '内嵌登录页面未能加载，请检查网络后重试。' : typeof result.error.message === 'string' ? result.error.message.slice(0, 500) : '内嵌登录未能完成，请重新登录。';
      host.storage.set(DIAGNOSTIC, { version: VERSION, time: new Date().toISOString(), stage: '内嵌登录', code: String(code || 'page'), description });
      throw failure(description);
    }
    if (!result || typeof result.cookie !== 'string' || result.cookie.length > 65536 || /[\r\n\u0000]/.test(result.cookie)) throw failure('内嵌登录未返回有效凭据。');
    const jar = {};
    for (const part of result.cookie.split(';')) {
      const pair = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(.*)$/.exec(part);
      if (pair && pair[2] && !/[;\r\n]/.test(pair[2])) jar[pair[1] + '|/'] = { name: pair[1], value: pair[2], path: '/', expires: 0 };
    }
    const account = await verifyAccount(jar, device); current();
    host.storage.set(SESSION, { jar, account, device }); host.storage.remove(DIAGNOSTIC);
    host.signInPrompt({ text: '账号已验证，登录成功。' }); return account;
  } finally { clearTimeout(timer); closeHelper(); signingIn = false; }
}

export async function account() {
  const saved = readStored();
  if (!saved) return null;
  const epoch = generation;
  try {
    const account = await verifyAccount(saved.jar, saved.device);
    if (epoch !== generation) return null;
    host.storage.set(SESSION, { jar: saved.jar, account, device: saved.device });
    return account;
  } catch (e) {
    if (e.code === 'signIn' && epoch === generation) { host.storage.remove(SESSION); return null; }
    throw e;
  }
}

export function signOut() {
  generation++;
  clearMusicCache();
  for (const process of mediaProcesses) { try { process.closeStdin(); } catch (_) {} }
  mediaInflight.clear();
  if (activeHelper) { try { activeHelper.closeStdin(); } catch (_) {} }
  host.storage.remove(SESSION);
}

function requestMedia(operation, params) {
  const saved = readStored();
  if (!saved || !hasSession(saved.jar)) return Promise.reject(failure('请先登录汽水音乐。', 'signIn'));
  const epoch = generation, key = epoch + ':' + operation + ':' + JSON.stringify(params);
  if (mediaInflight.has(key)) return mediaInflight.get(key);
  const work = (async () => {
    let helper, timer;
    try {
      const cacheDir = mediaCacheDir();
      if (!cacheDir) throw failure('MyGo 未提供插件数据目录，无法缓存音频。', 'unavailable');
      helper = spawnHelper('./media-helper.cjs');
      mediaProcesses.add(helper);
      helper.write(JSON.stringify({ ...params, operation, cacheDir, device: saved.device || host.storage.get(DEVICE),
        jar: saved.jar, accountId: saved.account && saved.account.id }) + '\n');
      let timedOut;
      const timeout = new Promise((_, reject) => { timedOut = reject; });
      const arm = milliseconds => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try { helper.closeStdin(); } catch (_) {}
          timedOut(failure('获取音乐超时，请重试或选择较低音质。', 'unavailable'));
        }, milliseconds);
      };
      arm(28500);
      let preparing = false, message;
      while (true) {
        const line = await Promise.race([helper.readLine(), timeout]);
        if (epoch !== generation) throw failure('账号已变化，本次音乐请求已取消。');
        if (typeof line !== 'string' || line.length > 4 * 1024 * 1024) throw failure('音乐组件未返回有效结果。', 'unavailable');
        try { message = JSON.parse(line); } catch (_) { throw failure('音乐组件返回无效消息。', 'unavailable'); }
        if (message && message.type === 'progress') {
          if (!preparing) { arm(720000); preparing = true; }
        } else if (message && message.type === 'ready') arm(28500);
        else break;
      }
      if (epoch !== generation) throw failure('账号已变化，本次音乐请求已取消。');
      if (!message || message.ok !== true) {
        if (message && message.code === 'signIn') { host.storage.remove(SESSION); clearMusicCache(); }
        const code = message && ['signIn', 'setup', 'unavailable', 'unsupported'].includes(message.code) ? message.code : 'unavailable';
        throw failure(message && typeof message.message === 'string' ? message.message.slice(0, 220) : '这首歌暂时无法播放。', code);
      }
      return message.value;
    } finally {
      clearTimeout(timer);
      if (helper) { mediaProcesses.delete(helper); try { helper.closeStdin(); } catch (_) {} }
    }
  })();
  mediaInflight.set(key, work);
  work.then(() => mediaInflight.delete(key), () => mediaInflight.delete(key));
  return work;
}

function playbackIdentity(value) {
  const id = safeId(value);
  const match = /^(?:(ugc_clip|ugc_video):)?(\d{1,32})$/.exec(id);
  if (!match) throw failure('歌曲标识无效。', 'unavailable');
  if (match[1] === 'ugc_video') throw failure('这条收藏是视频作品，当前插件暂不支持视频播放。', 'unsupported');
  return { trackId: match[2], mediaType: match[1] || 'track' };
}

// MyGo's per-plugin data folder (host.dataDir) plus media-cache, which the
// worker writes to; only <...>/plugin-data/qishui-account is accepted.
function mediaCacheDir() {
  const dir = typeof host !== 'undefined' && host && typeof host.dataDir === 'string' ? host.dataDir : '';
  if (!dir || /[\u0000-\u001f\u007f]/.test(dir)) return '';
  const windows = /^[a-z]:[\\/]/i.test(dir);
  if (!windows && !dir.startsWith('/')) return '';
  const parts = dir.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  if (parts.includes('..') || parts.includes('.') || parts.slice(-2).join('/') !== 'plugin-data/qishui-account') return '';
  return (windows ? '' : '/') + parts.concat('media-cache').join(windows ? '\\' : '/');
}

// URL path the worker's pathToFileURL gives for that folder: /C:/... on Windows.
function mediaCacheURLPath() {
  const dir = mediaCacheDir();
  if (!dir) return '';
  return /^[a-z]:/i.test(dir) ? '/' + dir.replace(/\\/g, '/') + '/' : dir + '/';
}

export async function stream({ id, quality = 'standard' } = {}) {
  const result = await requestMedia('stream', { ...playbackIdentity(id), quality });
  let url, path;
  try { url = new URL(result && result.url); path = decodeURIComponent(url.pathname); }
  catch (_) { throw failure('音乐组件未返回有效音频。', 'unavailable'); }
  const cache = mediaCacheURLPath();
  if (url.protocol !== 'file:' || url.hostname || url.search || url.hash || result.type !== 'flac' || !cache ||
    !path.startsWith(cache) || !/^[a-f0-9]{64}\.flac$/.test(path.slice(cache.length)))
    throw failure('音频缓存来源不符合预期。', 'unavailable');
  return result;
}

export async function lyrics({ id } = {}) {
  const result = await requestMedia('lyrics', playbackIdentity(id));
  return parseQishuiLyrics(result && result.content);
}

// Pure Qishui -> MyGo normalization. Assisted-by: Cindy (https://cindy.app)
// IDs are never coerced from objects or unsafe IEEE-754 numbers.
function safeId(value) {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

function qnText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function qnFirstId(...values) {
  for (const value of values) { const id = safeId(value); if (id) return id; }
  return '';
}

function qnNumber(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function qnHttps(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

function imageURL(value) {
  if (typeof value === 'string') return qnHttps(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const candidates = Array.isArray(value.urls) ? value.urls : Array.isArray(value.url_list) ? value.url_list : [];
  let base = '';
  for (const candidate of candidates) {
    base = qnHttps(candidate);
    if (base) break;
  }
  if (!base) return qnHttps(value.url) || qnHttps(value.imageUrl);
  const uri = qnText(value.uri);
  if (!uri || value.need_complete_url === true) return base;
  const url = new URL(base);
  // Official URL prefixes end in '/'. A complete image URL must not have
  // uri appended a second time, including extensionless signed images.
  if (!url.pathname.endsWith('/') || url.search || url.hash) return base;
  if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('//') || /[\\\u0000-\u001f\u007f?#]/.test(uri)) return '';
  const parts = uri.replace(/^\/+/, '').split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) return '';
  const prefix = qnText(value.template_prefix);
  if (prefix && !/^[a-z\d_:.-]+$/i.test(prefix)) return '';
  const suffix = prefix ? prefix + '-crop-center:400:400.jpg' : 'c5_400x400.jpg';
  url.pathname += parts.join('/') + '~' + suffix;
  return url.href;
}

// Only IDs whose PNGs ship in this package get individual scene artwork.
// New server-side scenes keep a visible fallback until the package adds them.
const STATION_ARTWORK_SCENES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 44, 45, 47, 48,
]);

function stationArtwork(id, glyph = false) {
  if (typeof id !== 'string') return '';
  let name;
  if (id === 'recommend' || id === 'familiar' || id === 'fresh') {
    name = id;
  } else {
    const match = /^scene:(0|[1-9]\d*)$/.exec(id);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return '';
    name = STATION_ARTWORK_SCENES.has(Number(match[1])) ? 'scene-' + match[1] : 'scene-default';
  }
  // Glyphs are supplied only to mode-buttons; the host tints their alpha
  // to match its theme. The regular station catalog retains opaque covers.
  if (glyph && (name === 'recommend' || name === 'scene-default')) return '';
  const filename = name + '.png';
  if (typeof host === 'undefined' || !host || typeof host.dir !== 'string' || /[\u0000-\u001f\u007f]/.test(host.dir)) return '';
  const directory = host.dir.replace(/\\/g, '/');
  let prefix, parts;
  if (/^[a-z]:\//i.test(directory)) {
    prefix = 'file:///' + directory.slice(0, 2);
    parts = directory.slice(3).split('/');
  } else if (directory.startsWith('/') && !directory.startsWith('//')) {
    prefix = 'file://';
    parts = directory.slice(1).split('/');
  } else {
    return '';
  }
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  if (parts.some(part => !part || part === '.' || part === '..')) return '';
  // Encode each filesystem segment, including literal % and #. Keeping the
  // drive outside this encoding produces file:///C:/, not a file://C: host.
  return prefix + '/' + parts.concat('assets', glyph ? 'mode-icons' : 'stations', filename).map(encodeURIComponent).join('/');
}

function mapArtist(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const info = record.user_info && typeof record.user_info === 'object' ? record.user_info : record;
  const artistId = qnFirstId(record.id, record.artist_id, info.artist_id);
  const userId = record.user_info ? safeId(info.id) : '';
  // A track's UGC uploader is a user, not an artist. Keep that distinction
  // so the detail route requests /users/{id}, never /artists/{userId}.
  const id = artistId || (userId ? 'user:' + userId : '');
  const name = artistId
    ? qnText(record.name) || qnText(info.nickname) || qnText(info.name)
    : qnText(info.nickname) || qnText(info.name) || qnText(record.name);
  if (!id || !name) return null;
  const artist = { id, name };
  const image = imageURL(info.medium_avatar_url) || imageURL(info.thumb_avatar_url) || imageURL(info.url_avatar) || imageURL(info.imageUrl);
  if (image) artist.imageUrl = image;
  if (record.following === true || record.state?.is_following === true) artist.following = true;
  return artist;
}

function mapAlbum(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const raw = record.album && typeof record.album === 'object' ? record.album : record;
  const id = qnFirstId(raw.id, raw.album_id);
  const name = qnText(raw.name) || qnText(raw.title);
  if (!id || !name) return null;
  const album = { id, name };
  const image = imageURL(raw.url_cover) || imageURL(raw.imageUrl) || imageURL(raw.cover);
  if (image) album.imageUrl = image;
  if (Array.isArray(raw.artists)) {
    const artists = raw.artists.map(mapArtist).filter(Boolean);
    if (artists.length) album.artists = artists;
  }
  const released = qnText(raw.release_date) || qnText(raw.released);
  if (released) album.released = released;
  if (raw.saved === true || raw.state?.is_collected === true) album.saved = true;
  return album;
}

function mapTrack(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.entity && record.type && record.type !== 'track') return null;
  const raw = record.entity?.track_wrapper?.track || record.entity?.track || record.track_wrapper?.track || record.track || record;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = qnFirstId(raw.id, raw.track_id);
  const name = qnText(raw.name) || qnText(raw.title);
  if (!id || !name) return null;
  const duration = qnNumber(raw.duration) ?? qnNumber(raw.duration_ms) ?? 0;
  const rawAlbum = raw.album && typeof raw.album === 'object' && !Array.isArray(raw.album) ? raw.album : null;
  const album = mapAlbum(rawAlbum) || { id: '', name: qnText(rawAlbum?.name) || qnText(rawAlbum?.title) };
  if (!album.imageUrl) {
    // UGC can have artwork and a title without a real album ID. MyGo displays
    // this metadata without making the empty-ID album a navigation target.
    const image = imageURL(rawAlbum?.url_cover) || imageURL(rawAlbum?.imageUrl) || imageURL(rawAlbum?.cover)
      || imageURL(raw.url_cover) || imageURL(raw.imageUrl);
    if (image) album.imageUrl = image;
  }
  const track = {
    id: ['ugc_clip', 'ugc_video'].includes(raw.media_type) ? raw.media_type + ':' + id : id,
    name, album, duration,
    artists: Array.isArray(raw.artists) ? raw.artists.map(mapArtist).filter(Boolean) : [],
  };
  const shareURL = qnHttps(raw.share_url) || qnHttps(raw.url);
  if (shareURL) track.url = shareURL;
  if (raw.unavailable === true) track.unavailable = true;
  return track;
}

function mapPlaylist(record, mine) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const raw = record.playlist || record.entity?.playlist || record;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = qnFirstId(raw.id, raw.playlist_id);
  const name = qnText(raw.title) || qnText(raw.name);
  if (!id || !name) return null;
  const playlist = { id, name, mine: typeof mine === 'boolean' ? mine : raw.mine === true };
  const image = imageURL(raw.url_cover) || imageURL(raw.imageUrl) || imageURL(raw.cover);
  if (image) playlist.imageUrl = image;
  const description = qnText(raw.description) || qnText(raw.desc);
  if (description) playlist.description = description;
  const owner = qnText(raw.owner?.nickname) || qnText(raw.owner?.name) || qnText(raw.owner);
  if (owner) playlist.owner = owner;
  const count = qnNumber(raw.count_tracks) ?? qnNumber(raw.trackCount) ?? qnNumber(raw.stats?.count_visible);
  if (count !== null) playlist.trackCount = count;
  if (raw.saved === true || raw.state?.is_collected === true) playlist.saved = true;
  if (Array.isArray(raw.tracks)) {
    playlist.tracks = raw.tracks.map(mapTrack).filter(Boolean);
    // A remote count can be stale; keep it unless the caller knows it has
    // fetched every page. Callers own that completeness decision.
  }
  return playlist;
}

function parseQishuiLyrics(content) {
  const lines = [];
  if (typeof content !== 'string') return { lines };
  for (const source of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*\[(\d+),(\d+)\](.*)$/.exec(source);
    if (!match) continue;
    const start = qnNumber(match[1]), duration = qnNumber(match[2]);
    if (start === null || duration === null || !Number.isSafeInteger(start + duration)) continue;
    const end = start + duration, body = match[3];
    const tags = [...body.matchAll(/<([^>]*)>/g)];
    const text = body.replace(/<[^>]*>/g, '').trim();
    if (!text) continue;
    const words = [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i], fields = /^(\d+),(\d+),[^,]*$/.exec(tag[1]);
      if (!fields) continue;
      const offset = qnNumber(fields[1]), length = qnNumber(fields[2]);
      const wordText = body.slice(tag.index + tag[0].length, i + 1 < tags.length ? tags[i + 1].index : body.length);
      if (offset === null || length === null || !wordText || offset > duration || !Number.isSafeInteger(start + offset + length)) continue;
      words.push({ start: start + offset, end: Math.min(end, start + offset + length), text: wordText });
    }
    const line = { start, end, text };
    if (words.length) line.words = words;
    lines.push(line);
  }
  lines.sort((a, b) => a.start - b.start);
  return { lines };
}

// Read-only music library. Merged after musicApi and normalization helpers.
const MUSIC_PAGE = 50;
const MUSIC_LIMIT = 5000;
const MUSIC_LIST_LIMIT = 2000;
const MUSIC_CACHE_MS = 60000;
let musicCache = null;
const searchCache = new Map();
let recommendationPreview = null;
const recommendationService = createRecommendationService({
  api: (...args) => musicApi(...args), mapTrack, mapPlaylist, imageURL, stationArtwork,
  contextKey: () => musicContext().key, failure,
});
const likesService = createLikesService({
  api: (...args) => musicApi(...args), contextKey: () => musicContext().key,
  onChanged: invalidateLikedCaches, failure,
});

function invalidateLikedCaches() {
  // A heart changes library contents, not the playing station or its cursor.
  musicCache = null; searchCache.clear(); recommendationPreview = null;
}

function clearMusicCache() {
  musicCache = null; searchCache.clear(); recommendationPreview = null;
  recommendationService.reset();
}

export async function stations() { return recommendationService.stations(); }
export async function stationNext(params) { return recommendationService.stationNext(params); }
export async function isLiked(params) { return likesService.isLiked(params); }
export async function like(params) { return likesService.like(params); }

async function recommendedTracks(refresh = false) {
  const context = musicContext();
  let state = recommendationPreview;
  if (!state || state.key !== context.key) {
    state = { key: context.key, tracks: null, at: 0, requests: 0, pending: null };
    recommendationPreview = state;
  }
  if (state.pending) return state.pending;
  if (!refresh && state.tracks && Date.now() - state.at < 300000) return state.tracks;
  const work = (async () => {
    const result = await musicApi('/luna/pc/feed/song-tab', {}, {
      is_first_request: state.requests === 0, is_did_first_request: false,
      feed_counts: { mix_session_count: state.requests },
    });
    musicCurrent(context);
    if (recommendationPreview !== state) throw failure('推荐已刷新，请重新打开页面。');
    if (!Array.isArray(result.items)) throw failure('汽水推荐暂未返回有效歌曲。');
    const ids = new Set(), tracks = [];
    for (const item of result.items) {
      const raw = item && (item.entity?.track_wrapper?.track || item.entity?.track);
      if (item?.type !== 'track' || !raw || (raw.media_type && !['track', 'ugc_clip'].includes(raw.media_type))) continue;
      const track = mapTrack(item);
      if (!track || track.unavailable || ids.has(track.id)) continue;
      ids.add(track.id); tracks.push(track);
    }
    state.tracks = tracks; state.at = Date.now(); state.requests++;
    return tracks;
  })();
  state.pending = work;
  try { return await work; } finally { if (state.pending === work) state.pending = null; }
}

async function recommendationSections({ refresh = false } = {}) {
  const [songs, catalog] = await Promise.allSettled([
    recommendedTracks(refresh), recommendationService.catalog(),
  ]);
  const sections = [];
  const retry = songs.status === 'rejected' || catalog.status === 'rejected';
  const refreshLink = {
    title: retry ? '重试推荐' : '换一批推荐',
    subtitle: retry ? '部分推荐暂时无法获取，点击重试。' : '换一些新歌，不影响正在播放的歌曲。',
    page: 'recommend/refresh/' + Date.now(), reload: true,
  };
  // Keep the action with the content it changes, directly below the feature.
  // Its lack of artwork is intentional: it is a button, not an album cover.
  if (songs.status === 'fulfilled' && songs.value.length) {
    sections.push({ title: '为你推荐', tracks: songs.value, links: [refreshLink] });
  } else {
    sections.push({ links: [refreshLink] });
  }
  if (catalog.status === 'fulfilled') {
    const value = catalog.value;
    sections.push({ title: '连续听歌', layout: 'compact', stations: value.primary });
    if (value.scenes.length) sections.push({ title: '按场景听歌', stations: value.scenes.slice(0, 4), morePage: 'recommend/scenes' });
    if (value.radios.length) sections.push({ title: '发现电台', stations: value.radios.slice(0, 4), morePage: 'recommend/radios' });
    if (value.playlists.length) sections.push({ title: '推荐歌单', playlists: value.playlists.slice(0, 4),
      morePage: value.playlists.length > 4 ? 'recommend/playlists' : undefined });
  }
  return sections;
}

function musicContext() {
  const stored = readStored();
  const id = safeId(stored && stored.account && stored.account.id);
  if (!id) { clearMusicCache(); throw failure('请先登录汽水音乐账号。', 'signIn'); }
  const key = id + ':' + generation;
  if (!musicCache || musicCache.key !== key) musicCache = { key, id, own: null, mixed: null, tracks: new Map() };
  return musicCache;
}

function musicCurrent(context) {
  const stored = readStored();
  if (musicCache !== context || !stored || safeId(stored.account && stored.account.id) + ':' + generation !== context.key)
    throw failure('账号已变化，请重新打开音乐库。');
}

function musicDeadline() { return Date.now() + 25000; }
function musicBudget(promise, deadline) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(failure('加载音乐库超时，请重新打开继续加载。')); return; }
    const timer = setTimeout(() => reject(failure('加载音乐库超时，请重新打开继续加载。')), remaining);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function musicState() {
  return { items: [], ids: new Set(), cursors: new Set(), cursor: '', done: false, capped: false, pages: 0, time: Date.now(), pending: null, meta: null };
}

function musicListState(context, key) {
  let state = context[key];
  if (!state || (state.done && Date.now() - state.time > MUSIC_CACHE_MS)) state = context[key] = musicState();
  return state;
}

function musicTrackState(context, id, refresh) {
  let state = context.tracks.get(id);
  if (!state || (refresh && state.done && Date.now() - state.time > MUSIC_CACHE_MS)) {
    if (!state && context.tracks.size >= 12) {
      const oldest = [...context.tracks.entries()].filter(entry => !entry[1].pending).sort((a, b) => a[1].time - b[1].time)[0];
      if (oldest) context.tracks.delete(oldest[0]);
    }
    state = musicState();
    context.tracks.set(id, state);
  }
  return state;
}

async function musicFetchPage(context, state, route, params, field, normalize, maxItems, deadline) {
  musicCurrent(context);
  if (state.done || state.capped) return;
  if (state.pending) return musicBudget(state.pending, deadline);
  if (state.pages >= 100) throw failure('歌单分页过多，请稍后刷新音乐库。');
  if (Date.now() >= deadline) throw failure('加载音乐库超时，请重新打开继续加载。');
  const cursor = state.cursor;
  const load = (async () => {
    const response = await musicBudget(musicApi(route, { ...params, cursor, count: 100 }), deadline);
    musicCurrent(context);
    const hasMore = response.has_more === true;
    const next = typeof response.next_cursor === 'string' ? response.next_cursor : '';
    if (hasMore && (!next || next === cursor || state.cursors.has(next)))
      throw failure('汽水返回了重复或缺失的分页游标，未能加载完整歌单。');
    const rawItems = response[field] === undefined ? [] : response[field];
    if (!Array.isArray(rawItems)) throw failure('汽水返回的音乐库列表格式无效。');
    if (response.playlist && typeof response.playlist === 'object') {
      if (params.playlist_id && safeId(response.playlist.id) !== params.playlist_id)
        throw failure('汽水返回的歌单资料与请求不一致。');
      state.meta = response.playlist;
    }
    let overflow = false;
    for (const raw of rawItems) {
      const mapped = normalize(raw);
      if (!mapped || !mapped.id || state.ids.has(mapped.id)) continue;
      if (state.items.length >= maxItems) { overflow = true; break; }
      state.ids.add(mapped.id);
      state.items.push(mapped);
    }
    state.cursors.add(cursor);
    state.cursor = next;
    state.pages++;
    state.done = !hasMore && !overflow;
    state.capped = overflow || (!state.done && state.items.length >= maxItems);
    state.time = Date.now();
  })();
  state.pending = load;
  try { await load; } finally { if (state.pending === load) state.pending = null; }
}

function musicOwnItem(raw) {
  const id = safeId(raw && raw.id);
  return id ? { id, raw } : null;
}

function musicMixedItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entity = raw.item_type === 'playlist' ? raw.playlist : raw.item_type === 'album' ? raw.album : null;
  const id = safeId(entity && entity.id);
  return id ? { id: raw.item_type + ':' + id, raw } : null;
}

async function musicLoadOwn(context, deadline) {
  const state = musicListState(context, 'own');
  while (!state.done && !state.capped)
    await musicFetchPage(context, state, '/luna/pc/me/playlist', {}, 'playlists', musicOwnItem, MUSIC_LIST_LIMIT, deadline);
  if (state.capped) throw failure('歌单数量超过当前版本可加载的 2000 项，未返回不完整列表。');
  return state.items.map(item => item.raw);
}

async function musicLoadMixed(context, deadline) {
  const state = musicListState(context, 'mixed');
  while (!state.done && !state.capped)
    await musicFetchPage(context, state, '/luna/pc/me/collection/mixed', { item_types: ['album', 'playlist'] }, 'mixed_collections', musicMixedItem, MUSIC_LIST_LIMIT, deadline);
  if (state.capped) throw failure('收藏数量超过当前版本可加载的 2000 项，未返回不完整列表。');
  return state.items.map(item => item.raw);
}

function musicPlaylistList(own, mixed) {
  // The native liked page is the single navigation entry for the account's
  // type-1 playlist. Keep it in the raw cache for liked(), but omit its card
  // here, including a duplicate copy returned by the collection endpoint.
  const found = new Set(own.filter(raw => Number(raw.type) === 1).map(raw => safeId(raw.id)).filter(Boolean));
  const result = [];
  for (const raw of own) {
    if (Number(raw.type) === 1) continue;
    const item = mapPlaylist(raw, true);
    if (item && !found.has(item.id)) { found.add(item.id); result.push(item); }
  }
  for (const entry of mixed) {
    if (entry.item_type !== 'playlist') continue;
    const item = mapPlaylist(entry.playlist, false);
    if (item && !found.has(item.id)) { item.saved = true; found.add(item.id); result.push(item); }
  }
  return result;
}

async function musicLoadTracks(context, id, minimum, deadline, refresh = false) {
  const state = musicTrackState(context, id, refresh);
  while (!state.done && !state.capped && state.items.length < minimum)
    await musicFetchPage(context, state, '/luna/pc/playlist/detail', { playlist_id: id }, 'media_resources', mapTrack, MUSIC_LIMIT, deadline);
  return state;
}

function musicOffset(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw failure('音乐库分页参数无效。');
  return value;
}

async function musicSpecialTracks(context, type, offset, deadline) {
  const own = await musicLoadOwn(context, deadline);
  const raw = own.find(item => Number(item.type) === type);
  if (!raw) return { tracks: [], more: false, name: type === 1 ? '喜欢的音乐' : '抖音收藏' };
  if (offset >= MUSIC_LIMIT) throw failure('当前版本每个歌单最多加载 5000 首，后续曲目尚未载入。');
  const state = await musicLoadTracks(context, safeId(raw.id), offset + MUSIC_PAGE, deadline, offset === 0);
  const tracks = state.items.slice(offset, offset + MUSIC_PAGE);
  const more = state.items.length > offset + tracks.length || !state.done;
  if (!tracks.length && more) throw failure('这一页歌曲尚未载入，请重新打开继续加载。');
  return { tracks, more, name: typeof raw.title === 'string' ? raw.title : type === 1 ? '喜欢的音乐' : '抖音收藏' };
}

export async function playlists() {
  const deadline = musicDeadline(), context = musicContext();
  const [own, mixed] = await Promise.all([musicLoadOwn(context, deadline), musicLoadMixed(context, deadline)]);
  musicCurrent(context);
  return musicPlaylistList(own, mixed);
}

export async function playlist({ id } = {}) {
  const playlistId = safeId(id);
  if (!playlistId) throw failure('歌单标识无效。');
  const deadline = musicDeadline(), context = musicContext();
  const state = musicTrackState(context, playlistId, true);
  let interrupted = false;
  while (!state.done && !state.capped) {
    try {
      await musicFetchPage(context, state, '/luna/pc/playlist/detail', { playlist_id: playlistId }, 'media_resources', mapTrack, MUSIC_LIMIT, deadline);
    } catch (error) {
      musicCurrent(context);
      if (error && error.code === 'signIn') throw error;
      if (!state.items.length) throw error;
      interrupted = true;
      break;
    }
  }
  musicCurrent(context);
  const mine = safeId(state.meta && state.meta.owner && state.meta.owner.id) === context.id;
  const result = mapPlaylist(state.meta, mine);
  if (!result) throw failure('汽水没有返回有效的歌单资料。');
  result.tracks = state.items.slice();
  result.trackCount = result.tracks.length;
  if (!state.done || interrupted) {
    const note = state.capped
      ? '当前仅载入前 ' + result.tracks.length + ' 首，已达到此版本 5000 首上限；歌单尚未完整载入。'
      : '当前仅载入 ' + result.tracks.length + ' 首，歌单尚未完整载入；重新打开歌单可继续加载。';
    result.description = (result.description ? result.description + '\n' : '') + note;
  }
  return result;
}

export async function liked({ offset } = {}) {
  const context = musicContext();
  const result = await musicSpecialTracks(context, 1, musicOffset(offset), musicDeadline());
  musicCurrent(context);
  return { tracks: result.tracks, more: result.more };
}

export async function savedAlbums({ offset } = {}) {
  const start = musicOffset(offset), context = musicContext();
  const mixed = await musicLoadMixed(context, musicDeadline());
  musicCurrent(context);
  const albums = mixed.filter(item => item.item_type === 'album').map(item => mapAlbum(item.album)).filter(Boolean);
  for (const album of albums) album.saved = true;
  return { albums: albums.slice(start, start + MUSIC_PAGE), more: albums.length > start + MUSIC_PAGE };
}

export async function home() {
  const deadline = musicDeadline();
  const user = await musicBudget(account(), deadline);
  if (!user) return {
    title: '汽水音乐', subtitle: '登录后查看头像、喜欢的音乐与自己的歌单。',
    sections: [{ title: '账号连接', links: [{ title: '使用说明', subtitle: '在账号菜单登录汽水音乐。', page: 'help' }] }],
  };
  const context = musicContext();
  const recommendations = recommendationSections();
  const [own, mixed] = await Promise.all([musicLoadOwn(context, deadline), musicLoadMixed(context, deadline)]);
  const all = musicPlaylistList(own, mixed);
  const favorites = await musicSpecialTracks(context, 1, 0, deadline);
  musicCurrent(context);
  const sections = [...await musicBudget(recommendations, deadline), { title: '我的汽水音乐', links: [
    { title: '打开音乐库', subtitle: '歌单、喜欢的歌曲与抖音收藏。', page: 'library' },
    { title: '刷新音乐库', subtitle: '同步手机上刚刚修改的收藏。', page: 'library-refresh', reload: true },
  ] }];
  if (all.length) sections.push({ title: '我的歌单', playlists: all.slice(0, 4), morePage: all.length > 4 ? 'library/playlists' : undefined });
  if (favorites.tracks.length) sections.push({ title: '喜欢的音乐', tracks: favorites.tracks.slice(0, 4), morePage: 'library/liked/0' });
  musicCurrent(context);
  return { title: user.name + '的汽水音乐', subtitle: '来自当前汽水账号的音乐库', sections };
}

let appearanceSequence = 0;
function appearancePage(opened = false) {
  const supported = host.platform === 'windows' && host.arch === 'amd64';
  const next = Date.now().toString(36) + '-' + (++appearanceSequence).toString(36);
  return {
    title: '界面增强',
    description: supported
      ? (opened ? '增强管理窗口已打开。请在窗口中查看组件状态；只有确认安装才会关闭并重启 MyGo。' : '增强包已随插件提供，包含听歌模式、插件设置页入口和任务栏播放条。') + '\n支持官方 Windows x64 MyGo 0.1.22 与已验证的旧增强构建。安装后请在“设置 → 插件 → 汽水音乐”中使用“界面增强”，侧栏重复入口会隐藏；原版首次仍从此处启用。安装前请保存设置并暂停播放，原程序和已保存的数据会备份，账号与插件保留。'
      : '此样式安装助手目前仅支持 Windows x64。Mac 可继续使用汽水插件；此处不会修改播放器。',
    sections: supported ? [{ links: [{ title: opened ? '再次打开增强管理' : '打开增强管理', subtitle: '检查版本、确认安装或查看已安装状态。', page: 'appearance/open/' + next, reload: true }] }] : [],
  };
}

async function openAppearanceInstaller() {
  if (host.platform !== 'windows' || host.arch !== 'amd64') return appearancePage();
  const child = spawnHelper('./style-helper.cjs');
  let timer, complete = false;
  try {
    child.write(JSON.stringify({ type: 'open-layout-installer' }) + '\n');
    child.closeStdin();
    const line = await Promise.race([child.readLine(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('增强管理窗口启动超时，请重试。', 'setup')), 30000);
    })]);
    if (typeof line !== 'string' || line.length > 1024) throw failure('增强管理窗口没有返回有效结果，请重新安装 Windows 插件包。', 'setup');
    let value;
    try { value = JSON.parse(line); } catch { throw failure('增强管理窗口没有返回有效结果，请重新安装 Windows 插件包。', 'setup'); }
    if (value.type !== 'ready' || !['ready', 'busy'].includes(value.status)) throw failure('增强管理窗口未能启动，请重新安装完整的 Windows 插件包。', 'setup');
    complete = true;
    return appearancePage(true);
  } finally {
    clearTimeout(timer);
    // The launcher exits on its own; only its detached native dialog stays.
    if (!complete) { try { child.kill(); } catch {} }
  }
}

export async function browse({ page } = {}) {
  if (page === 'appearance') return appearancePage();
  if (/^appearance\/open\/[0-9a-z-]{1,80}$/.test(page || '')) return openAppearanceInstaller();
  if (page === 'listening') {
    const context = musicContext(), catalog = await recommendationService.catalog();
    musicCurrent(context);
    const allModes = [...catalog.primary, ...catalog.scenes];
    const byId = new Map(allModes.map(station => [station.id, station]));
    const commonIds = ['familiar', 'fresh', 'scene:3', 'scene:5', 'scene:2', 'scene:40', 'scene:21', 'scene:18'];
    const common = commonIds.map(id => byId.get(id)).filter(Boolean);
    const commonSet = new Set(common.map(station => station.id));
    const modeButton = station => ({ ...station, iconUrl: stationArtwork(station.id, true) });
    const sections = [];
    if (common.length) sections.push({ title: '常用模式', layout: 'mode-buttons', stations: common.map(modeButton) });
    if (catalog.radios.length) sections.push({ title: '探索更多新模式', layout: 'mode-covers', stations: catalog.radios });
    // Do not discard less common or newly returned modes when arranging
    // the reference layout; they keep their original playback identity.
    const remaining = allModes.filter(station => !commonSet.has(station.id));
    if (remaining.length) sections.push({ title: '更多听歌模式', layout: 'mode-buttons', stations: remaining.map(modeButton) });
    return { title: '听歌模式', sections };
  }
  if (page === 'recommend' || /^recommend\/refresh\/\d{1,16}$/.test(page || '')) {
    const context = musicContext();
    const sections = await recommendationSections({ refresh: page !== 'recommend' });
    musicCurrent(context);
    return { title: '汽水推荐', subtitle: '推荐歌曲与自动续播的听歌模式', sections };
  }
  if (page === 'recommend/scenes' || page === 'recommend/radios' || page === 'recommend/playlists') {
    const context = musicContext(), catalog = await recommendationService.catalog();
    musicCurrent(context);
    if (page === 'recommend/playlists') return { title: '推荐歌单', subtitle: '发现更多适合你的歌单',
      sections: [{ playlists: catalog.playlists }] };
    const scenes = page === 'recommend/scenes';
    return { title: scenes ? '按场景听歌' : '发现电台', subtitle: '选择后自动补充下一批歌曲',
      sections: [{ stations: scenes ? catalog.scenes : catalog.radios }] };
  }
  if (page === 'help') return {
    title: '汽水音乐使用说明', subtitle: '播放和浏览页面只读取汽水资料；点击心形才添加或取消喜欢。歌单与专辑收藏仍为只读。',
    sections: [{ links: [{ title: '打开音乐库', page: 'library' }] }],
  };
  if (page === 'library-refresh') { clearMusicCache(); page = 'library'; }
  const deadline = musicDeadline(), context = musicContext();
  const match = /^library\/(liked|douyin)\/(\d+)$/.exec(page || '');
  if (match) {
    const offset = musicOffset(Number(match[2]));
    const data = await musicSpecialTracks(context, match[1] === 'liked' ? 1 : 4, offset, deadline);
    musicCurrent(context);
    return {
      title: data.name, subtitle: data.tracks.length ? '来自你的汽水账号' : '这个歌单当前没有歌曲。',
      sections: [{ tracks: data.tracks, morePage: data.more ? 'library/' + match[1] + '/' + (offset + data.tracks.length) : undefined,
        links: data.tracks.length ? undefined : [{ title: '返回音乐库', page: 'library' }] }],
    };
  }
  if (page !== 'library' && page !== 'library/playlists') throw failure('这个音乐库页面不存在。');
  const [own, mixed] = await Promise.all([musicLoadOwn(context, deadline), musicLoadMixed(context, deadline)]);
  const all = musicPlaylistList(own, mixed);
  const sections = [];
  const mine = all.filter(item => item.mine), collected = all.filter(item => !item.mine);
  if (mine.length) sections.push({ title: '我的歌单', playlists: mine });
  if (collected.length) sections.push({ title: '收藏的歌单', playlists: collected });
  const albums = mixed.filter(item => item.item_type === 'album').map(item => mapAlbum(item.album)).filter(Boolean);
  if (albums.length) sections.push({ title: '收藏的专辑', albums });
  let hasContent = all.length > 0 || albums.length > 0;
  if (page === 'library') {
    const [favorites, douyin] = await Promise.all([
      musicSpecialTracks(context, 1, 0, deadline), musicSpecialTracks(context, 4, 0, deadline),
    ]);
    hasContent = hasContent || favorites.tracks.length > 0 || douyin.tracks.length > 0;
    if (favorites.tracks.length) sections.push({ title: '喜欢的音乐', tracks: favorites.tracks, morePage: favorites.more ? 'library/liked/' + favorites.tracks.length : undefined });
    if (douyin.tracks.length) sections.push({ title: '抖音收藏', tracks: douyin.tracks, morePage: douyin.more ? 'library/douyin/' + douyin.tracks.length : undefined });
  }
  sections.push({ links: [{ title: '刷新音乐库', page: 'library-refresh', reload: true }] });
  musicCurrent(context);
  return { title: page === 'library' ? '汽水音乐库' : '我的汽水歌单', subtitle: hasContent ? '当前账号的歌单、喜欢和收藏' : '当前账号还没有可显示的音乐收藏。', sections };
}

export async function search({ query, kind = 'tracks', offset = 0 } = {}) {
  const term = typeof query === 'string' ? query.trim().slice(0, 200) : '';
  const start = musicOffset(offset);
  if (!term) return { [kind]: [], more: false };
  const definitions = {
    tracks: { route: 'track', normalize: mapTrack },
    albums: { route: 'album', normalize: item => mapAlbum(item.entity && item.entity.album) },
    artists: { route: 'artist', normalize: item => mapArtist(item.entity && item.entity.artist) },
    playlists: { route: 'playlist', normalize: item => mapPlaylist(item.entity && item.entity.playlist, false) },
  };
  const definition = definitions[kind];
  if (!definition) throw failure('当前汽水暂不支持此类搜索。', 'unsupported');
  const context = musicContext(), key = context.key + ':' + kind + ':' + term;
  let state = searchCache.get(key);
  if (!state || (start === 0 && Date.now() - state.time > MUSIC_CACHE_MS)) {
    if (searchCache.size >= 8) searchCache.delete(searchCache.keys().next().value);
    state = { items: [], ids: new Set(), cursor: '0', cursors: new Set(), done: false, time: Date.now(),
      searchId: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const value = Math.floor(Math.random() * 16); return (c === 'x' ? value : (value & 3) | 8).toString(16);
      }) };
    searchCache.set(key, state);
  }
  const deadline = musicDeadline(), count = 20;
  while (!state.done && state.items.length < start + count) {
    if (state.pending) { await musicBudget(state.pending, deadline); continue; }
    if (state.items.length >= 1000 || state.cursors.size >= 60) throw failure('搜索结果过多，请缩小关键词范围。');
    const cursor = state.cursor;
    const load = (async () => {
    const queryParams = {
      q: term, cursor, search_id: state.searchId, search_method: 'input',
      debug_params: '', from_search_id: '', search_scene: '',
    };
    const result = await musicBudget(kind === 'playlists'
      ? requestMedia('search', { query: term, kind: definition.route, cursor, searchId: state.searchId })
      : musicApi('/luna/search/' + definition.route, queryParams), deadline);
    musicCurrent(context);
    if (!Array.isArray(result.result_groups)) throw failure('汽水搜索返回的数据格式无效。');
    const group = result.result_groups.find(item => item.id === kind);
    if (!group) { state.done = true; return; }
    if (!Array.isArray(group.data)) throw failure('汽水搜索返回的歌曲格式无效。');
    const done = group.has_more !== true;
    if (!done && (typeof group.next_cursor !== 'string' || !group.next_cursor || group.next_cursor === cursor || state.cursors.has(group.next_cursor)))
      throw failure('汽水搜索返回了无效分页游标。');
    for (const item of group.data) {
      const track = definition.normalize(item);
      if (track && !state.ids.has(track.id)) { state.ids.add(track.id); state.items.push(track); }
    }
    state.cursors.add(cursor);
    state.done = done;
    if (!done) state.cursor = group.next_cursor;
    })();
    state.pending = load;
    try { await load; } finally { if (state.pending === load) state.pending = null; }
  }
  musicCurrent(context);
  const tracks = state.items.slice(start, start + count);
  return { [kind]: tracks, more: state.items.length > start + tracks.length || !state.done };
}

// Album and artist drill-down. Uses the shared account-isolated library cache.
function musicEntityId(value) {
  const id = safeId(value);
  if (!/^[1-9]\d{5,24}$/.test(id)) throw failure('汽水没有提供有效的专辑或歌手标识。', 'unsupported');
  return id;
}

function musicUnique(items, normalize) {
  if (items === undefined) return [];
  if (!Array.isArray(items)) throw failure('汽水返回的音乐资料格式无效。');
  const seen = new Set(), result = [];
  for (const item of items) {
    const mapped = normalize(item);
    if (mapped && !seen.has(mapped.id)) { seen.add(mapped.id); result.push(mapped); }
  }
  return result;
}

export async function album({ id } = {}) {
  const albumId = musicEntityId(id), context = musicContext(), deadline = musicDeadline();
  const data = await musicBudget(musicApi('/luna/pc/albums/' + albumId, { ignore_tracks: false }), deadline);
  musicCurrent(context);
  const detail = mapAlbum(data.album_info);
  if (!detail || detail.id !== albumId) throw failure('汽水没有返回这张专辑的有效资料。');
  if (data.has_more === true || (Array.isArray(data.tracks) && data.tracks.length > MUSIC_LIMIT))
    throw failure('汽水未在此接口返回可完整显示的专辑曲目，暂时无法打开。');
  return { album: detail, tracks: musicUnique(data.tracks, mapTrack) };
}

function musicArtistDetailState(context, id) {
  if (!context.details) context.details = new Map();
  let state = context.details.get(id);
  if (!state || (state.tracks.done && state.albums.done && Date.now() - state.time > MUSIC_CACHE_MS)) {
    if (!state && context.details.size >= 8) {
      const oldest = [...context.details.entries()].filter(entry => !entry[1].tracks.pending && !entry[1].albums.pending)
        .sort((a, b) => a[1].time - b[1].time)[0];
      if (oldest) context.details.delete(oldest[0]);
    }
    state = { info: null, tracks: musicState(), albums: musicState(), time: Date.now() };
    context.details.set(id, state);
  }
  return state;
}

export async function artist({ id } = {}) {
  const requested = safeId(id), context = musicContext(), deadline = musicDeadline();
  if (requested.startsWith('user:')) {
    const userId = musicEntityId(requested.slice(5));
    const data = await musicBudget(musicApi('/luna/pc/users/' + userId, { user_id: userId, sec_uid: '' }), deadline);
    musicCurrent(context);
    if (!data.user || safeId(data.user.id) !== userId) throw failure('汽水没有返回这位上传者的有效资料。');
    const detail = mapArtist({ user_info: data.user });
    if (!detail) throw failure('这位上传者的资料暂不可用。');
    detail.id = requested;
    // A user profile is not an artist catalogue. Do not invent artist tracks.
    return { artist: detail, tracks: [], albums: [] };
  }
  const artistId = musicEntityId(requested);
  const state = musicArtistDetailState(context, artistId);
  if (!state.info) {
    const data = await musicBudget(musicApi('/luna/pc/artists/' + artistId, { locate_item_id: '' }), deadline);
    musicCurrent(context);
    const info = mapArtist(data.artist_info);
    if (!info || info.id !== artistId) throw failure('汽水没有返回这位歌手的有效资料。');
    state.info = info;
  }
  async function allPages(list, suffix, field, normalize, maximum) {
    while (!list.done && !list.capped)
      await musicFetchPage(context, list, '/luna/pc/artists/' + artistId + suffix, {}, field, normalize, maximum, deadline);
    if (list.capped) throw failure('这位歌手的作品超过当前版本的载入上限，未能加载完整资料。');
  }
  await Promise.all([
    allPages(state.tracks, '/tracks', 'tracks', mapTrack, MUSIC_LIMIT),
    allPages(state.albums, '/albums', 'albums', mapAlbum, MUSIC_LIST_LIMIT),
  ]);
  musicCurrent(context);
  state.time = Date.now();
  return { artist: state.info, tracks: state.tracks.items.slice(), albums: state.albums.items.slice() };
}

// BEGIN QISHUI RECOMMENDATION SERVICE
// Read-only Qishui recommendations for MyGo stations()/stationNext({id}).
// Source: Soda Music 3.7.0 public source maps, feed.ts/feedmode.ts/radio.ts.
// Assisted-by: Cindy (https://cindy.app)
// Integration: createRecommendationService({api:musicApi, mapTrack, mapPlaylist,
//   imageURL, contextKey:()=>musicContext().key, failure}).
// Export service.stations / service.stationNext; use service.catalog for home.
function createRecommendationService(deps) {
  const { api, mapTrack, imageURL, contextKey } = deps;
  const now = deps.now || (() => Date.now());
  const fail = deps.failure || (message => new Error(message));
  const CACHE_MS = 10 * 60 * 1000;
  const MAX_SEEN = 1000;
  let current;
  const text = value => typeof value === 'string' ? value.trim() : '';
  const idString = value => typeof value === 'string' ? value.trim()
    : Number.isSafeInteger(value) ? String(value) : '';

  function context() {
    const key = contextKey(); // Must reject if not signed in.
    if (!current || current.key !== key) current = {
      key, catalog: null, catalogAt: 0, loading: null, discovered: false,
      descriptors: new Map(), states: new Map(),
    };
    return current;
  }
  function assertCurrent(ctx) {
    if (current !== ctx || contextKey() !== ctx.key)
      throw fail('账号已变化，请重新打开推荐。');
  }
  function card(id, name, description, artwork) {
    const result = {id, name};
    if (description) result.description = description;
    // Scene URLInfo is a small white UI glyph, not an album cover. A JPEG
    // crop from that endpoint is solid white; use bundled, opaque cards.
    const cover = deps.stationArtwork?.(id) || imageURL(artwork);
    if (cover) result.imageUrl = cover;
    return result;
  }
  function register(ctx, descriptor, target, seen) {
    if (!descriptor?.card?.id || !descriptor.card.name || seen.has(descriptor.card.id)) return;
    seen.add(descriptor.card.id);
    ctx.descriptors.set(descriptor.card.id, descriptor);
    target.push(descriptor.card);
  }
  function copyCatalog(value) {
    return {title:value.title, primary:value.primary.map(v=>({...v})), scenes:value.scenes.map(v=>({...v})),
      radios:value.radios.map(v=>({...v})), playlists:value.playlists.map(v=>({...v}))};
  }
  function baseCatalog(ctx) {
    const result = {title:'为你推荐', primary:[], scenes:[], radios:[], playlists:[]};
    const seen = new Set();
    for (const [id, name, description, preference] of [
      ['recommend', '个性推荐', '懂你口味，连续推荐', null],
      ['familiar', '熟悉模式', '重逢熟悉的好音乐', {preference_mode:'familiar'}],
      ['fresh', '新鲜模式', '发现没听过的好歌', {preference_mode:'fresh'}],
    ]) register(ctx, {kind:'feed', preference, card:card(id,name,description)}, result.primary, seen);
    return {result, seen};
  }
  async function loadCatalog(ctx) {
    if (ctx.catalog && now() - ctx.catalogAt < CACHE_MS) return ctx.catalog;
    if (ctx.loading) return ctx.loading;
    const load = (async () => {
      const [modes, discover] = await Promise.all([
        api('/luna/pc/feed/mode', {}, {}),
        api('/luna/pc/discover', {}, {first_request:!ctx.discovered,pc_new_discover_request:true}),
      ]);
      assertCurrent(ctx);
      if (!Array.isArray(modes?.feed_mode_block) || !Array.isArray(discover?.blocks))
        throw fail('汽水返回的听歌模式格式无效，请稍后刷新。');
      const {result, seen} = baseCatalog(ctx);
      for (const block of modes.feed_mode_block) {
        for (const mode of Array.isArray(block?.feed_mode) ? block.feed_mode : []) {
          const scene = mode?.entity?.feed_scene_mode;
          if (mode?.type !== 'scene_mode' || !Number.isSafeInteger(scene?.scene_mode_id) || scene.scene_mode_id < 0) continue;
          const id = 'scene:' + scene.scene_mode_id;
          register(ctx, {kind:'feed', preference:{scene_mode_id:scene.scene_mode_id},
            card:card(id,text(mode.text),'',mode.url_info)}, result.scenes, seen);
        }
      }
      for (const block of discover.blocks) {
        if (block?.type !== 'discover_playlist_mix' && block?.type !== 'discover_feed_playlist') continue;
        if (text(block.title)) result.title = text(block.title);
        for (const inner of Array.isArray(block.inner_block) ? block.inner_block : []) {
          for (const resource of Array.isArray(inner?.resources) ? inner.resources : []) {
            if (resource?.type === 'playlist') {
              const style = resource.style || {};
              const raw = resource.entity?.playlist || {id:resource.resource_id,title:style.title,
                description:style.desc,url_cover:style.cover_url_list?.[0]};
              const playlist = deps.mapPlaylist?.(raw, false);
              if (playlist && !seen.has('playlist:' + playlist.id)) {
                seen.add('playlist:' + playlist.id);
                result.playlists.push(playlist);
              }
              continue;
            }
            if (resource?.type !== 'radio') continue;
            const radioId = idString(resource.resource_id);
            if (!radioId || radioId.length > 256 || /[\u0000-\u001f\u007f]/.test(radioId)) continue;
            const style = resource.style || {};
            // Read parameters from a first-party internal link; never navigate it.
            let flowType = 2, triggerInfo = '';
            try {
              const link = new URL(style.link);
              if (link.protocol === 'luna:') {
                const rawFlow = link.searchParams.get('flow_type');
                if (rawFlow && /^\d{1,2}$/.test(rawFlow)) flowType = Number(rawFlow);
                triggerInfo = (link.searchParams.get('trigger_info') || '').slice(0,2048);
              }
            } catch (_) {}
            register(ctx, {kind:'radio', radioId, flowType, triggerInfo,
              card:card('radio:' + radioId,text(style.title)||text(inner.title),text(style.desc),style.cover_url_list?.[0])}, result.radios, seen);
          }
        }
      }
      // Keep descriptors used by an active queue even if a refreshed catalog changes.
      for (const id of ctx.descriptors.keys()) {
        if (ctx.descriptors.size <= 256) break;
        if (!seen.has(id) && !ctx.states.has(id)) ctx.descriptors.delete(id);
      }
      ctx.catalog = result;
      ctx.catalogAt = now();
      ctx.discovered = true;
      return result;
    })();
    ctx.loading = load;
    try {return await load} finally {if (ctx.loading === load) ctx.loading = null;}
  }
  async function catalog() {
    const ctx = context();
    const value = await loadCatalog(ctx);
    assertCurrent(ctx);
    return copyCatalog(value);
  }
  async function stations() {
    const value = await catalog();
    return [...value.primary, ...value.scenes, ...value.radios];
  }
  function stateFor(ctx, id) {
    let state = ctx.states.get(id);
    if (!state) {
      if (ctx.states.size >= 12) {
        const idle = [...ctx.states.entries()].filter(([,v])=>!v.pending).sort((a,b)=>a[1].at-b[1].at)[0];
        if (idle) ctx.states.delete(idle[0]);
      }
      state = {requests:0,cursor:'',done:false,seen:new Set(),pending:null,at:now()};
      ctx.states.set(id,state);
    }
    return state;
  }
  async function fetchNext(ctx, descriptor, state) {
    assertCurrent(ctx);
    if (state.done) return [];
    state.at = now();
    let body, route;
    if (descriptor.kind === 'radio') {
      route = '/luna/pc/feed/radio/tracks';
      body = {radio_id:descriptor.radioId,cursor:state.cursor,flow_type:descriptor.flowType,trigger_info:descriptor.triggerInfo};
    } else {
      route = '/luna/pc/feed/song-tab';
      body = {is_first_request:state.requests===0,is_did_first_request:false,feed_counts:{mix_session_count:state.requests}};
      if (descriptor.preference) body.feed_preference = {...descriptor.preference};
    }
    // No played_media, invented play counts, collection writes, or listening reports.
    const response = await api(route, {}, body);
    assertCurrent(ctx);
    if (!Array.isArray(response?.items)) throw fail('汽水返回的推荐歌曲格式无效，请稍后重试。');
    if (descriptor.kind === 'radio' && response.has_more === true
        && (typeof response.next_cursor !== 'string' || !response.next_cursor || response.next_cursor === state.cursor))
      throw fail('汽水电台的下一页信息无效，请重新打开电台。');
    const tracks = [];
    for (const item of response.items) {
      if (item?.type !== 'track') continue;
      const raw = item.entity?.track_wrapper?.track || item.entity?.track;
      if (!raw || (raw.media_type && !['track','ugc_clip'].includes(raw.media_type))) continue;
      const track = mapTrack(item);
      if (!track?.id || track.unavailable || state.seen.has(track.id)) continue;
      state.seen.add(track.id);
      tracks.push(track);
    }
    while (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.values().next().value);
    if (descriptor.kind === 'radio' && typeof response.next_cursor === 'string') state.cursor = response.next_cursor;
    state.done = response.has_more === false;
    state.requests++;
    return tracks;
  }
  async function stationNext({id} = {}) {
    if (typeof id !== 'string' || !id) throw fail('请选择要播放的汽水电台。');
    const ctx = context();
    if (!ctx.descriptors.has('recommend')) baseCatalog(ctx);
    if (!ctx.descriptors.has(id)) await loadCatalog(ctx);
    assertCurrent(ctx);
    const descriptor = ctx.descriptors.get(id);
    if (!descriptor) throw fail('此汽水电台已更新，请重新打开听歌模式。');
    const state = stateFor(ctx,id);
    // Serialize same-station requests: simultaneous host calls must not repeat a batch.
    const load = Promise.resolve(state.pending).catch(()=>{}).then(()=>fetchNext(ctx,descriptor,state));
    state.pending = load;
    try {return await load} finally {if (state.pending === load) state.pending = null;}
  }
  return {catalog,stations,stationNext,reset(){current = null;}};
}
// END QISHUI RECOMMENDATION SERVICE

// BEGIN QISHUI LIKES SERVICE
// Qishui likes: isLiked is read-only; like writes only when the host calls it
// in response to the listener pressing the heart or its keyboard shortcut.
// Source: Soda Music 3.7.0 app.asar main.js.map collect.ts and contract/me.ts.
// Assisted-by: Cindy (https://cindy.app)
// Integrate with createLikesService({api:(...a)=>musicApi(...a),
//   contextKey:()=>musicContext().key, onChanged:invalidateLikedCaches, failure}).
// Export service.isLiked and service.like. No read path invokes service.like.
function createLikesService(deps) {
  const {api,contextKey}=deps;
  const fail=deps.failure||((message,code)=>Object.assign(new Error(message),code?{code}:{}));
  const pause=deps.pause||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  let current;
  function identity(value) {
    if(typeof value!=='string')throw fail('歌曲标识无效。','unavailable');
    const match=/^(?:(ugc_clip):)?([1-9]\d{0,31})$/.exec(value);
    if(!match)throw fail('这类作品暂不支持修改喜欢状态。','unsupported');
    return{hostId:value,id:match[2],type:match[1]||'track'};
  }
  function context() {
    const key=contextKey(); // Throws if the account is no longer signed in.
    if(!current||current.key!==key)current={key,writes:new Map(),revisions:new Map()};
    return current;
  }
  function assertCurrent(ctx) {
    if(current!==ctx||contextKey()!==ctx.key)throw fail('账号已变化，请重新查看喜欢状态。');
  }
  function checkResponse(response,requireAck=false) {
    if(!response||typeof response!=='object'||Array.isArray(response))throw fail('汽水未返回有效的喜欢状态。');
    const values=[response.status_code,response.status_info?.code,response.status_info?.status_code]
      .filter(v=>v!==undefined&&v!==null&&v!=='');
    const bad=values.find(v=>!Number.isFinite(Number(v))||Number(v)!==0);
    if(bad!==undefined) {
      const code=/^\d{1,9}$/.test(String(bad))?String(Number(bad)):'unknown';
      // Official 1000057 is a temporary optimistic display, not confirmed success.
      throw fail('汽水未确认此喜欢操作（'+code+'），请稍后重试。',code==='1000016'?'signIn':undefined);
    }
    if(requireAck&&!values.length&&!(typeof response.status_info?.log_id==='string'&&response.status_info.log_id)
        &&!Array.isArray(response.collected_media)&&!Array.isArray(response.deleted_media))
      throw fail('汽水未确认喜欢操作，请稍后刷新状态。');
  }
  function revision(ctx,id) {return ctx.revisions.get(id)||0;}
  async function readState(ctx,media) {
    const result={};
    for(let offset=0;offset<media.length;offset+=50) {
      const batch=media.slice(offset,offset+50);
      assertCurrent(ctx);
      const response=await api('/luna/media',{},{scene:'playlist',media:batch.map(({id,type})=>({id,type}))});
      assertCurrent(ctx);
      checkResponse(response);
      if(!Array.isArray(response.media))throw fail('汽水未返回有效的歌曲喜欢状态。');
      const requested=new Map(batch.map(item=>[item.type+':'+item.id,item.hostId]));
      for(const item of response.media) {
        const raw=item?.entity?.track_wrapper?.track||item?.entity?.track;
        if(!raw||typeof raw.id!=='string'||!raw.state||typeof raw.state!=='object'||Array.isArray(raw.state))continue;
        const collected=raw.state.is_collected;
        if(collected!==undefined&&collected!==null&&typeof collected!=='boolean')continue;
        const type=typeof raw.media_type==='string'?raw.media_type:item.type;
        const hostId=requested.get(type+':'+raw.id);
        // The server emits state:{} for an unliked track. The official PC
        // queue and bottom player both use state?.is_collected ?? false.
        if(hostId)result[hostId]=collected??false;
      }
      if(batch.some(item=>!Object.prototype.hasOwnProperty.call(result,item.hostId)))
        throw fail('汽水未确认部分歌曲的喜欢状态，请稍后重试。');
    }
    return result;
  }
  async function isLiked({ids}={}) {
    if(!Array.isArray(ids)||ids.length>200)throw fail('需要查询的歌曲数量无效。');
    const media=[...new Set(ids)].map(identity);
    const ctx=context();
    if(!media.length)return{};
    // A concurrent click must not be overwritten by an earlier read response.
    for(let attempt=0;attempt<2;attempt++) {
      const pending=media.map(item=>ctx.writes.get(item.hostId)).filter(Boolean);
      if(pending.length)await Promise.allSettled(pending);
      assertCurrent(ctx);
      const versions=media.map(item=>revision(ctx,item.hostId));
      const result=await readState(ctx,media);
      assertCurrent(ctx);
      if(media.every((item,index)=>revision(ctx,item.hostId)===versions[index]))return result;
    }
    throw fail('喜欢状态正在更新，请稍后重试。');
  }
  async function like({id,on}={}) {
    if(typeof on!=='boolean')throw fail('喜欢操作必须明确指定添加或取消。');
    const media=identity(id),ctx=context();
    const previous=ctx.writes.get(id);
    ctx.revisions.set(id,revision(ctx,id)+1);
    const work=Promise.resolve(previous).catch(()=>{}).then(async()=>{
      assertCurrent(ctx);
      const route=on?'/luna/pc/me/collection/media':'/luna/pc/me/collection/media/delete';
      const body={media:[{id:media.id,type:media.type}]};
      if(on)body.scene=''; // Exact current official PC service request shape.
      const response=await api(route,{},body);
      assertCurrent(ctx);
      checkResponse(response,true);
      let confirmed=false;
      for(let attempt=0;attempt<2;attempt++) {
        try {
          const state=await readState(ctx,[media]);
          confirmed=state[id]===on;
        } catch (_) {assertCurrent(ctx);}
        if(confirmed)break;
        if(attempt===0){await pause(250);assertCurrent(ctx);}
      }
      assertCurrent(ctx);
      if(!confirmed)throw fail('汽水暂未确认喜欢状态已更新，请稍后刷新。');
      // Synchronous cache invalidation only; no automatic follow-up writes.
      if(typeof deps.onChanged==='function')deps.onChanged();
    });
    ctx.writes.set(id,work);
    try {await work} finally {
      if(ctx.writes.get(id)===work)ctx.writes.delete(id);
      // Bound bookkeeping for long sessions without discarding an active write.
      if(ctx.revisions.size>1000)for(const key of ctx.revisions.keys()) {
        if(ctx.revisions.size<=1000)break;
        if(!ctx.writes.has(key))ctx.revisions.delete(key);
      }
    }
  }
  return{isLiked,like};
}
// END QISHUI LIKES SERVICE
