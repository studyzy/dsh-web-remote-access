# dsh-web-remote-access

<p align="center">
  <strong>让 DeepSeek Harness(dsh)Web UI 支持远程访问</strong>
  <br />
  <sub>不改动 harness 源码,全部通过 bundle 插件实现;访问控制沿用 harness 自身的会话令牌</sub>
</p>

<p align="center">
  <a href="https://github.com/studyzy/dsh-web-remote-access/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node.js >= 18"></a>
  <a href="https://github.com/studyzy/dsh-web-remote-access/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/studyzy/dsh-web-remote-access/ci.yml" alt="CI"></a>
  <a href="https://github.com/studyzy/dsh-web-remote-access"><img src="https://img.shields.io/github/stars/studyzy/dsh-web-remote-access" alt="GitHub stars"></a>
</p>

一个开箱即用的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件:解锁 `dsh web` 的远程访问能力(`--host 0.0.0.0`)。上游出于安全考虑直接拒绝通配绑定(会把远程代码执行能力暴露到网络上),本插件把 `0.0.0.0` 解析成**本机的具体网卡地址**再绑定,远程浏览器仍由 harness 自己的会话令牌(`?token=` 换取的 Cookie)把关——页面、`/api` RPC、WebSocket 下行全部在门禁之后。

> 开源项目:[github.com/studyzy/dsh-web-remote-access](https://github.com/studyzy/dsh-web-remote-access) · MIT 协议

---

## 目录

- [特性](#特性)
- [安装](#安装)
- [用法](#用法)
- [工作原理](#工作原理)
- [安全说明](#安全说明)
- [项目结构](#项目结构)
- [开发](#开发)
- [常见问题](#常见问题-faq)
- [Fork 来源与兼容性](#fork-来源与兼容性)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 特性

- 🔓 **远程访问**:`--host 0.0.0.0` 可用——本插件把它解析为本机第一个非内部 IPv4 地址再绑定,绕过上游对通配绑定的拒绝。
- 🛡️ **门禁沿用 harness**:远程浏览器必须持有 harness 的会话 Cookie,该 Cookie 由打印 URL 里的 `?token=`(启动令牌)换取,页面、`/api` RPC、WebSocket 下行全部在门禁之后,凭 Cookie 才能访问。
- 🖨️ **一键直达**:启动时直接打印绑定到的地址和可直接打开的 URL(只含一个 `?token=`):`dsh web: http://192.168.1.5:3080/?token=...`。
- 🌐 **配置平面远程可达**:绑定地址即权威,harness 的 `/api` 信任围栏天然接受它,`settings.*`、`credentials.*`、`pluginInventory.*`、`host.*`、`llm.discoverModels` 等方法在远程浏览器上正常可用;经域名访问时用 `--trusted-host <域名>` 追加。
- 🔧 **非安全上下文兜底**:注入 `crypto.randomUUID` polyfill——LAN IP 上的纯 HTTP 是非安全上下文,该 API 为 `undefined`,会导致客户端发号崩溃、WebSocket 就绪握手失败。
- 🧩 **零源码改动**:不改动 harness 源码,全部通过 bundle 插件(patch 层)实现;卸载插件即可完全还原默认行为。
- 🧩 **零源码改动**:不改动 harness 源码,全部通过 bundle 插件(patch 层)实现;卸载插件即可完全还原默认行为。

## 安装

需要 [dsh](https://github.com/deepseek-ai/deepseek-harness) 环境。安装为 `web` profile 的插件:

```sh
# 从 GitHub 安装(推荐,免构建)
dsh plugin --profile web add git@github.com:studyzy/dsh-web-remote-access.git

# 或 HTTPS
dsh plugin --profile web add https://github.com/studyzy/dsh-web-remote-access.git

# 从 npm 安装(需已发布)
dsh plugin --profile web add @studyzy/dsh-web-remote-access

# 本地源码安装(开发用)
dsh plugin --profile web add /path/to/dsh-web-remote-access
```

安装后 profile 层叠顺序变为 `dsh-base` → `dsh-web-app` → `@studyzy/dsh-web-remote-access`。

卸载:

```sh
dsh plugin --profile web remove @studyzy/dsh-web-remote-access
```

即可完全还原默认行为。

## 用法

```sh
dsh --profile web --host 0.0.0.0      # 远程:绑定到本机第一个 LAN 地址,打印带 ?token= 的 URL
dsh --profile web --host 10.0.0.7     # 远程:绑定到指定的网卡地址
dsh --profile web                     # 回环:仅本机可访问
```

启动后终端会打印类似这样的 URL(可直接打开,打开后地址栏会回到干净的 `/`):

```
dsh web: http://192.168.1.5:3080/?token=<harness 启动令牌>
```

远程浏览器必须走这个 URL(或已持有会话 Cookie),否则页面与 `/api` 一律 401。

### CLI 选项

| 选项 | 说明 |
|---|---|
| `--host <host>` | 绑定地址。`0.0.0.0` 会被解析为本机第一个非内部 IPv4 地址;也可直接写具体地址(如 `10.0.0.7`);默认 `127.0.0.1` |
| `--port <port>` | 监听端口;传 `0` 由操作系统分配空闲端口。默认 `3080` |
| `--no-open` | 启动后不在默认浏览器中打开 Web UI(无头服务器常用) |
| `--trusted-host <authority...>` | 额外信任的权威(host 或 host:port,可重复),用于 `/api` 浏览器信任围栏;通过域名而非 LAN IP 访问时需要 |
| `--cookie-max-age-days <days>` | 会话 Cookie 的有效天数(harness 默认 `30`);浏览器按 RFC 6265bis 最多只认 **400 天**,写更大值会被截断 |

## 工作原理

`@studyzy/dsh-web-remote-access` 是一个 dsh **bundle**(patch 层):禁用 web-app 的若干行,挂载本包自己的插件。

| 行 | 替换为 | 作用 |
|---|---|---|
| `web-startup` | `@studyzy/dsh-web-remote-access/startup` | fork `@deepseek-ai/dsh-web-app/startup`:保留 `--host/--port/--no-open/--trusted-host`,但把 `--host 0.0.0.0`(上游直接报错)解析为本机第一个非内部 IPv4 地址;提供同名 `webStartup` 服务,额外给出 `remote` |
| `web-runtime` 打印 | `@studyzy/dsh-web-remote-access/url` | 打印实际绑定到的地址 + harness `?token=` 启动令牌(上游只打印组合出来的 host) |
| —(新增行) | `@studyzy/dsh-web-remote-access/polyfill` | 非回环绑定时向 index.html 注入 `crypto.randomUUID` polyfill |
| —(新增行) | `@studyzy/dsh-web-remote-access/loopback` | 向 index.html 注入脚本,让已认证的远程浏览器以回环视图呈现(当前为排查而停用) |

上游的 `webserver` 行不再被替换:绑定具体地址时它照常工作,`/api` 浏览器信任围栏(`isTrustedApiRequest`)也天然接受"绑定地址"这个权威,所以不需要 fork、也不需要额外声明 LAN 信任。

### 请求流程

```
浏览器首次访问 http://<绑定地址>:<port>/?token=<harness 启动令牌>
  └─> harness 校验启动令牌
       ├─ 匹配 → 303 跳转到干净路径 + 下发 dsh-auth-* 会话 Cookie(默认 30 天)
       └─ 不匹配 → 401("dsh web authentication required; reopen the URL printed by dsh web")
浏览器携带 Cookie 访问(页面 / /api / WebSocket 升级)
  └─> harness 校验 Cookie 的权威绑定 + Host 信任围栏
       ├─ 匹配 → 放行到路由匹配
       └─ 不匹配 → 401(升级路径同样 401,而非裸 socket 关闭);Host 不受信任则 403
```

## 安全说明

- **无 TLS**。远程访问走的是纯 HTTP,与 harness 面向开发的定位一致;除可信网络外,请用真正的反向代理前置 `dsh web` 终结 TLS。
- **访问控制完全由 harness 承担**:远程浏览器必须持有 `dsh-auth-*` 会话 Cookie,它只能由打印 URL 里的启动令牌 `?token=` 换取,Cookie 与权威绑定(载荷 `authority` 必须等于请求 Host),默认 30 天有效(`cookieMaxAgeDays`)。拿到 URL 就等于拿到访问权限,请按密钥对待。
- 上游拒绝 `--host 0.0.0.0` 的理由是"通配绑定会把远程代码执行能力暴露到网络"。本插件把它解析成**具体网卡地址**后绑定,暴露面从"所有接口"收敛到"一个接口",但仍等于把 harness 的执行能力暴露到该网段——只在可信网络使用。
- 页面会注入基于 `crypto.getRandomValues` 的 `crypto.randomUUID` polyfill:`crypto.randomUUID` 仅在安全上下文可用,在 LAN IP 上的纯 HTTP 里是 `undefined`,会导致客户端 RPC 发号崩溃、WebSocket 就绪握手失败("WebSocket is closed before the connection is established")。回环绑定不注入(那里本就是安全上下文)。
- 客户端侧的 `connection.isLoopback` 完全由页面 `location.hostname` 决定,LAN IP 下为 `false`,设置界面因此落入进程内 "memory" 作用域,模型/插件页报 "settings are unavailable in this browser"。本包提供 `loopback` 行把该值置为 `true`,但因与 documentpreview 激活失败相关而暂时停用。
- 已知限制:`DSH_WEB_URL` 与 web-surface 模型提示仍回环地址;绑定单个网卡地址意味着多网卡机器只有该网卡可访问(可用 `--host <另一地址>` 指定)。

## 项目结构

```
src/
  index.ts        # 包入口,导出启动服务的类型与常量
  startup.ts      # fork @deepseek-ai/dsh-web-app/startup:--host 0.0.0.0 → 具体网卡地址
  url.ts          # 打印绑定地址 + harness ?token= 的 URL 行
  polyfill.ts     # 非回环绑定时注入 crypto.randomUUID polyfill
  loopback.ts     # 注入脚本,远程浏览器呈现回环视图(isLoopback;暂未启用)
tests/            # vitest:startup/url/polyfill 行为 + e2e
cordis.patch.yml  # dsh bundle patch 层
```

## 开发

```sh
pnpm install
pnpm test       # vitest:startup/url/polyfill 行为
pnpm test:e2e   # 浏览器 e2e:在真实 dsh CLI(隔离 $DSH_HOME)上验证远程绑定与 WebUI 启动;经由局域网 IP 访问以覆盖 polyfill(需全局 dsh;CI 每天对最新 dsh 跑)
pnpm test:e2e:local   # 浏览器 e2e:复用本地 ~/.dsh 的 web profile,把当前源码链接进去,同样经由局域网 IP 验证(仅本机,不入 CI)
pnpm build      # tsc -> lib/(ESM)
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 常见问题 (FAQ)

### 1. 忘记 URL / 令牌怎么办?

- 启动日志里打印的 URL 自带 harness 的 `?token=`,直接点开即可。
- 令牌是每次启动随机生成的进程令牌,重启即换;想再拿一次就重启服务看新的打印行。

### 2. 浏览器打开提示 401?

- 必须用打印出来的那个 URL 首次打开(`?token=` 换 Cookie),打开后地址栏会回到干净的 `/`。
- 之后靠会话 Cookie(默认 30 天,可用 `--cookie-max-age-days` 调;浏览器上限 400 天)。Cookie 被清理后需用新的打印 URL 重新打开。
- 若通过域名访问(不是 LAN IP),`/api` 会被 Host 信任围栏以 403 拒绝:加 `--trusted-host <域名>`。

### 3. 如何吊销已有的访问?

- 重启服务只换启动令牌;已签发的 `dsh-auth-*` Cookie 在有效期内仍可用(签名密钥是持久化的),要真正吊销请让浏览器清除该站 Cookie,或用 `--cookie-max-age-days 1` 缩短有效期后重启。

### 4. 回环访问还需要令牌吗?

- 需要,但回环打开时 harness 同样要求会话 Cookie——直接打开打印的 URL 即可。只用 `dsh --profile web`(默认 `127.0.0.1`)时不会把服务暴露到网络。

### 5. 和反代(如 Nginx/Caddy)怎么配合?

- 推荐:反代终结 TLS,并把请求转发到绑定具体网卡地址的 `dsh web`;反代需保留 `Host`(或加 `--trusted-host <域名>`),同时把带 `?token=` 的授权 URL 交给终端用户。详见 [SECURITY.md](SECURITY.md)。

### 6. 为什么 WebSocket 一直连不上?

- 最常见原因:纯 HTTP 的 LAN 访问缺少 `crypto.randomUUID`。本插件已注入 polyfill,请确认用的是本插件的 `web` profile;若仍失败,检查浏览器控制台错误与会话 Cookie。

## Fork 来源与兼容性

`src/startup.ts` fork 自 `@deepseek-ai/dsh-web-app/startup`(基于 `0.2.x`,cordis `4.0.1`,schemastery `3.18.1`),唯一分歧是通配绑定的处理。需跟随上游演进;harness 自身测试不覆盖它——由本包的 `tests/` 覆盖。`webserver` 行不再 fork,直接用上游实现。

## 贡献

欢迎提交 issue 与 PR!请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 的私有渠道报告。

## 许可证

[MIT](LICENSE) © studyzy
