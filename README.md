# GitHub 加速下载 - EdgeOne 边缘函数版

基于 **腾讯云 EdgeOne 边缘函数（Edge Functions）** 的 GitHub 资源加速下载工具。

通过 EdgeOne 全球边缘节点代理 Release 附件、Raw 文件和仓库源码，提升国内下载速度；内置访问密钥保护，未验证的访客连首页都看不到。

> 本仓库是 Cloudflare Worker 版的独立移植版本，功能一一对应：密钥鉴权、三类查询接口、`/proxy` 流式转发、Range 断点续传、域名白名单、内置前端页面。

---

## 目录

- [功能特性](#功能特性)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [获取 API 密钥](#获取-api-密钥)
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

函数详情页底部 **环境变量与密钥 → 快速添加**。

> 这两个值怎么来？见 [获取 API 密钥](#获取-api-密钥)。


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

## 获取 API 密钥

这里有两个「密钥」，来源完全不同：**GitHub Token 要去 GitHub 申请**，**访问密钥是你自己定的密码**。

### 一、GITHUB_TOKEN（向 GitHub 申请）

作用：把 GitHub API 配额从 **60 次/小时** 提到 **5000 次/小时**。不配也能用，但容易限流。

#### 方式 A：Classic Token（最简单）

1. 登录 GitHub → 右上角头像 → **Settings**
2. 左侧菜单最下方 → **Developer settings**
3. **Personal access tokens** → **Tokens (classic)**
4. 右上角 **Generate new token** → **Generate new token (classic)**
5. 按下面填写：

   | 字段 | 填什么 |
   |------|--------|
   | **Note** | `github-accelerator`（随便起，方便日后识别） |
   | **Expiration** | `No expiration`（或 90 天，到期需更换） |
   | **Scopes** | 只勾 `public_repo`（读取公开仓库） |

6. 拉到页面底部 → **Generate token**
7. 复制 `ghp_xxxxxxxxxxxx` —— **只显示这一次**，关掉页面就再也看不到

#### 方式 B：Fine-grained Token（更安全，可限定只读）

1. 同样进入 **Settings → Developer settings**
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. **Repository access**：选 `Public repositories (read-only)`
4. **Permissions → Repository permissions**：把 `Contents` 设为 `Read-only`（`Metadata` 会自动带只读）
5. 生成并复制 `github_pat_xxxxxxxxxxxx`

> 本工具只读取 GitHub 公开资源，方式 B 的只读权限已经够用，泄露风险也更小。

#### 验证 Token 是否有效

```bash
curl -s -H "Authorization: token 你的token" https://api.github.com/rate_limit \
  | grep -o '"limit":[0-9]*' | head -1
```

- 返回 `"limit":5000` → Token 生效
- 返回 401 / `Bad credentials` → 复制不完整或权限不对

#### 安全提醒

- Token 等同账号权限，**不要**写进代码里的 `USER_TOKEN` 再提交仓库
- 只放在平台的环境变量里（类型选「密钥 / Secret」）
- 一旦怀疑泄露：GitHub → Settings → Tokens 里立刻 **Revoke**

### 二、ACCESS_KEY（自己定，不需要申请）

访问密钥就是你自己想的一个密码，站点靠它判断「这个访客能不能看首页」，没有任何地方需要申请。

生成一个足够随机的字符串：

```bash
# Linux / macOS
openssl rand -base64 24

# 有 Node 的环境
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

要求与建议：

| 项 | 建议 |
|----|------|
| 长度 | ≥ 16 位 |
| 组成 | 字母 + 数字 + 符号混合，不要用生日、手机号、`123456` |
| 保存 | 记进密码管理器 |
| 更换 | 丢了不用找回，直接在控制台改成新的即可 |
| 影响 | 修改后所有已登录浏览器立刻失效，需要重新验证 |
| 禁止 | 不要写进代码里的 `USER_ACCESS_KEY` 并提交仓库 |

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

### 部署与触发规则

<details>
<summary><b>改了代码不生效？</b></summary>
EdgeOne 的代码和变量都要手动点 <b>部署</b>；只保存仍跑旧版本。
</details>

<details>
<summary><b>打开是 404 或落到源站？</b></summary>
说明未命中触发规则：检查规则是否匹配「全部路径」、优先级是否被其它规则抢先、函数是否已部署。
</details>

<details>
<summary><b>触发规则只写 <code>/</code> 会怎样？</b></summary>
<code>/api/*</code> 和 <code>/proxy</code> 不会进函数，密钥校验被绕过。必须匹配 <code>^/</code> 全部路径。
</details>

<details>
<summary><b>没有源站可以用吗？</b></summary>
可以。函数命中后直接响应、不回源，源站地址可留占位；但站点本身必须完成域名接入。
</details>

<details>
<summary><b>怎么快速调试？</b></summary>
函数详情页的「Web 调试」可直接发起请求看响应；先用它验证 401 与验证页，再配域名。
</details>

### 环境变量

<details>
<summary><b>环境变量在哪里配置？</b></summary>
函数详情页底部 <b>环境变量与密钥</b> → 快速添加；<code>ACCESS_KEY</code>、<code>GITHUB_TOKEN</code> 选 <b>Secret</b>，<code>SESSION_TTL</code> 选 String。
</details>

<details>
<summary><b>代码里写 <code>context.env</code> 报错？</b></summary>
边缘函数的变量是运行时全局 <code>env</code>，直接 <code>env.ACCESS_KEY</code>；<code>context.env</code> 是 Pages 的写法，<code>process.env</code> 不可用。
</details>

<details>
<summary><b>变量名提示非法？</b></summary>
只能包含大小写字母、数字和 <code>@ . - ,</code>，长度 1–64；创建后不可改名。
</details>

<details>
<summary><b>Secret 类型添加后看不到值？</b></summary>
Secret 创建后不可查看、不可编辑，只能删除重建。注意保存，保存后再点 <b>部署</b>。
</details>

<details>
<summary><b>改了变量还是旧值？</b></summary>
环境变量的变更也要点一次 <b>部署</b> 才生效。
</details>

### 密钥与登录

<details>
<summary><b>GitHub Token 在哪里申请？</b></summary>
见上文 <a href="#获取-api-密钥">获取 API 密钥</a>，含 Classic / Fine-grained 两种方式与验证命令。
</details>

<details>
<summary><b>登录成功却回到验证页？</b></summary>
① 响应是否带 <code>Set-Cookie</code>（响应头改写规则可能删掉）；② 是否 HTTPS；③ 是否换了域名；④ 刚改过 <code>ACCESS_KEY</code>。
</details>

<details>
<summary><b>忘记密钥了？</b></summary>
直接改 <code>ACCESS_KEY</code> 并部署，不需要旧密钥。
</details>

<details>
<summary><b>下载器提示要密码？</b></summary>
链接追加 <code>&amp;key=密钥</code>，或设置请求头 <code>X-Access-Key: 密钥</code>。
</details>

### 下载与代理

<details>
<summary><b>下载文件损坏？</b></summary>
多为压缩头冲突。本代码已请求 <code>identity</code> 并剥离 <code>Content-Encoding</code>；若站点开了智能压缩，请对 <code>/proxy</code> 排除。
</details>

<details>
<summary><b>中文文件名乱码？</b></summary>
已按 RFC 5987 输出 <code>filename*=UTF-8''...</code>；仍乱码检查是否有规则改写了 <code>Content-Disposition</code>。
</details>

<details>
<summary><b>断点续传不生效？</b></summary>
客户端需发 <code>Range</code>，上游需返回 206。用 <code>curl -H "Range: bytes=0-99"</code> 自测 <code>Content-Range</code>。
</details>

<details>
<summary><b>大文件会超时吗？</b></summary>
不会，<code>/proxy</code> 流式转发，不占函数内存，也不受请求 body 1MB 限制（那是入站请求）。
</details>

<details>
<summary><b>报 403 Forbidden？</b></summary>
目标域名不在白名单；只放行 GitHub 相关域名。
</details>

<details>
<summary><b>报 502 Proxy error？</b></summary>
上游不可达或被限流，稍后重试；可配置 Token 提升配额。
</details>

### 限制与替代方案

<details>
<summary><b>CPU 200ms 会不会不够？</b></summary>
本工具只做一次 HMAC 签名 + 路由判断，CPU 占用在毫秒级；下载耗时属于 I/O，不计入 CPU。
</details>

<details>
<summary><b>代码包会不会超 5MB？</b></summary>
单文件约 36KB，远低于上限。
</details>

<details>
<summary><b>能改成 EdgeOne Pages 部署吗？</b></summary>
可以：删掉 <code>addEventListener</code> 三行，文件放 <code>functions/[[default]].js</code>，入口改为 <code>export async function onRequest(context) { return await handleRequest(context.request, context.env); }</code>。
</details>

## 免责声明

**最后更新：2026 年 11 月**

请在使用本项目（以下简称「本工具」）前完整阅读本声明。下载、部署、访问或以任何方式使用本工具，即视为你已阅读、理解并同意以下全部条款；如不同意，请立即停止使用并删除已部署的实例。

### 一、性质与用途

1. 本工具是一个**开源技术示例**，仅用于学习研究、技术交流与个人自用，不构成任何商业服务或产品。
2. 本工具与 GitHub、Cloudflare、腾讯云及其关联公司**没有任何隶属、合作、赞助或背书关系**，相关名称与商标归其各自权利人所有。
3. 本工具不提供、不托管、不缓存、不修改任何文件内容，仅对用户指定的 GitHub 公开资源做请求转发；文件的版权与许可归原作者或原项目所有。

### 二、禁止用途

使用者承诺**不**将本工具用于下列用途，否则后果自负：

1. 下载、传播侵权、盗版、违法或违反公序良俗的内容；
2. 规避付费、授权、地域限制或任何访问控制机制；
3. 对 GitHub、Cloudflare、腾讯云或任何第三方发起攻击、扫描、压测、爬取或滥用；
4. 违反 GitHub 服务条款、平台方政策或使用者所在地法律法规的行为；
5. 将本工具包装为商业服务对外售卖、代充或作为收费产品的核心能力；
6. 任何可能损害他人合法权益或公共利益的行为。

### 三、第三方服务

1. 本工具依赖 GitHub REST API 与第三方 CDN / 边缘计算平台运行，其可用性、限流策略、计费规则由对应服务商决定并可随时变更。
2. 使用本工具即表示你同时受 GitHub 服务条款、Cloudflare 服务条款或腾讯云服务协议约束；因违反上述条款导致的封禁、限流、扣费或法律责任，由使用者自行承担。
3. 本工具不保证任何第三方接口的长期可用性；接口变更、下线或鉴权调整可能导致功能失效。

### 四、数据、日志与隐私

1. 本工具**不主动收集、不上传、不存储**使用者的个人信息；访问密钥仅以 HMAC 签名 Cookie 的形式存在于浏览器，服务端不落库、不写日志。
2. 请求仍会经过 CDN / 边缘平台，平台方可能按其隐私政策记录访问日志（IP、UA、URL 等）；此类日志不由本工具控制。
3. 通过 `?key=` 方式传递密钥时，密钥可能出现在 URL、浏览器历史与访问日志中，请自行评估风险并优先使用请求头方式。
4. 本工具不设置任何统计、追踪或广告代码。

### 五、密钥与账号安全

1. GitHub Token、访问密钥（ACCESS_KEY）由使用者自行申请、设置与保管，本工具不提供找回、托管或代管服务。
2. 因密钥泄露、弱口令、配置错误、将密钥硬编码进公开仓库等造成的未授权访问、配额消耗或数据损失，由使用者自行承担。
3. 建议定期轮换密钥，并在怀疑泄露时立即撤销 GitHub Token、修改 ACCESS_KEY 并重新部署。

### 六、服务可用性与责任限制

1. 本工具按**「现状」（AS IS）**提供，不附带任何明示或默示的担保，包括但不限于适销性、特定用途适用性与不侵权担保。
2. 作者不对下列情形承担任何责任：服务中断、下载失败、文件损坏、速度不达预期、配额耗尽、平台封禁、数据丢失或任何间接、附带、特殊、惩罚性损害。
3. 在任何情况下，作者对使用者承担的全部责任总额不超过使用者为本工具实际支付的费用（本工具免费，故为零）。
4. 使用者应自行评估部署与使用的风险，包括但不限于平台费用、合规成本与业务影响。

### 七、合规提示

1. 在中国大陆境内以公开域名提供网站服务，通常需要完成 ICP 备案并遵守《网络安全法》《数据安全法》《个人信息保护法》等相关规定；备案与合规义务由部署者自行承担。
2. 使用者不得利用本工具从事危害网络安全、规避网络监管或其他违法违规活动。
3. 本工具不提供任何规避地域限制或审查的能力，也不应被用于此类目的。

### 八、投诉与处理

1. 若权利人认为经本工具转发的某些内容侵犯其合法权益，可通过仓库 Issue 或邮件联系维护者，并提供权属证明与具体链接。
2. 维护者将在核实后**合理时间内**处理，包括但不限于移除相关示例、限制默认白名单或更新文档说明。
3. 本工具本身不存储内容，删除仓库或停止部署即可终止转发行为。

### 九、声明变更

1. 维护者保留随时修改本声明的权利，修改后随代码一同发布，不再单独通知。
2. 变更发布后继续使用本工具，视为接受修改后的条款。
3. 本声明与仓库中的 `LICENSE`（MIT）共同适用；如两者存在冲突，以更严格者为准。

### 十、其他

1. 本声明不构成法律意见；如需合规评估，请咨询具备资质的专业律师。
2. 若本声明中的任何条款被认定为无效或不可执行，不影响其余条款的效力。
3. 本声明的解释与适用，以使用者所在地法律及所依赖平台的服务条款为准。

---

> ⚠️ **再次提醒**：本工具仅用于学习研究用途。请遵守 GitHub 服务条款及相关法律法规，不得用于下载侵权或违法内容。使用即表示你已理解并接受上述全部条款与风险。

## 许可证

[MIT](LICENSE)

---

**Powered by EdgeOne Edge Functions**
