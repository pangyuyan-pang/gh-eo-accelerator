# GitHub 加速下载 - EdgeOne 边缘函数版

基于 **腾讯云 EdgeOne 边缘函数（Edge Functions）** 的 GitHub 资源加速下载工具。

通过 EdgeOne 全球边缘节点代理 Release 附件、Raw 文件和仓库源码，提升国内下载速度；内置访问密钥保护，未验证的访客连首页都看不到。

> 本仓库是 Cloudflare Worker 版的独立移植版本，功能一一对应：密钥鉴权、三类查询接口、`/proxy` 流式转发、Range 断点续传、域名白名单、内置前端页面。

---

## 目录

- [功能特性](#功能特性)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [控制台配置清单](#控制台配置清单)
- [环境变量](#环境变量)
- [接口说明](#接口说明)
- [下载器接入](#下载器接入)
- [与 Cloudflare 版的差异](#与-cloudflare-版的差异)
- [运行限制](#运行限制)
- [自测清单](#自测清单)
- [常见问题](#常见问题)
- [免责声明](#免责声明)
- [许可证](#许可证)

---

## 功能特性

| 能力 | 说明 |
|------|------|
| **Release 下载** | 解析 `releases/latest` / `releases/tag/vX`，列出全部附件与大小 |
| **Raw 文件** | 解析 `blob/分支/路径`，返回加速后的直链 |
| **仓库 ZIP** | 输入 `owner/repo`，自动识别默认分支并打包 |
| **流式转发** | `/proxy` 边下边传，函数不缓存整个文件 |
| **断点续传** | 透传 `Range`，支持 `206 Partial Content` |
| **域名白名单** | 仅放行 GitHub 相关域名，防止被当成任意代理 |
| **访问密钥** | HMAC 签名 Cookie，一次性验证，全路径拦截 |
| **无损下载** | 强制 `identity` 编码，剥离压缩头 |
| **中文文件名** | RFC 5987 编码，下载不乱码 |
| **零存储** | 不依赖 KV / R2 / 数据库，会话全靠签名 Cookie |

---

## 目录结构

```
.
├── edge-function.js    # 边缘函数主程序（单文件，直接粘贴到控制台）
├── MIGRATION.md        # 从 Cloudflare Worker 迁移的差异说明与配置细节
└── README.md
```

---

## 快速开始

### 1. 接入站点

EdgeOne 边缘函数挂在**站点**下：先把域名接入 EO（改 NS 生效），没有站点就先 `添加站点`。

### 2. 创建函数

控制台 → 站点 → **边缘函数 → 函数管理 → 新建函数**，命名 2–30 字符（如 `gh-accelerator`）。

### 3. 粘贴代码并部署

把 [`edge-function.js`](./edge-function.js) 全文粘贴进编辑器 → **保存并部署**。

### 4. 配置环境变量

函数详情页底部 **环境变量与密钥 → 快速添加**：

| 变量名 | 类型 | 必填 |
|--------|------|------|
| `ACCESS_KEY` | Secret | 强烈建议 |
| `GITHUB_TOKEN` | Secret | 推荐 |
| `SESSION_TTL` | String | 否 |

添加完再点一次 **部署**。

### 5. 配置触发规则

**触发配置 → 新增规则**：匹配你的加速域名 + **全部路径**（正则 `^/`），动作选择「执行边缘函数」，优先级置前。

> 只匹配 `/` 会让 `/api/*`、`/proxy` 绕过密钥校验。

### 6. 访问验证

打开加速域名，应看到「需要访问密钥」页面；输入密钥后进入下载首页，可测试：

- Release：`https://github.com/microsoft/vscode/releases/latest`
- Raw：`https://github.com/microsoft/vscode/blob/main/package.json`
- 仓库：`microsoft/vscode`

---

## 控制台配置清单

| 项 | 必须 | 配置要点 |
|----|------|----------|
| **触发规则** | ✅ | 域名 + 全路径 `^/`，优先级置前；站点上限 200 条 |
| **环境变量** | ✅（至少 `ACCESS_KEY`） | `ACCESS_KEY` / `GITHUB_TOKEN` 用 **Secret** 类型 |
| **HTTPS 证书** | ✅ | `Secure` Cookie 只在 https 下下发 |
| **缓存规则** | 建议 | 代码已发 `no-store`；若另配规则，排除 `/__auth`、`/__logout` |
| **CORS** | 不建议 | 函数已返回 `Access-Control-Allow-Origin`，重复添加会让浏览器报错 |
| **速率限制** | 可选 | 对 `/__auth` 做单 IP 限频，抵御密码爆破 |

---

## 环境变量

EdgeOne 边缘函数的环境变量是**运行时注入的全局对象 `env`**，不是函数参数，也不是 `process.env`：

```js
// 正确
const key = env.ACCESS_KEY;

// 错误：这两个都是 Cloudflare / Pages 的写法
// context.env.ACCESS_KEY
// process.env.ACCESS_KEY
```

| 变量名 | 默认 | 说明 |
|--------|------|------|
| `GITHUB_TOKEN` | 空 | GitHub PAT（`public_repo`），API 配额 60 → 5000 次/小时 |
| `ACCESS_KEY` | 空 | 访问密码，**主开关**；为空则校验关闭 |
| `ACCESS_PASSWORD` | 空 | 别名，两者都配时优先 `ACCESS_KEY` |
| `SESSION_TTL` | `604800` | 免验证时长（秒），范围 300–2592000 |

> 变量名只能包含大小写字母、数字和 `@ . - ,`；Secret 类型创建后不可再查看或编辑。

---

## 接口说明

| 路径 | 方法 | 参数 | 返回 |
|------|------|------|------|
| `/` | GET | — | 下载页面 |
| `/api/release` | GET | `url` Release 链接 | `{ success, repo, tag, assets[] }` |
| `/api/raw` | GET | `url` blob 链接 | `{ success, filename, url }` |
| `/api/repo` | GET | `name` = `owner/repo` | `{ success, repo, branch, url }` |
| `/proxy` | GET / HEAD | `url` 目标地址 | 文件流（支持 `Range`） |
| `/__auth` | GET / POST | 表单 `pw` | 验证页 / 302 带 Cookie |
| `/__logout` | GET | — | 302 清 Cookie |

`/proxy` 仅允许以下域名及其子域：

```
github.com
raw.githubusercontent.com
objects.githubusercontent.com
github-releases.githubusercontent.com
codeload.github.com
github-production-release-asset-2e65be.s3.amazonaws.com
```

### 非浏览器客户端

```bash
# 请求头（推荐）
curl -H "X-Access-Key: 你的密钥" "https://你的域名/api/repo?name=microsoft/vscode"

# 标准 Bearer
curl -H "Authorization: Bearer 你的密钥" "https://你的域名/api/repo?name=microsoft/vscode"

# 查询参数（给只能填链接的下载器）
https://你的域名/proxy?url=https%3A%2F%2F...&key=你的密钥
```

---

## 下载器接入

下载器不共享浏览器 Cookie，二选一：

```bash
# 链接追加 key
https://你的域名/proxy?url=...&key=你的密钥

# 或设置请求头
X-Access-Key: 你的密钥
```

---

## 与 Cloudflare 版的差异

| 项目 | Cloudflare Worker | 本版本 |
|------|-------------------|--------|
| 入口 | `export default { fetch(request, env) }` | `addEventListener('fetch', e => e.respondWith(...))`，必须同步调用 |
| 环境变量 | 函数第二参数 `env` | 运行时全局 `env` |
| Cookie 下发 | `headers['Set-Cookie']` | `Headers.append('Set-Cookie', ...)`，一个响应只发一条 |
| base64 | `btoa` | 手写 base64url（更稳） |
| 上游压缩 | 原样透传为主 | 主动请求 `identity` 并剥离压缩头 |
| 中文文件名 | 直接写头部 | RFC 5987 `filename*=UTF-8''` |

完整的迁移对照与控制台细节见 [`MIGRATION.md`](./MIGRATION.md)。

---

## 运行限制

| 项目 | 限制 | 影响 |
|------|------|------|
| CPU 时间 | 200 ms / 次 | 本工具只做一次 HMAC + 路由，远低于上限 |
| 运行内存 | 128 MB | `/proxy` 流式转发，不整包加载 |
| 请求 body | 1 MB | 只用于登录表单，足够 |
| 代码包 | 5 MB | 单文件约 36 KB |
| 循环次数 | 100000 次 | 仅遍历附件列表，不会触发 |
| 函数数量 | 100 个 / 站点 | 本工具 1 个 |
| 触发规则 | 200 条 / 站点 | 本工具 1 条 |

---

## 自测清单

```bash
# 1. 未验证 → 401
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/api/repo

# 2. 错误密钥 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d "pw=wrong" https://你的域名/__auth

# 3. 正确密钥 → 302 + Set-Cookie
curl -s -D - -o /dev/null -X POST -d "pw=密钥" https://你的域名/__auth | grep -i "set-cookie\|location"

# 4. 带 Cookie 访问 → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Cookie: gh_acc_auth=..." https://你的域名/

# 5. 断点续传 → 206
curl -s -D - -o /dev/null -H "Cookie: gh_acc_auth=..." -H "Range: bytes=0-99" \
  "https://你的域名/proxy?url=<encodeURIComponent 后的地址>" | grep -i "206\|content-range"
```

浏览器侧：验证一次后刷新、切路径、点下载都不再弹验证页；点「退出」回到验证页。

---

## 常见问题

<details>
<summary><b>函数改了不生效？</b></summary>
EdgeOne 的代码与环境变量都需要手动点 <b>部署</b>；只保存不部署仍跑旧版本。
</details>

<details>
<summary><b>登录成功却一直回到验证页？</b></summary>
依次排查：① 响应是否带 <code>Set-Cookie</code>（响应头改写规则可能删掉）；② 是否 HTTPS 访问；③ 是否换了域名；④ 是否刚改过 <code>ACCESS_KEY</code>。
</details>

<details>
<summary><b>打开页面是 404 / 落到源站？</b></summary>
说明请求没命中触发规则。检查规则是否匹配「全部路径」、优先级是否被其它规则抢先，以及函数是否已部署。
</details>

<details>
<summary><b>下载文件损坏？</b></summary>
多为压缩头冲突。本代码已请求 <code>identity</code> 并剥离 <code>Content-Encoding</code>；若站点另开了智能压缩，请对 <code>/proxy</code> 排除。
</details>

<details>
<summary><b>能改成 EdgeOne Pages 部署吗？</b></summary>
可以。删掉 <code>addEventListener</code> 三行，文件放 <code>functions/[[default]].js</code>，入口换成：

<pre><code>export async function onRequest(context) {
  return await handleRequest(context.request, context.env);
}</code></pre>
</details>

<details>
<summary><b>能下载私有仓库吗？</b></summary>
不能，仅支持公开仓库。
</details>

---

## 免责声明

本工具仅用于学习研究用途，请遵守 GitHub 服务条款及相关法律法规。不得用于下载侵权或违法内容。

代理仅放行 GitHub 相关域名，不提供任意网址转发能力。

---

## 许可证

[MIT](LICENSE)

---

**Powered by EdgeOne Edge Functions**
