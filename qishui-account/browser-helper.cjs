'use strict';
// Independent MyGo login bridge. Assisted-by: Cindy (https://cindy.app)
// Only a fresh temporary browser profile is used. stdout is a private JSON pipe.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const readline = require('node:readline');
const { ensureDevice } = require('./device.cjs');
const { prepareSdk } = require('./native-sdk.cjs');
const { browserPath, scanLabel, deviceName } = require('./local-env.cjs');

const ORIGIN = 'https://api.qishui.com';
const GLUE = 'https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/glue/1.0.0.36/sdk-glue.js';
const probe = process.argv.includes('--probe');
const secrets = new Set();
let child, profile, session, targetId, windowId, preparing, dataDir, closing = false, stage = '初始化浏览器';
let verificationMs = 0, cleanupTask;
const sdkController = new AbortController();
let seq = 0, incoming = '', pending = new Map();
const securityFields = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = item => process.stdout.write(JSON.stringify(item) + '\n');

function safeDescription(value) {
  let text = typeof value === 'string' ? value : '登录未能完成';
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[已隐藏]').split(encodeURIComponent(secret)).join('[已隐藏]');
  }
  return text.replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/[A-Za-z0-9_+/=%.-]{12,}/g, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180);
}
function rememberSensitive(value, sensitive = false, depth = 0) {
  if (!value || depth > 8) return;
  if (typeof value === 'string') {
    if (sensitive) {
      secrets.add(value);
      for (const part of value.split(';')) {
        const index = part.indexOf('=');
        if (index >= 0 && part.slice(index + 1).trim()) secrets.add(part.slice(index + 1).trim());
      }
    }
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) rememberSensitive(item,
      sensitive || /cookie|session|token|secret|auth|password|(^|_)sid|(^|_)uid|user_id|phone|email/i.test(key), depth + 1);
  }
}
function fail(message, code = 'unknown') {
  const error = new Error(message);
  error.code = /^\d{1,9}$/.test(String(code)) ? String(Number(code)) : 'unknown';
  return error;
}
function checked(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('接口未返回有效数据');
  rememberSensitive(value);
  const nested = value.data && typeof value.data === 'object' ? value.data : {};
  const codes = [value.error_code, value.status_code, nested.error_code].filter(x => x !== undefined && x !== null && x !== '');
  const bad = codes.find(x => !Number.isFinite(Number(x)) || Number(x) !== 0);
  if (bad !== undefined || (value.message && value.message !== 'success')) {
    throw fail(nested.description || value.description || '平台未提供具体原因', bad);
  }
  return value;
}

function command(method, params = {}, target = session, timeout = 20000) {
  if (closing || !child || child.exitCode !== null) return Promise.reject(fail('登录浏览器已关闭'));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(fail('浏览器操作超时')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }) + '\0', error => {
      if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(fail('无法连接登录浏览器')); }
    });
  });
}
function receive(buffer) {
  incoming += buffer.toString('utf8');
  let end;
  while ((end = incoming.indexOf('\0')) >= 0) {
    const raw = incoming.slice(0, end); incoming = incoming.slice(end + 1);
    let message;
    try { message = JSON.parse(raw); } catch { continue; }
    if (message.id && pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(fail('浏览器通信失败')); else p.resolve(message.result);
    } else if (message.method === 'Network.requestWillBeSent') {
      const request = message.params?.request;
      try {
        const url = new URL(request.url);
        if (url.origin === ORIGIN && url.pathname.startsWith('/passport/')) {
          for (const key of url.searchParams.keys()) if (/bogus|gnarly|signature|mstoken/i.test(key)) securityFields.add(key);
          for (const key of Object.keys(request.headers || {})) if (/bogus|gnarly|signature/i.test(key)) securityFields.add(key);
        }
      } catch {}
    }
  }
}
async function evaluate(expression, timeout = 20000) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session, timeout);
  if (response.exceptionDetails) throw fail('登录页面执行失败');
  return response.result?.value;
}
async function cookies() {
  const result = await command('Network.getCookies', { urls: [ORIGIN + '/', ORIGIN + '/passport/web/check_qrconnect/'] });
  const items = (result.cookies || []).filter(c => ['api.qishui.com', 'qishui.com'].includes(c.domain.replace(/^\./, '')));
  for (const c of items) secrets.add(c.value);
  return items.map(c => ({ name: c.name, value: c.value, path: c.path, expires: c.expires > 0 ? c.expires * 1000 : 0 }));
}
function cleanup() {
  if (cleanupTask) return cleanupTask;
  closing = true;
  cleanupTask = (async () => {
    sdkController.abort();
    if (preparing) { try { await preparing; } catch {} }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fail('登录已取消')); }
    pending.clear();
    // Closing the inherited debugging pipe also closes this isolated browser.
    if (child) {
      child.stdio[3].end();
      if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
      if (child.exitCode === null) child.kill();
    }
    if (profile) {
      const resolved = path.resolve(profile), base = path.resolve(os.tmpdir());
      if (path.dirname(resolved) === base && path.basename(resolved).startsWith('mygo-qishui-login-')) {
        try { await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
      }
    }
  })();
  return cleanupTask;
}
async function startBrowser() {
  const executable = browserPath();
  if (!executable) throw fail(process.platform === 'darwin' ? '未找到 Google Chrome 或 Microsoft Edge' : '未找到 Microsoft Edge 或 Chrome');
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mygo-qishui-login-'));
  // macOS: keep the throwaway profile away from the login keychain prompt.
  const platformFlags = process.platform === 'darwin' ? ['--use-mock-keychain', '--password-store=basic'] : [];
  child = spawn(executable, [...(probe ? ['--headless=new'] : ['--window-size=600,760']), '--remote-debugging-pipe', '--no-first-run',
    '--no-default-browser-check', ...platformFlags, '--user-data-dir=' + profile, 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', receive);
  child.stdio[3].on('error', () => {});
  child.on('error', () => { for (const p of pending.values()) p.reject(fail('无法启动登录浏览器')); });
  child.on('exit', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fail('登录浏览器已退出')); }
    pending.clear();
  });
  const targets = await command('Target.getTargets', {}, null);
  const target = targets.targetInfos?.find(item => item.type === 'page' && item.url === 'about:blank')
    || await command('Target.createTarget', { url: 'about:blank' }, null);
  targetId = target.targetId;
  const attached = await command('Target.attachToTarget', { targetId, flatten: true }, null);
  session = attached.sessionId;
  if (!probe) {
    const window = await command('Browser.getWindowForTarget', { targetId }, null);
    windowId = window.windowId;
    await command('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }, null);
  }
  await command('Page.enable');
  await command('Network.enable');
  await command('Page.navigate', { url: ORIGIN + '/' });
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const state = await evaluate('({origin:location.origin, ready:document.readyState})');
    if (state?.origin === ORIGIN && state.ready === 'complete') break;
    await sleep(100);
  }
  const frame = await command('Page.getFrameTree');
  if (frame.frameTree.frame.securityOrigin !== ORIGIN) throw fail('登录页面来源不符合预期');
  await evaluate(fs.readFileSync(path.join(__dirname, 'browser-info.js'), 'utf8'));
  await evaluate(fs.readFileSync(path.join(__dirname, 'browser-verification.js'), 'utf8'));
  if (!probe) await evaluate(`document.title='MyGo 汽水音乐登录';document.body.textContent='请回到 MyGo 使用汽水音乐 App 扫码。如平台要求额外安全验证，本窗口会显示官方验证界面。';`);
  stage = '加载官方登录 SDK';
  const sdk = await evaluate(`(async()=>{
    const script=document.createElement('script'); script.src=${JSON.stringify(GLUE)};
    await Promise.race([new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=reject;document.head.appendChild(script)}),new Promise((_,reject)=>setTimeout(reject,12000))]);
    window._SdkGlueInit({self:{aid:386088,pageId:24554},bdms:{aid:386088,paths:['/passport']}});
    const deadline=Date.now()+15000;
    while(!(typeof window.bdms?.init==='function'&&!window._SdkGlueLoadingMap?.bdms)){
      if(Date.now()>deadline)throw new Error('SDK timeout');await new Promise(r=>setTimeout(r,50));
    }
    window.__mygoSourceInfo=await window.__mygoCollectBrowserInfo();
    return {bdms:window._sdkGlueVersionMap?.bdmsVersion||'0',ready:typeof window.__mygoSourceInfo==='string'};
  })()`, 35000);
  if (!sdk?.ready || sdk.bdms === '0') throw fail('官方登录 SDK 未完成初始化');
  return sdk;
}

async function request(endpoint, body, options = {}) {
  if (!endpoint.startsWith('/') || endpoint.startsWith('//')) throw fail('接口路径无效');
  const config = { endpoint, body, ...options };
  const result = await evaluate(`(async (config)=>{
    if(location.origin!==${JSON.stringify(ORIGIN)})throw new Error('Unexpected origin');
    const url=new URL(config.endpoint,location.origin);
    const headers={Accept:'application/json, text/javascript'};
    if(url.pathname.startsWith('/passport/')){
      const extra={p_zt:window.$SECURE_VERSION||'0',p_bd:window._sdkGlueVersionMap?.bdmsVersion||'0',request_host:encodeURIComponent(location.origin),account_sdk_source_info:window.__mygoSourceInfo};
      for(const [k,v] of Object.entries(extra))url.searchParams.set(k,v);
      const match=/(?:^|; )passport_csrf_token=([^;]+)/.exec(document.cookie)||/(?:^|; )passport_csrf_token_default=([^;]+)/.exec(document.cookie);
      if(match)headers['x-tt-passport-csrf-token']=match[1];
      headers['x-tt-passport-verify-portrait']=config.portrait;
      headers['x-tt-passport-trace-id']=config.trace;
    }
    if(config.body!==undefined)headers['Content-Type']=config.json?'application/json':'application/x-www-form-urlencoded';
    const response=await window.fetch(url.href,{method:config.body===undefined?'GET':'POST',headers,body:config.body,credentials:'include',redirect:'error',signal:AbortSignal.timeout(12000)});
    const text=await response.text();let data;try{data=JSON.parse(text)}catch{return {http:response.status,invalid:true}};
    return {http:response.status,data};
  })(${JSON.stringify(config)})`);
  if (!result || result.http < 200 || result.http >= 300) throw fail('汽水接口暂时不可用（HTTP ' + (result?.http || 'unknown') + '）');
  if (result.invalid) throw fail('汽水接口未返回有效数据');
  rememberSensitive(result.data);
  return result.data;
}
function challengeFor(value) {
  if (!value || typeof value !== 'object') return null;
  const nested = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : {};
  const error = [nested, value].find(item => Number(item.error_code) === 2046 && typeof item.url === 'string');
  if (error) return { kind: 'modern', decision: error, body: error.biz_params };
  const raw = nested.verify_center_decision_conf || nested.verify_center_secondary_decision_conf
    || value.verify_center_decision_conf || value.verify_center_secondary_decision_conf;
  if (typeof raw !== 'string' || raw.length > 131072) return null;
  let decision;
  try { decision = JSON.parse(raw); } catch { return null; }
  if (!decision || typeof decision !== 'object' || ![10000, 20000].includes(Number(decision.code))) return null;
  const sms = nested.sms_code_key || value.sms_code_key;
  return { kind: 'legacy', decision, ...(Number(nested.error_code || value.error_code) === 2046 && typeof sms === 'string' ? { body: { sms_code_key: sms } } : {}) };
}
async function completeVerification(challenge, device, portrait) {
  if (probe) throw fail('汽水要求额外安全验证，请在 MyGo 发起交互式登录。', '2046');
  const began = Date.now(), previous = stage;
  stage = '额外安全验证';
  emit({ type: 'verification' });
  try {
    await command('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, null);
    await command('Target.activateTarget', { targetId }, null);
    await evaluate(`window.__mygoVerify(${JSON.stringify({ kind: challenge.kind, decision: challenge.decision, device, portrait })});true`);
    const deadline = Date.now() + 185000;
    while (!closing && Date.now() < deadline) {
      const state = await evaluate('window.__mygoVerificationState');
      if (state?.status === 'success') return state;
      if (state?.status === 'cancelled') throw fail('已关闭汽水安全验证，尚未登录成功。', '2046');
      if (state?.status === 'timeout') throw fail('汽水安全验证已超时，请重新登录。', '2046');
      if (state?.status === 'unsupported') throw fail('汽水返回的验证入口暂不受支持，尚未登录成功。', '2046');
      if (state?.status === 'loadFailed') throw fail('汽水官方验证界面未能加载，请检查网络后重新登录。', '2046');
      await sleep(250);
    }
    throw fail('汽水安全验证已取消或超时，尚未登录成功。', '2046');
  } finally { verificationMs += Date.now() - began; stage = previous; }
}
async function verifiedRequest(endpoint, body, options, device) {
  const result = await request(endpoint, body, options);
  const challenge = challengeFor(result);
  if (!challenge) {
    if (Number(result?.data?.error_code || result?.error_code) === 2046) throw fail('汽水要求额外安全验证，但未返回可打开的验证入口，本次登录无法继续。', '2046');
    return checked(result);
  }
  const completed = await completeVerification(challenge, device, options.portrait);
  const url = new URL(endpoint, ORIGIN);
  url.searchParams.set('isResend', 'true');
  if (typeof completed.fp === 'string' && completed.fp) {
    url.searchParams.set('fp', completed.fp); url.searchParams.set('verifyFp', completed.fp);
  }
  let resendBody = body;
  if (challenge.body && typeof challenge.body === 'object' && !Array.isArray(challenge.body)) {
    const fields = body === undefined ? url.searchParams : new URLSearchParams(body);
    for (const [key, value] of Object.entries(challenge.body)) fields.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    if (body !== undefined) resendBody = fields.toString();
  }
  // One successful official verification resumes exactly this QR request.
  // A repeated challenge remains an error; never create an endless rescan loop.
  const resumed = await request(url.pathname + url.search, resendBody, options);
  if (challengeFor(resumed)) throw fail('验证完成后汽水仍要求额外验证，本次登录未完成。请稍后重新登录。', '2046');
  return checked(resumed);
}
async function initializeTtwid() {
  stage = '初始化登录设备';
  const options = { aid: 386088, service: 'api.qishui.com', host: ORIGIN, unionHost: '', union: false, needFid: false };
  const check = await request('/ttwid/check/', JSON.stringify({ ...options, fid: '', migrate_priority: 0 }), { json: true });
  const code = Number(check.status_code);
  if (!Number.isFinite(code)) throw fail('设备初始化响应无效');
  if (code > 1001) {
    const registered = await request('/ttwid/register/', JSON.stringify({ ...options, migrate_info: check.migrate_info, fid: '' }), { json: true });
    if (Number(registered.status_code) !== 0) throw fail('登录设备注册失败', registered.status_code);
  }
  if (!(await cookies()).some(c => c.name === 'ttwid' && c.value)) throw fail('未取得登录设备 Cookie');
}

async function login(existing) {
  stage = '注册插件设备';
  const device = await ensureDevice(existing);
  secrets.add(device.did); secrets.add(device.iid); secrets.add(device.serial); secrets.add(device.cdid);
  if (!probe) emit({ type: 'device', device });
  const sdk = await startBrowser();
  await initializeTtwid();
  const trace = randomBytes(4).toString('hex'), portrait = randomUUID() + '.login';
  secrets.add(trace); secrets.add(portrait);
  await evaluate(`document.cookie=${JSON.stringify('biz_trace_id=' + trace + ';path=/;domain=qishui.com;Secure;SameSite=Lax')}`);
  const params = new URLSearchParams({ passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal',
    is_from_ttaccountsdk: '1', aid: '386088', p_js_v: '2.4.13', p_js_t: 'pro', p_ver: '1.0.29',
    account_sdk_source: 'web', language: 'zh', biz_trace_id: trace,
    device_id: device.did, install_id: device.iid, did: device.did, iid: device.iid,
    device_platform: 'PC', version_code: device.clientVersion });
  const flow = { trace, portrait };
  stage = '获取二维码';
  const created = await verifiedRequest('/passport/web/get_qrcode/?' + params + '&next=https%3A%2F%2Fapi.qishui.com&need_logo=false&need_short_url=false&is_new_login=1', undefined, flow, device);
  const data = created.data || {};
  if (typeof data.token !== 'string' || !data.token || typeof data.qrcode_index_url !== 'string') throw fail('汽水未能生成二维码');
  secrets.add(data.token);
  const original = new URL(data.qrcode_index_url);
  if (original.protocol !== 'https:' || original.hostname !== 'bff-pc.qishui.com' || original.username || original.password || original.searchParams.getAll('token').length !== 1 || original.searchParams.get('token') !== data.token) throw fail('二维码来源或会话不符合预期');
  const qr = new URL('https://bff-pc.qishui.com/light/invoke/scan_login');
  qr.searchParams.set('token', data.token); qr.searchParams.set('os', scanLabel()); qr.searchParams.set('computer_name', deviceName());
  const qrURL = qr.href.replace(/\+/g, '%20');
  if (!probe) emit({ type: 'qr', url: qrURL, status: 'new' });
  const body = new URLSearchParams({ need_logo: 'false', need_short_url: 'false', is_frontier: 'true',
    token: data.token, is_new_login: '1', next: ORIGIN }).toString();
  let deadline = Date.now() + 150000;
  while (!closing && Date.now() < deadline) {
    await sleep(2000);
    stage = '扫码确认';
    const paused = verificationMs;
    const result = await verifiedRequest('/passport/web/check_qrconnect/?' + params + '&is_new_login=1', body, flow, device);
    deadline += verificationMs - paused;
    const state = result.data || {}, status = String(state.status || '');
    if (probe) { emit({ type: 'probe', sdkReady: sdk.ready, bdms: sdk.bdms, deviceRegistered: true,
      ttwid: (await cookies()).some(c => c.name === 'ttwid'), qrReady: true, computerNameMatchesSystem: qr.searchParams.get('computer_name') === deviceName(), pollStatus: status,
      securityFields: [...securityFields] }); return; }
    if (status === '3' || status === 'confirmed' || (typeof state.session_cookie === 'string' && state.session_cookie)) {
      if (typeof state.session_cookie === 'string') {
        for (const item of state.session_cookie.split(';')) {
          const match = /^\s*(sessionid|sessionid_ss|sid_tt|sid_guard)=(.*)$/.exec(item);
          if (match && match[2]) await command('Network.setCookie', { name: match[1], value: match[2], url: ORIGIN, path: '/', secure: true, httpOnly: true });
        }
      }
      stage = '校验账号';
      const jar = await cookies();
      if (!jar.some(c => ['sessionid', 'sessionid_ss'].includes(c.name) && c.value)) throw fail('尚未取得登录凭据');
      const me = await request('/luna/pc/me?' + new URLSearchParams({ aid: '386088', device_id: device.did, install_id: device.iid }));
      if (!me || Number(me.status_code || 0) !== 0) throw fail('汽水账号校验失败', me?.status_code);
      const info = me.my_info, id = info && (info.user_id || info.uid || info.id || info.douyin_id);
      if (!id || !info.nickname || (typeof id === 'number' && !Number.isSafeInteger(id))) throw fail('未能校验汽水账号身份');
      emit({ type: 'complete', cookies: await cookies(), account: { id: String(id), name: String(info.nickname) } });
      return;
    }
    if (status === 'scanned' || status === '2') emit({ type: 'qr', url: qrURL, status: 'scanned' });
    else if (status !== 'new' && status !== '1') throw fail('二维码已失效或登录被取消');
  }
  if (!closing) throw fail('二维码已超时，请重新登录');
}

async function main() {
  let existing;
  if (probe) {
    const i = process.argv.indexOf('--device-file');
    if (i < 0 || !process.argv[i + 1]) throw fail('匿名验证需要独立设备文件');
    existing = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  } else {
    const input = readline.createInterface({ input: process.stdin });
    existing = await new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timeout); input.removeListener('close', ended); input.removeListener('error', ended); };
      const ended = () => { stop(); reject(fail('登录已取消')); };
      const timeout = setTimeout(() => { stop(); reject(fail('登录初始化超时')); }, 15000);
      input.once('close', ended); input.once('error', ended);
      input.once('line', line => {
        stop();
        try { const message = JSON.parse(line); if (message.type !== 'start') throw new Error(); dataDir = message.dataDir; resolve(message.device); }
        catch { reject(fail('登录初始化消息无效')); }
      });
    });
    input.on('line', () => { cleanup().finally(() => process.exit(0)); });
    input.on('close', () => { cleanup().finally(() => process.exit(0)); });
  }
  stage = '准备汽水组件';
  preparing = prepareSdk({ dataDir, signal: sdkController.signal, onProgress: text => { if (!probe && !closing) emit({ type: 'progress', text }); } });
  await preparing;
  if (closing) return;
  if (!probe) emit({ type: 'ready' });
  const total = setTimeout(() => { cleanup().finally(() => process.exit(1)); }, 500000);
  try { await login(existing); } finally { clearTimeout(total); }
}
main().catch(async error => {
  if (session && !closing) { try { await cookies(); } catch {} }
  if (!closing) emit({ type: 'error', stage, code: error.code || 'unknown', description: safeDescription(error.message), status: 'unknown' });
  process.exitCode = 1;
}).finally(async () => { await cleanup(); process.exit(process.exitCode || 0); });
