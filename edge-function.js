/**
 * GitHub 加速下载 - 腾讯云 EdgeOne 边缘函数版
 * ---------------------------------------------------------------
 * 从 Cloudflare Worker 迁移而来，功能完全一致：
 *   · 密钥访问（HMAC 签名 Cookie，一次性验证，全路径拦截）
 *   · Release 资产查询 / Raw 文件解析 / 仓库 ZIP
 *   · /proxy 流式转发，透传 Range 支持断点续传，域名白名单
 *   · 内置前端页面
 *
 * 部署方式：EdgeOne 控制台 → 站点 → 边缘函数 → 新建函数 → 粘贴本文件 → 部署
 * 详细差异与触发规则配置见同目录 MIGRATION.md
 *
 * ⚠️ 免责声明：本工具仅用于学习研究用途，请遵守 GitHub 服务条款及相关法律法规。
 *    不得用于下载侵权或违法内容。
 */

var GITHUB_API = 'https://api.github.com';

// ====== GitHub Token 配置 ======
// ⚠️ 方式1: 直接填在这里 — 仅限本地测试，开源部署请勿使用此方式！
// 方式2（推荐）: 边缘函数 → 环境变量与密钥 → 添加 GITHUB_TOKEN（类型选 Secret）
// 获取 Token: https://github.com/settings/tokens → 勾选 public_repo → 生成
// 不填 Token 也行，但 API 限流很严（60次/小时），填了提升到 5000次/小时
var USER_TOKEN = ''; // <-- 开源部署时请留空，改用环境变量

// ====== 访问密钥（一次性验证）配置 ======
// 作用：开启后，**任何路径**（首页 / /api/* / /proxy 下载）都必须先通过密钥验证，
//      验证一次后写入 HttpOnly 签名 Cookie，之后不再弹验证页；Cookie 过期或被篡改则重新验证。
//
// ✅ 推荐：边缘函数 → 环境变量与密钥 → 添加 ACCESS_KEY（类型选 Secret）
// ⚠️ 方式2: 直接填在下面 — 仅限本地测试，不要把真实密钥提交到仓库
// ⚠️ 两者都为空时，访问校验自动关闭（避免配漏变量把自己锁在门外）
var USER_ACCESS_KEY = '';
var DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60; // 验证通过后免验证有效期（秒），默认 7 天
var COOKIE_NAME = 'gh_acc_auth';
var LOGIN_PATH = '/__auth';   // 验证页 / 提交验证
var LOGOUT_PATH = '/__logout'; // 主动退出（清除 Cookie）

// ====== 入口（EdgeOne 边缘函数唯一支持的写法） ======
// 与 CF Worker 的 `export default { fetch(request, env) }` 不同：
//   · 边缘函数用 addEventListener('fetch') 注册，且必须同步调用 event.respondWith()
//   · env 不是参数，而是运行时注入的全局对象 env（见 getEnv）
addEventListener('fetch', function (event) {
  event.respondWith(handleRequest(event.request));
});

/**
 * 真正的请求处理入口。
 * @param {Request} request 标准 Request
 * @param {Object} [envOverride] 仅供本地调试注入，线上留空即读全局 env
 */
async function handleRequest(request, envOverride) {
  var E = envOverride || getEnv();
  var res = await dispatch(request, E);

  // HEAD 请求不能带 body，否则部分节点会报错
  if (request.method === 'HEAD' && res && res.body) {
    return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  return res;
}

async function dispatch(request, E) {
  var url = new URL(request.url);
  var path = url.pathname;

  // CORS 预检：不触发业务逻辑，也不消耗密钥校验
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Access-Key' }
    });
  }

  // ★ 访问校验闸门：放在所有路由之前，任何路径都绕不过去
  var authKey = getAuthKey(E);
  if (authKey) {
    var gate = await checkAccess(request, url, authKey, E);
    if (gate) return gate;
  }

  return await route(request, E, url, authKey);
}

async function route(request, E, url, authKey) {
  var token = (E && E.GITHUB_TOKEN) || USER_TOKEN;
  var path = url.pathname;

  try {
    if (path === '/api/release') return json(await getRelease(url.searchParams.get('url'), token));
    if (path === '/api/raw') return json(await getRaw(url.searchParams.get('url'), token));
    if (path === '/api/repo') return json(await getRepo(url.searchParams.get('name'), token));
    if (path === '/proxy') return await handleProxy(request, url);
  } catch (e) {
    return json({ success: false, error: e.message }, 400);
  }

  return new Response(buildHtml(!!authKey), {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      // 防止被站点缓存规则缓存住「已登录/未登录」的不同页面
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
  });
}

// ====== 环境变量：边缘函数里是全局对象 env，不是函数参数 ======

function getEnv() {
  // 边缘函数运行时注入全局 env；本地 Node 调试时可能挂在 globalThis 上
  if (typeof env !== 'undefined' && env) return env;
  if (typeof globalThis !== 'undefined' && globalThis.env) return globalThis.env;
  return {};
}

function getAuthKey(E) {
  var k = (E && (E.ACCESS_KEY || E.ACCESS_PASSWORD)) || USER_ACCESS_KEY || '';
  return String(k).trim();
}

function getSessionTTL(E) {
  var ttl = parseInt(E && E.SESSION_TTL, 10);
  if (!ttl || isNaN(ttl)) ttl = DEFAULT_SESSION_TTL;
  if (ttl < 300) ttl = 300;                              // 最少 5 分钟
  if (ttl > 30 * 24 * 60 * 60) ttl = 30 * 24 * 60 * 60;  // 最多 30 天
  return ttl;
}

// ====== 访问校验：密钥 / 会话 / 验证页 ======

/**
 * 返回 null 表示「已通过验证，继续走正常路由」；
 * 返回 Response 表示「拦下这个请求」（验证页 / 登录提交结果 / 重定向）。
 */
async function checkAccess(request, url, authKey, E) {
  var path = url.pathname;
  var ttl = getSessionTTL(E);

  // 退出：清 Cookie 后回首页
  if (path === LOGOUT_PATH) {
    return redirectTo('/', clearCookie(url));
  }

  // 验证页与提交入口
  if (path === LOGIN_PATH) {
    return await handleLogin(request, url, authKey, ttl);
  }

  // 已持有有效会话 → 放行（任何路径都不再弹验证）
  if (await verifySession(request, authKey)) return null;

  // 无 Cookie 的客户端（curl / 下载器）：允许用请求头或 ?key= 直接验证，等价于输入密钥
  var provided = readCredential(request, url);
  if (provided && safeEqualStr(provided, authKey)) {
    // 浏览器用 ?key= 打开页面时，顺手种下会话 Cookie 并跳回干净地址，避免密钥留在地址栏
    if (request.method === 'GET' && url.searchParams.has('key') && wantsHtml(request)) {
      return redirectTo(cleanPath(url), await makeCookie(authKey, ttl, url));
    }
    return null;
  }

  // 未验证：一律返回验证页（POST 等写操作同样拦下）
  return loginResponse(safeNext(cleanPath(url), '/'), ttl, '', 401);
}

async function handleLogin(request, url, authKey, ttl) {
  var next = safeNext(url.searchParams.get('next'), '/');

  if (request.method !== 'POST') {
    return loginResponse(next, ttl, '', 200);
  }

  var pw = await readPostedPassword(request);

  if (!pw || !safeEqualStr(pw, authKey)) {
    // 失败加一点延迟，降低暴力猜解速度（边缘函数无状态，做不了精确限流）
    await sleep(400 + Math.floor(Math.random() * 400));
    return loginResponse(next, ttl, '密钥不正确，请重新输入', 401);
  }

  return redirectTo(next, await makeCookie(authKey, ttl, url));
}

// 只解析 urlencoded 的 pw 字段：不依赖 request.formData()，各边缘运行时行为一致
async function readPostedPassword(request) {
  try {
    var ct = (request.headers.get('Content-Type') || '').toLowerCase();
    if (ct.indexOf('application/x-www-form-urlencoded') === -1) return '';
    var text = await request.text();
    var m = /(?:^|&)pw=([^&]*)/.exec(text || '');
    if (!m) return '';
    var raw = m[1].replace(/\+/g, ' ');
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  } catch (e) { return ''; }
}

function loginResponse(next, ttl, error, status) {
  var action = LOGIN_PATH + '?next=' + encodeURIComponent(next);
  var days = Math.max(1, Math.round(ttl / 86400));
  var H = [];
  H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="robots" content="noindex,nofollow"><title>\u8bbf\u95ee\u9a8c\u8bc1</title><style>');
  H.push('*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;color:#fff}');
  H.push('.box{width:100%;max-width:400px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:2rem;backdrop-filter:blur(20px);box-shadow:0 20px 60px rgba(0,0,0,.4)}');
  H.push('.ico{width:56px;height:56px;border-radius:16px;background:rgba(102,126,234,.18);border:1px solid rgba(102,126,234,.35);display:flex;align-items:center;justify-content:center;margin-bottom:1.25rem;font-size:1.6rem}');
  H.push('h1{font-size:1.25rem;margin-bottom:.4rem}p.sub{color:#a0aec0;font-size:.9rem;margin-bottom:1.4rem;line-height:1.6}');
  H.push('label{display:block;font-size:.85rem;color:#cbd5e1;margin-bottom:.5rem}input{width:100%;padding:1rem 1.2rem;border:2px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.05);color:#fff;font-size:1rem;outline:none}input:focus{border-color:#667eea}');
  H.push('button{width:100%;margin-top:1rem;padding:1rem;border:none;border-radius:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:1rem;font-weight:600;cursor:pointer}button:hover{box-shadow:0 8px 25px rgba(102,126,234,.4)}');
  H.push('.err{margin-bottom:1rem;padding:.75rem 1rem;border-radius:10px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#fca5a5;font-size:.85rem}');
  H.push('.foot{margin-top:1.25rem;text-align:center;color:#6b7280;font-size:.75rem;line-height:1.7}');
  H.push('</style></head><body><div class=box>');
  H.push('<div class=ico>\uD83D\uDD12</div>');
  H.push('<h1>\u9700\u8981\u8bbf\u95ee\u5bc6\u94a5</h1>');
  H.push('<p class=sub>\u8be5\u7ad9\u70b9\u5df2\u5f00\u542f\u5bc6\u94a5\u4fdd\u62a4\uff0c\u8f93\u5165\u6b63\u786e\u5bc6\u94a5\u540e\u624d\u80fd\u7ee7\u7eed\u8bbf\u95ee\u3002</p>');
  if (error) H.push('<div class=err>' + escapeHtml(error) + '</div>');
  H.push('<form method=POST action="' + action + '">');
  H.push('<label for=pw>\u8bbf\u95ee\u5bc6\u94a5</label>');
  H.push('<input type=password id=pw name=pw autocomplete=current-password autofocus required placeholder="\u8bf7\u8f93\u5165\u5bc6\u94a5">');
  H.push('<button type=submit>\u9a8c\u8bc1\u5e76\u8fdb\u5165</button>');
  H.push('</form>');
  H.push('<div class=foot>\u9a8c\u8bc1\u901a\u8fc7\u540e ' + days + ' \u5929\u5185\u65e0\u9700\u91cd\u590d\u8f93\u5165<br>\u5bc6\u94a5\u7531\u7ad9\u957f\u5728\u8fb9\u7f18\u51fd\u6570\u73af\u5883\u53d8\u91cf ACCESS_KEY \u4e2d\u914d\u7f6e</div>');
  H.push('</div></body></html>');

  return new Response(H.join(''), {
    status: status || 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

/**
 * 302 跳转。
 * 与 CF Worker 的差异：EdgeOne 里 Set-Cookie 必须自己拼进响应头，
 * 且一个响应只设一条（本函数只会下发一条会话 Cookie，够用）。
 */
function redirectTo(location, setCookie) {
  var h = new Headers();
  h.set('Location', location);
  h.set('Cache-Control', 'no-store');
  if (setCookie) h.append('Set-Cookie', setCookie);
  return new Response(null, { status: 302, headers: h });
}

// ---- 会话 Cookie：HMAC 签名，密钥即签名材料，改 ACCESS_KEY 会让所有旧会话立即失效 ----

async function makeCookie(authKey, ttl, url) {
  var exp = Math.floor(Date.now() / 1000) + ttl;
  var sig = await sign(authKey, 'v1.' + exp);
  var secure = url.protocol === 'https:' ? '; Secure' : '';
  return COOKIE_NAME + '=v1.' + exp + '.' + sig + '; Path=/; Max-Age=' + ttl + '; HttpOnly; SameSite=Lax' + secure;
}

function clearCookie(url) {
  var secure = url.protocol === 'https:' ? '; Secure' : '';
  return COOKIE_NAME + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' + secure;
}

async function verifySession(request, authKey) {
  var raw = getCookie(request, COOKIE_NAME);
  if (!raw) return false;
  var parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  var exp = parseInt(parts[1], 10);
  if (!exp || isNaN(exp)) return false;
  if (exp <= Math.floor(Date.now() / 1000)) return false;
  var expect = await sign(authKey, 'v1.' + exp);
  return safeEqualStr(parts[2], expect);
}

async function sign(authKey, msg) {
  var enc = new TextEncoder();
  var k = await crypto.subtle.importKey('raw', enc.encode('gh-acc-v1|' + authKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  var buf = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return toB64Url(new Uint8Array(buf));
}

// 手写 base64url 编码：不依赖 btoa，各边缘运行时都能跑
function toB64Url(bytes) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    var n = (b0 << 16) | (b1 << 8) | b2;
    out += chars[(n >> 18) & 63];
    out += chars[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += chars[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += chars[n & 63];
  }
  return out;
}

function getCookie(request, name) {
  var raw = request.headers.get('Cookie') || '';
  var parts = raw.split(';');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    var idx = p.indexOf('=');
    if (idx === -1) continue;
    if (p.slice(0, idx) === name) return p.slice(idx + 1);
  }
  return '';
}

function readCredential(request, url) {
  var h = request.headers.get('Authorization') || '';
  var m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  var x = request.headers.get('X-Access-Key');
  if (x) return x.trim();
  var q = url.searchParams.get('key');
  if (q) return q;
  return '';
}

function wantsHtml(request) {
  return (request.headers.get('Accept') || '').toLowerCase().indexOf('text/html') !== -1;
}

function cleanPath(url) {
  var u = new URL(url.toString());
  u.searchParams.delete('key');
  return u.pathname + u.search;
}

function safeNext(raw, fallback) {
  if (!raw) return fallback;
  var s = String(raw).trim();
  if (s.charAt(0) !== '/') return fallback;
  if (s.charAt(1) === '/' || s.charAt(1) === '\\') return fallback;
  if (s.indexOf('\\') !== -1) return fallback;
  try {
    var u = new URL('https://safe.local' + s);
    u.searchParams.delete('key');
    var out = u.pathname + u.search;
    if (out.charAt(0) !== '/') return fallback;
    return out;
  } catch (e) { return fallback; }
}

// 定长时间比较，避免按字符逐个提前返回泄露信息
function safeEqualStr(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  if (!b) return false;
  var diff = a.length ^ b.length;
  var max = Math.max(a.length, b.length);
  for (var i = 0; i < max; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// ====== 以下为原有业务逻辑 ======

async function ghFetch(path, token) {
  var headers = { 'User-Agent': 'GitHub-Accelerator/1.0' };
  if (token) headers['Authorization'] = 'token ' + token;
  var r = await fetch(GITHUB_API + path, { headers: headers });
  var d = await r.json();
  if (!r.ok) throw new Error(d.message || 'GitHub API 请求失败');
  return d;
}

function proxyUrl(targetUrl) {
  return '/proxy?url=' + encodeURIComponent(targetUrl);
}

async function handleProxy(request, url) {
  var target = url.searchParams.get('url');
  if (!target) return new Response('Missing url parameter', { status: 400 });

  // 只允许代理 GitHub 相关域名
  var allowedHosts = [
    'github.com', 'raw.githubusercontent.com',
    'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
    'codeload.github.com', 'github-production-release-asset-2e65be.s3.amazonaws.com'
  ];
  try {
    var parsed = new URL(target);
    var ok = false;
    for (var k = 0; k < allowedHosts.length; k++) {
      if (parsed.hostname === allowedHosts[k] || parsed.hostname.endsWith('.' + allowedHosts[k])) {
        ok = true; break;
      }
    }
    if (!ok) return new Response('Forbidden: source not allowed', { status: 403 });
  } catch (e) { return new Response('Invalid URL', { status: 400 }); }

  // 透传 Range 请求头（支持断点续传）
  // 主动要求 identity：避免上游 gzip 与边缘节点自身的压缩叠加，导致下载文件损坏
  var reqHeaders = { 'User-Agent': 'EdgeOne-GitHub-Proxy/1.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' };
  var range = request.headers.get('Range');
  if (range) reqHeaders['Range'] = range;

  try {
    var resp = await fetch(target, { headers: reqHeaders });
    var respHeaders = new Headers(resp.headers);

    // 上游压缩/连接类头不能原样带回，否则会和边缘节点的处理冲突
    respHeaders.delete('Content-Encoding');
    respHeaders.delete('Transfer-Encoding');
    respHeaders.delete('Connection');

    // 添加跨域头
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Accept-Ranges, Content-Range');

    // 强制添加 Content-Disposition 让浏览器识别为下载
    if (!respHeaders.has('Content-Disposition')) {
      var last = (target.split('/').pop() || 'download').split('?')[0].split('#')[0];
      var fileName = safeDecode(last) || 'download';
      respHeaders.set('Content-Disposition', buildDisposition(fileName));
    }

    // 流式返回：不整包读入内存，大文件不会触发边缘函数的内存 / body 限制
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders
    });
  } catch (e) {
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// 中文文件名用 RFC 5987 编码，避免响应头出现非法字符
function buildDisposition(fileName) {
  var safe = String(fileName).replace(/["\\\r\n]/g, '_');
  if (/^[\x20-\x7e]+$/.test(safe)) {
    return 'attachment; filename="' + safe + '"';
  }
  try {
    return 'attachment; filename="download"; filename*=UTF-8\'\'' + encodeURIComponent(safe);
  } catch (e) {
    return 'attachment; filename="download"';
  }
}

async function getRelease(releaseUrl, token) {
  if (!releaseUrl) throw new Error('缺少 url 参数');
  var m = releaseUrl.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/?(.+)?/i);
  if (!m) throw new Error('Release 链接格式无效');
  var owner = m[1], repo = m[2], tail = (m[3] || '');
  var apiPath = '/repos/' + owner + '/' + repo + '/releases/latest';
  if (tail.indexOf('/tag/') !== -1) {
    var tag = tail.split('/tag/')[1].split('?')[0];
    apiPath = '/repos/' + owner + '/' + repo + '/releases/tags/' + encodeURIComponent(decodeURIComponent(tag));
  }
  var data = await ghFetch(apiPath, token);
  var assets = (data.assets || []).map(function (a) {
    return { name: a.name, size: a.size, url: proxyUrl(a.browser_download_url) };
  });
  return { success: true, repo: owner + '/' + repo, tag: data.tag_name, assets: assets };
}

async function getRaw(fileUrl, token) {
  if (!fileUrl) throw new Error('缺少 url 参数');
  var m = fileUrl.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/i);
  if (!m) throw new Error('文件链接格式无效');
  var owner = m[1], repo = m[2], branch = m[3], filePath = m[4];
  var url = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath;
  return { success: true, filename: filePath.split('/').pop(), url: proxyUrl(url) };
}

async function getRepo(repoName, token) {
  if (!repoName || repoName.indexOf('/') === -1) throw new Error('请使用 owner/repo 格式');
  var p = repoName.split('/');
  var data = await ghFetch('/repos/' + p[0] + '/' + p[1], token);
  var branch = data.default_branch || 'main';
  var url = 'https://github.com/' + p[0] + '/' + p[1] + '/archive/refs/heads/' + branch + '.zip';
  return { success: true, repo: p[0] + '/' + p[1], branch: branch, url: proxyUrl(url) };
}

// ====== HTML 页面（数组拼接，杜绝模板字符串问题） ======

function buildHtml(authEnabled) {
  var H = [];
  H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>GitHub加速下载</title><style>');
  H.push('*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;color:#fff;display:flex;flex-direction:column;align-items:center}');
  H.push('.container{max-width:900px;width:100%;padding:2rem;margin:0 auto}header{text-align:center;padding:3rem 0 2rem}header h1{font-size:2.5rem;background:linear-gradient(90deg,#667eea,#764ba2,#f093fb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:.5rem}header p{color:#a0aec0;font-size:1.1rem}');
  H.push('.card{background:rgba(255,255,255,.05);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:2rem;margin-bottom:2rem}');
  H.push('.tabs{display:flex;gap:.5rem;margin-bottom:1.5rem;border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:.5rem}.tab{padding:.5rem 1.5rem;border:none;background:none;color:#a0aec0;cursor:pointer;font-size:.95rem;border-radius:8px}.tab:hover{color:#fff;background:rgba(255,255,255,.05)}.tab.active{color:#fff;background:rgba(102,126,234,.2)}');
  H.push('.tab-content{display:none}.tab-content.active{display:block}');
  H.push('.input-group{display:flex;gap:1rem;flex-wrap:wrap}.input-group input{flex:1;min-width:200px;padding:1rem 1.5rem;border:2px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.05);color:#fff;font-size:1rem;outline:none}.input-group input:focus{border-color:#667eea}.input-group input::placeholder{color:#6b7280}');
  H.push('.btn{padding:1rem 2rem;border:none;border-radius:12px;font-size:1rem;font-weight:600;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:.5rem}.btn-primary{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}.btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(102,126,234,.4)}.btn-secondary{background:rgba(255,255,255,.1);color:#fff}.btn-secondary:hover{background:rgba(255,255,255,.2)}');
  H.push('.examples{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}.example-tag{padding:.4rem 1rem;border-radius:20px;background:rgba(102,126,234,.15);border:1px solid rgba(102,126,234,.3);color:#a0c4ff;font-size:.85rem;cursor:pointer}');
  H.push('.result-area{display:none;margin-top:1.5rem}.result-area.show{display:block}.result-item{padding:1rem;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);margin-top:.75rem}.result-item .name{font-weight:500;margin-bottom:.3rem;word-break:break-all}.result-item .meta{color:#a0aec0;font-size:.85rem;margin-bottom:.5rem}.result-item .actions{display:flex;gap:.75rem;flex-wrap:wrap}');
  H.push('.loading{display:inline-block;width:20px;height:20px;border:3px solid rgba(255,255,255,.3);border-radius:50%;border-top-color:#fff;animation:spin .6s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}');
  H.push('.toast{position:fixed;top:20px;right:20px;padding:1rem 2rem;border-radius:12px;background:rgba(0,0,0,.85);backdrop-filter:blur(10px);color:#fff;transform:translateX(120%);transition:transform .3s;z-index:999}.toast.show{transform:translateX(0)}');
  H.push('footer{text-align:center;padding:2rem;color:#6b7280;font-size:.85rem}.err{color:#ef4444;padding:1rem}');
  H.push('@media(max-width:600px){.container{padding:1rem}header h1{font-size:1.8rem}.card{padding:1.25rem}}');
  H.push('</style></head><body><div class=container>');
  H.push('<header><h1>GitHub\u52a0\u901f\u4e0b\u8f7d</h1><p>\u901a\u8fc7EdgeOne\u8fb9\u7f18\u8282\u70b9\u52a0\u901f\u4e0b\u8f7d</p></header>');
  H.push('<div class=card><div class=tabs>');
  H.push('<button class="tab active" id="tbR">Release\u4e0b\u8f7d</button>');
  H.push('<button class=tab id="tbW">Raw\u6587\u4ef6</button>');
  H.push('<button class=tab id="tbP">\u4ed3\u5e93ZIP</button>');
  H.push('</div>');
  H.push('<div class="tab-content active" id="pnR"><div class=input-group><input type=text id="inpR" placeholder="\u4f8b\u5982: https://github.com/user/repo/releases/latest"><button class="btn btn-primary" id="btnR">\u83b7\u53d6\u8d44\u6e90</button></div></div>');
  H.push('<div class=tab-content id="pnW"><div class=input-group><input type=text id="inpW" placeholder="\u4f8b\u5982: https://github.com/user/repo/blob/main/file.zip"><button class="btn btn-primary" id="btnW">\u83b7\u53d6\u94fe\u63a5</button></div></div>');
  H.push('<div class=tab-content id="pnP"><div class=input-group><input type=text id="inpP" placeholder="\u4f8b\u5982: microsoft/vscode"><button class="btn btn-primary" id="btnP">\u4e0b\u8f7dZIP</button></div></div>');
  H.push('<div class=examples><span class=example-tag d="r" v="https://github.com/microsoft/vscode/releases/latest">microsoft/vscode</span><span class=example-tag d="r" v="https://github.com/nodejs/node/releases/latest">nodejs/node</span><span class=example-tag d="p" v="curl/curl">curl/curl</span></div>');
  H.push('</div>');
  H.push('<div class=result-area id="res"><div class=card style="border:2px solid rgba(102,126,234,.3)"><h3 style="margin-bottom:1rem;color:#e2e8f0;font-size:1.05rem">\u2B07 \u4e0b\u8f7d\u5217\u8868</h3><div id="resB"><div style="text-align:center;padding:1.5rem;color:#6b7280;font-size:.9rem">\u5728\u4e0a\u65b9\u8f93\u5165\u94fe\u63a5\u540e\u70b9\u51fb\u83b7\u53d6\uff0c\u7ed3\u679c\u5c06\u663e\u793a\u5728\u8fd9\u91cc</div></div></div></div>');
  H.push('<div class=card style="padding-bottom:1px"><h3 style="margin-bottom:1.2rem;color:#e2e8f0;font-size:1.1rem">\u0030\uFE0F\u20E3 \u4f7f\u7528\u6307\u5357</h3><div style="color:#cbd5e1;line-height:2;font-size:.92rem">');
  H.push('<div style="background:rgba(102,126,234,.08);border-radius:12px;padding:1rem;margin-bottom:1rem">');
  H.push('<div style="display:grid;grid-template-columns:auto 1fr;gap:.6rem 1rem;align-items:baseline">');
  H.push('<span style="background:#667eea;color:#fff;font-size:.75rem;padding:0 8px;border-radius:4px;text-align:center">1</span><span><b>Release \u4e0b\u8f7d</b> \u2014 \u9002\u7528\u4e8e\u4e0b\u8f7d GitHub \u9879\u76ee\u53d1\u5e03\u7248\u672c\u4e2d\u7684\u9644\u4ef6\uff08\u5982 .zip\u3001.tar.gz\u3001.exe \u7b49\u4e8c\u8fdb\u5236\u6587\u4ef6\uff09</span>');
  H.push('<span style="background:#667eea;color:#fff;font-size:.75rem;padding:0 8px;border-radius:4px;text-align:center">2</span><span><b>Raw \u6587\u4ef6</b> \u2014 \u9002\u7528\u4e8e\u4e0b\u8f7d\u4ed3\u5e93\u4e2d\u7684\u5355\u4e2a\u6587\u4ef6\uff08\u5982\u56fe\u7247\u3001\u811a\u672c\u3001\u914d\u7f6e\u6587\u4ef6\u7b49\uff09\uff0c\u8f93\u5165 blob \u94fe\u63a5\u5373\u53ef</span>');
  H.push('<span style="background:#667eea;color:#fff;font-size:.75rem;padding:0 8px;border-radius:4px;text-align:center">3</span><span><b>\u4ed3\u5e93 ZIP</b> \u2014 \u4e00\u952e\u4e0b\u8f7d\u6574\u4e2a\u4ed3\u5e93\u7684\u6e90\u7801\u538b\u7f29\u5305\uff0c\u652f\u6301\u81ea\u52a8\u8bc6\u522b\u9ed8\u8ba4\u5206\u652f</span>');
  H.push('</div></div>');
  H.push('</div></div>');
  H.push('<div class=card style="padding-bottom:1px"><h3 style="margin-bottom:1.2rem;color:#e2e8f0;font-size:1.1rem">\u2753 \u5e38\u89c1\u95ee\u9898</h3><div style="color:#cbd5e1;line-height:2;font-size:.92rem">');
  H.push('<div style="margin-bottom:.8rem"><span style="color:#f093fb;font-weight:600">Q: \u4e3a\u4ec0\u4e48\u8981\u7528\u8fd9\u4e2a\u5de5\u5177\uff1f</span><br>\u56fd\u5185\u76f4\u63a5\u8bbf\u95ee GitHub \u4e0b\u8f7d\u901f\u5ea6\u6162\uff0c\u8fd9\u4e2a\u5de5\u5177\u901a\u8fc7 EdgeOne \u7684\u5168\u7403 CDN \u8282\u70b9\u4ee3\u7406\u4e0b\u8f7d\uff0c\u663e\u8457\u63d0\u5347\u4e0b\u8f7d\u901f\u5ea6\u3002</div>');
  H.push('<div style="margin-bottom:.8rem"><span style="color:#f093fb;font-weight:600">Q: \u652f\u6301\u54ea\u4e9b\u94fe\u63a5\u683c\u5f0f\uff1f</span><br>\u2022 Release: https://github.com/user/repo/releases/latest \u6216 https://github.com/user/repo/releases/tag/v1.0.0<br>\u2022 Raw: https://github.com/user/repo/blob/branch/path/file.ext<br>\u2022 \u4ed3\u5e93: \u4ec5\u9700 user/repo \u683c\u5f0f\uff0c\u5982 microsoft/vscode</div>');
  H.push('<div style="margin-bottom:.8rem"><span style="color:#f093fb;font-weight:600">Q: \u4e0b\u8f7d\u5931\u8d25\u600e\u4e48\u529e\uff1f</span><br>\u2022 \u68c0\u67e5 GitHub API \u8bf7\u6c42\u9650\u989d\uff08\u672a\u767b\u5f55\u72b6\u6001\u4e0b\u6bcf\u5c0f\u65f6 60 \u6b21\uff09<br>\u2022 \u786e\u8ba4\u94fe\u63a5\u5730\u5740\u6b63\u786e\u4e14\u4ed3\u5e93\u4e3a\u516c\u5f00\u4ed3\u5e93<br>\u2022 \u67d0\u4e9b\u5927\u6587\u4ef6\u53ef\u80fd\u9700\u8981\u7a0d\u5019\u518d\u8bd5</div>');
  H.push('<div style="margin-bottom:.8rem"><span style="color:#f093fb;font-weight:600">Q: \u80fd\u4e0b\u8f7d\u79c1\u6709\u4ed3\u5e93\u7684\u6587\u4ef6\u5417\uff1f</span><br>\u4e0d\u80fd\u3002\u672c\u5de5\u5177\u53ea\u652f\u6301\u516c\u5f00\u4ed3\u5e93\uff0c\u79c1\u6709\u4ed3\u5e93\u9700\u8981 GitHub Token \u8ba4\u8bc1\uff0c\u5efa\u8bae\u76f4\u63a5\u4f7f\u7528 GitHub CLI \u6216\u767b\u5f55\u540e\u4e0b\u8f7d\u3002</div>');
  H.push('<div style="margin-bottom:.8rem"><span style="color:#f093fb;font-weight:600">Q: \u4e0b\u8f7d\u7684\u6587\u4ef6\u548c\u539f\u59cb\u6587\u4ef6\u4e00\u6837\u5417\uff1f</span><br>\u5b8c\u5168\u4e00\u6837\u3002\u8fd9\u662f\u65e0\u635f\u4ee3\u7406\u4e0b\u8f7d\uff0c\u6587\u4ef6\u5185\u5bb9\u4e0e GitHub \u76f4\u63a5\u4e0b\u8f7d\u5b8c\u5168\u4e00\u81f4\uff0c\u53ef\u4ee5\u5b89\u5168\u4f7f\u7528\u3002</div>');
  H.push('</div></div>');
  H.push('<div class=card style="padding-bottom:1px"><h3 style="margin-bottom:1.2rem;color:#e2e8f0;font-size:1.1rem">\u2139\uFE0F \u5173\u4e8e\u672c\u5de5\u5177</h3><div style="color:#94a3b8;line-height:1.9;font-size:.88rem">');
  H.push('<p style="margin-bottom:.6rem">\u672c\u5de5\u5177\u662f\u4e00\u4e2a\u5f00\u6e90\u9879\u76ee\uff0c\u6e90\u7801\u8fd0\u884c\u5728 <b>\u817e\u8baf\u4e91 EdgeOne \u8fb9\u7f18\u51fd\u6570</b> \u4e4b\u4e0a\uff0c\u901a\u8fc7\u5168\u7403\u8282\u70b9\u4ee3\u7406\u4e0b\u8f7d\u6765\u52a0\u901f GitHub \u8d44\u6e90\u7684\u83b7\u53d6\u3002</p>');
  H.push('<p style="margin-bottom:.6rem"><b>\u6280\u672f\u67b6\u6784:</b> EdgeOne Edge Functions (Serverless) + GitHub REST API v3</p>');
  H.push('<p style="margin-bottom:.6rem"><b>\u4f7f\u7528\u9650\u5236:</b> GitHub API \u672a\u8ba4\u8bc1\u8bf7\u6c42\u6bcf\u5c0f\u65f6 60 \u6b21\uff0c\u8d85\u9650\u540e\u53ef\u7a0d\u5019\u518d\u8bd5</p>');
  H.push('<p style="margin-bottom:.6rem"><b>\u58f0\u660e:</b> \u672c\u5de5\u5177\u4ec5\u4e3a\u5b66\u4e60\u7814\u7a76\u7528\u9014\uff0c\u8bf7\u9075\u5b88 GitHub \u670d\u52a1\u6761\u6b3e\u53ca\u76f8\u5173\u6cd5\u5f8b\u6cd5\u89c4\u3002\u4e0d\u5f97\u7528\u4e8e\u4e0b\u8f7d\u4fb5\u6743\u6216\u8fdd\u6cd5\u5185\u5bb9\u3002</p>');
  H.push('</div></div>');
  H.push('<footer>Powered by EdgeOne Edge Functions' + (authEnabled ? ' \u00b7 <a href="/__logout" style="color:#6b7280;text-decoration:underline">\u9000\u51fa</a>' : '') + '</footer></div>');
  H.push('<div class=toast id="tt"></div>');
  H.push('<script>');
  H.push('(function(){');
  H.push('var $=function(id){return document.getElementById(id)};');
  H.push('var tbR=$("tbR"),tbW=$("tbW"),tbP=$("tbP");');
  H.push('var pnR=$("pnR"),pnW=$("pnW"),pnP=$("pnP");');
  H.push('var inpR=$("inpR"),inpW=$("inpW"),inpP=$("inpP");');
  H.push('var btnR=$("btnR"),btnW=$("btnW"),btnP=$("btnP");');
  H.push('var tabs=[{b:tbR,p:pnR,i:inpR,btn:btnR,n:"r",api:"/api/release?url="},{b:tbW,p:pnW,i:inpW,btn:btnW,n:"w",api:"/api/raw?url="},{b:tbP,p:pnP,i:inpP,btn:btnP,n:"p",api:"/api/repo?name="}];');
  H.push('function sw(idx){tabs.forEach(function(t,i){t.b.className=i===idx?"tab active":"tab";t.p.className=i===idx?"tab-content active":"tab-content"});$("res").className="result-area"}');
  H.push('tabs.forEach(function(t,i){t.b.onclick=function(){sw(i)}});');
  H.push('document.querySelectorAll(".example-tag").forEach(function(el){el.onclick=function(){var idx=this.getAttribute("d")==="r"?0:2;sw(idx);tabs[idx].i.value=this.getAttribute("v")}});');
  H.push('function tt(msg,err){var e=$("tt");e.textContent=msg;e.style.borderLeft=err?"4px solid #ef4444":"4px solid #667eea";e.className="toast show";setTimeout(function(){e.className="toast"},3000)}');
  H.push('function fmt(b){if(!b)return"";var u=["B","KB","MB","GB"];return(b/Math.pow(1024,Math.floor(Math.log(b)/Math.log(1024)))).toFixed(2)+" "+u[Math.floor(Math.log(b)/Math.log(1024))]}');
  H.push('function cp(t){navigator.clipboard.writeText(t).then(function(){tt("\u5df2\u590d\u5236")})["catch"](function(){var e=document.createElement("textarea");e.value=t;document.body.appendChild(e);e.select();document.execCommand("copy");document.body.removeChild(e);tt("\u5df2\u590d\u5236")})}');
  H.push('tabs.forEach(function(t){t.btn.onclick=async function(){var v=t.i.value.trim();if(!v){tt("\u8bf7\u8f93\u5165\u5185\u5bb9",true);return}var a=$("res"),b=$("resB");a.className="result-area show";b.innerHTML="<div style=\\"text-align:center;padding:2rem\\"><span class=loading></span> \u6b63\u5728\u83b7\u53d6...</div>";try{var r=await fetch(t.api+encodeURIComponent(v));var d=await r.json();if(!d.success){b.innerHTML="<div class=err>"+d.error+"</div>";tt(d.error,true);return}if(t.n==="r"){var h="<div style=\\"margin-bottom:.5rem\\"><b>"+d.repo+"</b> "+d.tag+"</div>";if(d.assets&&d.assets.length>0){for(var j=0;j<d.assets.length;j++){var a2=d.assets[j];var sz=a2.size?fmt(a2.size):"";h+="<div class=\\"result-item\\"><div class=\\"name\\">"+a2.name+"</div><div class=\\"meta\\">"+sz+"</div><div class=\\"actions\\"><a href=\\""+a2.url+"\\" class=\\"btn btn-primary\\" style=\\"font-size:.85rem;padding:.5rem 1rem\\">\u4e0b\u8f7d</a><button class=\\"btn btn-secondary\\" style=\\"font-size:.85rem;padding:.5rem 1rem\\" onclick=\\"cp(\\""+a2.url+"\\")\\">\u590d\u5236\u94fe\u63a5</button></div></div>"}}else{h+="<p style=color:#a0aec0>\u6682\u65e0\u9644\u4ef6</p>"}b.innerHTML=h}else{var lb=d.filename||d.repo||"";b.innerHTML="<div class=\\"result-item\\"><div class=\\"name\\">\u4e0b\u8f7d\u94fe\u63a5</div><div class=\\"meta\\">"+lb+"</div><div class=\\"actions\\"><a href=\\""+d.url+"\\" class=\\"btn btn-primary\\" style=\\"font-size:.85rem;padding:.5rem 1rem\\">\u4e0b\u8f7d</a><button class=\\"btn btn-secondary\\" style=\\"font-size:.85rem;padding:.5rem 1rem\\" onclick=\\"cp(\\""+d.url+"\\")\\">\u590d\u5236\u94fe\u63a5</button></div></div>"}}catch(e){b.innerHTML="<div class=err>\u8bf7\u6c42\u5931\u8d25</div>";tt("\u8bf7\u6c42\u5931\u8d25",true)}}});');
  H.push('sw(0);');
  H.push('})();');
  H.push('</script>');
  H.push('</body></html>');
  return H.join('');
}
