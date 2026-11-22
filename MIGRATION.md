# Cloudflare Worker → 腾讯云 EdgeOne 边缘函数 迁移说明

对应代码：[`edge-function.js`](./edge-function.js)（单文件，直接粘贴进 EdgeOne 边缘函数）

功能与 CF 版本完全一致：密钥访问（HMAC 签名 Cookie）、Release / Raw / 仓库 ZIP 查询、`/proxy` 流式转发 + Range 断点续传 + 域名白名单、内置前端页面。

---

## 一、部署步骤（控制台，5 分钟）

| 步骤 | 位置 | 操作 |
|---|---|---|
| 1 | 控制台 → 边缘安全加速平台 EO → 站点 | 已接入的站点（没有就先添加站点、改 NS 生效） |
| 2 | 站点 → **边缘函数 → 函数管理** | 新建函数，命名（2–30 字符，如 `gh-accelerator`） |
| 3 | 函数编辑页 | 粘贴 `edge-function.js` 全文 → **保存并部署** |
| 4 | 函数详情页底部 **环境变量与密钥** | 添加 `GITHUB_TOKEN`（Secret）、`ACCESS_KEY`（Secret）、`SESSION_TTL`（String，可省）→ **部署** |
| 5 | 函数详情页 **触发配置** | 新增触发规则：匹配全部路径 → 执行该函数（见下表） |
| 6 | 站点 → 域名管理 | 用你的加速域名访问验证 |

> 环境变量改完必须再点一次 **部署** 才生效；变量名只能包含大小写字母、数字和 `@ . - ,`，`ACCESS_KEY` / `GITHUB_TOKEN` / `SESSION_TTL` 都合法。

---

## 二、控制台需要配置的规则

### 1. 触发规则（必需）

函数不配触发规则时不会被调用。

| 配置项 | 建议值 | 说明 |
|---|---|---|
| 匹配域名 | `gh-acc.yourdomain.com` | 你的加速域名 |
| 匹配路径 | `/` 全部（正则 `^/` 或「全部 URL」） | 密钥校验要求「任何路径」都进函数，**不要只匹配 `/`** |
| 执行动作 | 执行边缘函数 → 选择本函数 | |
| 优先级 | 置前 | 避免被其他规则抢先响应 |

> 单站点最多 200 条触发规则、100 个函数；函数代码包上限 5 MB。

### 2. 环境变量与密钥（必需，至少 `ACCESS_KEY`）

| 变量名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ACCESS_KEY` | **Secret** | 强烈建议 | 访问密码；为空则校验自动关闭 |
| `ACCESS_PASSWORD` | Secret | 否 | 别名，两个都配时优先 `ACCESS_KEY` |
| `GITHUB_TOKEN` | **Secret** | 推荐 | API 配额 60 → 5000 次/小时 |
| `SESSION_TTL` | String | 否 | 免验证时长（秒），默认 `604800`，范围 300–2592000 |

代码里读的是运行时全局 `env`（`env.ACCESS_KEY`），**不是** `context.env`，也**不是** `process.env`。

### 3. 缓存规则（建议）

- 函数响应天然在缓存之前处理，不会被站点缓存；
- 但代码内已对首页和验证页发 `Cache-Control: no-store`，防止「登录页/首页」被共享缓存；
- 如果你额外配了「缓存过期时间」规则，请把 `/__auth`、`/__logout` 排除，或统一按 `Cache-Control` 尊重源站。

### 4. CORS（无需配置）

函数本身返回 `Access-Control-Allow-Origin: *` 和 `Access-Control-Expose-Headers`。不要再在「响应头改写」里加一次，重复头会让浏览器报错。

### 5. HTTPS 证书（必需）

域名管理里申请/上传证书，`Secure` Cookie 只在 HTTPS 下下发。

### 6. 可选加固

| 目的 | 做法 |
|---|---|
| 防密码爆破 | 规则引擎 → 速率限制：`/__auth` 单 IP 每分钟 ≤ 10 次 |
| 防盗链 | 只允许特定 Referer 访问 `/proxy`（注意下载器可能不带 Referer） |
| 大文件下载 | 无需额外配置，`/proxy` 走流式，不占用函数内存 |

---

## 三、与原 CF Worker 的差异点

| 项目 | Cloudflare Worker | EdgeOne 边缘函数 | 代码里的处理 |
|---|---|---|---|
| 入口 | `export default { async fetch(request, env) }` | `addEventListener('fetch', e => e.respondWith(...))`，且必须**同步**调用 `respondWith` | 入口改成 3 行注册；逻辑在 `handleRequest` |
| 环境变量 | 函数第二参数 `env` | 运行时注入的**全局对象** `env` | `getEnv()` 读全局 `env`，兼容 `globalThis.env` |
| 变量类型 | 普通文本/密钥 | String / JSON / Secret（JSON 自动解析成对象） | 都当字符串用，`Secret` 直接读即可 |
| Cookie 读取 | `request.headers.get('Cookie')` | 同左，另有 `new Cookies(...)` 封装 | 保留手写解析，不依赖 `Cookies` 类，行为可预期 |
| Cookie 下发 | `headers['Set-Cookie']` | 可用，但一个响应只建议一条；官方示例是手工拼 `Set-Cookie` | `redirectTo()` 里用 `Headers.append('Set-Cookie', ...)`，只发一条 |
| base64 | `btoa` | 标准 Web API，但为稳妥起见不用 | 手写 base64url 编码，零依赖 |
| 加密 | `crypto.subtle` | Web Crypto（支持） | 不变，HMAC-SHA256 |
| 流式转发 | `new Response(resp.body, ...)` | Streams 支持，直接传 `ReadableStream` | 保持流式，大文件不进内存 |
| 上游压缩 | 一般原样透传 | 边缘节点可能再压缩，双重编码会坏包 | 请求上游带 `Accept-Encoding: identity`，响应删除 `Content-Encoding` / `Transfer-Encoding` / `Connection` |
| 中文文件名 | 直接塞进 `Content-Disposition`（部分环境报错） | 响应头出现非 ASCII 会失败 | 非 ASCII 走 RFC 5987 `filename*=UTF-8''...` |
| HEAD 请求 | 返回 body 也容忍 | 更严格 | 统一转成空 body |
| 执行限制 | CPU 10ms 起、内存 128MB | **CPU 200ms**、内存 128MB、请求体 1MB、循环 ≤ 10 万次 | 逻辑全是 I/O 等待 + 一次 HMAC，CPU 占用远低于 200ms |
| 存储 | KV / R2 / D1 可选 | 有 KV，但本方案**不用** | 会话全靠签名 Cookie，无状态、零存储依赖 |
| 部署 | Dashboard 粘贴 / wrangler | 控制台粘贴，或 CLI + Git 集成 | 单文件，无 npm 依赖 |

**关于「循环 ≤ 100000 次」**：代码里只有三处小循环（域名白名单、Cookie 解析、Release 资产列表），资产上千个也只是几千次迭代，不会触发上限。

---

## 四、自测清单（部署后逐条验）

```bash
# 1. 未验证访问任何路径 → 401 + 验证页
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/api/repo
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/proxy?url=x

# 2. 错误密钥 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d "pw=wrong" https://你的域名/__auth

# 3. 正确密钥 → 302 + Set-Cookie
curl -s -D - -o /dev/null -X POST -d "pw=你的密钥" https://你的域名/__auth | grep -i "^set-cookie\|^location"

# 4. 带 Cookie 访问 → 200（把上一步的 Cookie 填进去）
curl -s -o /dev/null -w "%{http_code}\n" -H "Cookie: gh_acc_auth=..." https://你的域名/

# 5. 请求头直连（非浏览器）
curl -s -H "X-Access-Key: 你的密钥" "https://你的域名/api/repo?name=microsoft/vscode"

# 6. 断点续传头
curl -s -D - -o /dev/null -H "Cookie: gh_acc_auth=..." -H "Range: bytes=0-99" \
  "https://你的域名/proxy?url=<encodeURIComponent 后的 GitHub 文件地址>" | grep -i "206\|content-range"

# 7. 白名单
curl -s -o /dev/null -w "%{http_code}\n" -H "Cookie: gh_acc_auth=..." \
  "https://你的域名/proxy?url=https%3A%2F%2Fevil.com%2Fx"   # 期望 403
```

浏览器侧再确认：验证一次后刷新首页、切换路径、点下载都**不再**弹验证页；点页面底部「退出」回到验证页。

---

## 五、常见问题

**Q：登录成功却还是回到验证页？**
按顺序查：① 响应里有没有 `Set-Cookie`（部分站点的「响应头改写」规则会删掉它）；② 是否在 HTTPS 下访问（`Secure` Cookie 只在 https 下发）；③ 是否换了域名访问（Cookie 按域名隔离）；④ 改过 `ACCESS_KEY` 后旧会话会失效。

**Q：函数改了不生效？**
EdgeOne 的代码和环境变量都需要手动点 **部署**；只保存不部署仍是旧版本。

**Q：`/proxy` 下载到的文件损坏 / 空白？**
通常是压缩头冲突。本代码已请求上游 `identity` 并剥离 `Content-Encoding`；如果你在站点上又开了「智能压缩」，请对二进制响应排除该规则。

**Q：大文件下载会超时吗？**
不会，`/proxy` 是流式转发，函数不缓存整个响应体，内存占用与文件大小无关。

**Q：能改成 EdgeOne Pages 部署吗？**
可以。Pages Functions 用 `onRequest(context)`，只要把入口换成：

```js
export async function onRequest(context) {
  return await handleRequest(context.request, context.env); // handleRequest 已支持传入 env
}
```

删掉 `addEventListener(...)` 那 3 行，并把文件放到 `functions/[[default]].js` 即可（其它逻辑零改动）。Pages 上环境变量在「项目设置 → 环境变量」里配。

**Q：没有源站能用边缘函数吗？**
函数命中触发规则后直接响应、不回源，所以源站地址可以随便填；但站点本身必须完成域名接入。

---

## 六、免责声明

本工具仅用于学习研究用途，请遵守 GitHub 服务条款及相关法律法规。不得用于下载侵权或违法内容。

代理仅放行 GitHub 相关域名（`github.com`、`raw.githubusercontent.com`、`objects.githubusercontent.com`、`github-releases.githubusercontent.com`、`codeload.github.com` 等），不提供任意网址转发能力。
