# dsh-web-remote-access

<p align="center">
  <strong>让 DeepSeek Harness(dsh)Web UI 支持远程访问,并用访问令牌做访问控制</strong>
  <br />
  <sub>不改动 harness 源码,全部通过 bundle 插件实现</sub>
</p>

<p align="center">
  <a href="https://github.com/studyzy/dsh-web-remote-access/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node.js >= 18"></a>
  <a href="https://github.com/studyzy/dsh-web-remote-access/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/studyzy/dsh-web-remote-access/ci.yml" alt="CI"></a>
  <a href="https://github.com/studyzy/dsh-web-remote-access"><img src="https://img.shields.io/github/stars/studyzy/dsh-web-remote-access" alt="GitHub stars"></a>
</p>

一个开箱即用的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件:解锁 `dsh web` 的远程访问能力(`--host 0.0.0.0`),并让 Web UI **始终**处于访问令牌(web token)保护之下——页面、`/api` RPC、WebSocket 下行全部在门卫之后。

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

- 🔓 **远程访问**:`--host 0.0.0.0` 可用,且**始终有令牌保护**——对外暴露的服务绝不会无认证运行。
- 🛡️ **全表面门卫**:所有请求(页面、`/api` RPC、WebSocket 下行)都经过 web token 门卫:
  1. 首次打开 `http://<host>:<port>/?web_token=<token>` → 服务器 302 跳转到干净路径,并下发会话 Cookie(`dsh_web_token`,`HttpOnly`, `SameSite=Lax`,浏览器关闭即失效)。
  2. 之后请求携带 Cookie 正常访问,直到浏览器关闭。
- 🔑 **令牌永远存在**:解析顺序 `--web_token` → 环境变量 `$DSH_WEB_TOKEN` → 启动时随机生成的令牌。
- 🖨️ **一键直达**:启动时打印可直接打开的 URL(含 `?web_token=`),绑定所有网卡时还会打印 LAN 地址。
- ⏱️ **常数时间比较**:令牌校验使用 `sha256` + `timingSafeEqual`,不泄漏令牌长度与内容。
- 📱 **PWA 兼容**:`/manifest.webmanifest` 豁免令牌,安装检测不受影响。
- 🌐 **配置平面远程可达**:通过令牌认证的 `/api` 请求以回环权威呈现给下游信任围栏,使 `settings.*`、`credentials.*`、`agentPreset.*`、`host.*`、`llm.discoverModels` 等特权方法可远程访问。
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
dsh --profile web --host 0.0.0.0 --web_token <token>     # 远程,固定令牌
DSH_WEB_TOKEN=<token> dsh --profile web --host 0.0.0.0    # 远程,令牌来自环境变量
dsh --profile web --host 0.0.0.0                          # 远程,随机令牌(打印在 URL 里)
dsh --profile web                                        # 回环,随机令牌(打印在 URL 里)
```

启动后终端会打印类似这样的 URL(可直接打开):

```
dsh web: http://127.0.0.1:3080/?web_token=<token> (LAN: http://192.168.1.5:3080/?web_token=<token>)
```

### CLI 选项

| 选项 | 说明 |
|---|---|
| `--host <host>` | 绑定地址。`0.0.0.0` 表示所有网卡;默认 `127.0.0.1` |
| `--port <port>` | 监听端口;传 `0` 由操作系统分配空闲端口。默认 `3080` |
| `--no-open` | 启动后不在默认浏览器中打开 Web UI(无头服务器常用) |
| `--trusted-host <authority...>` | 额外信任的权威(host 或 host:port,可重复),用于 `/api` 浏览器信任围栏 |
| `--web_token <token>` | 访问令牌;缺省时回退到 `$DSH_WEB_TOKEN`,再回退到启动时随机生成的令牌 |

### 环境变量

| 变量 | 说明 |
|---|---|
| `DSH_WEB_TOKEN` | 未指定 `--web_token` 时使用的令牌 |

## 工作原理

`@studyzy/dsh-web-remote-access` 是一个 dsh **bundle**(patch 层):禁用 web-app 的若干行,挂载本包自己的插件。

| 行 | 替换为 | 作用 |
|---|---|---|
| `web-startup` | `@studyzy/dsh-web-remote-access/startup` | fork `@deepseek-ai/dsh-web-app/startup`,新增 `--web_token`、`$DSH_WEB_TOKEN`、随机令牌兜底;提供同名 `webStartup` 服务,并带一个**始终存在**的 `webToken` |
| `webserver` | `@studyzy/dsh-web-remote-access/webserver` | fork `@deepseek-ai/dsh-host-webserver`,保持 `ctx.webServer` 契约不变,增加:路由匹配前的令牌门卫(含升级路径)、manifest 豁免、对已认证 `/api` 请求的回环呈现 |
| `web-runtime` 打印 | `@studyzy/dsh-web-remote-access/url` | 打印带 `?web_token=` 的 URL 行 |
| —(新增行) | `@studyzy/dsh-web-remote-access/polyfill` | 向 index.html 注入 `crypto.randomUUID` polyfill(非安全上下文支持) |
| —(新增行) | `@studyzy/dsh-web-remote-access/loopback` | 向 index.html 注入脚本,让已认证的远程浏览器以回环视图呈现(见下方"安全说明") |

令牌解析为 `--web_token` → `$DSH_WEB_TOKEN` → 启动时随机生成,因此门卫始终开启,打印的 URL 始终能直接打开。绑定所有网卡时,`/api` 信任围栏推导出的 LAN IP 字面量也就是打印的 LAN URL 所用的地址。

### 请求流程

```
浏览器首次访问 http://host:port/?web_token=<token>
  └─> 门卫校验 query token
       ├─ 匹配 → 302 跳转到干净路径 + 下发 dsh_web_token 会话 Cookie
       └─ 不匹配 → 401
浏览器携带 Cookie 访问(页面 / /api / WebSocket 升级)
  └─> 门卫校验 Cookie
       ├─ 匹配 → 放行到路由匹配
       └─ 不匹配 → 401(升级路径同样 401,而非裸 socket 关闭)
```

## 安全说明

- **无 TLS、无账号体系**。这是纯 HTTP 上的共享密钥门卫,与 harness 面向开发的定位一致;除可信网络外,请用真正的反向代理前置 `dsh web` 终结 TLS。
- 令牌首次打开时出现在地址栏/历史记录里,重定向后会从地址栏清除。
- 令牌比较为常数时间(`sha256` + `timingSafeEqual`)。
- `/manifest.webmanifest`(仅 GET/HEAD)不要求令牌:浏览器抓取 PWA manifest 时不带会话 Cookie,而该文件是随 dist 发布的公开静态元数据,拦住它只会 401 安装检测,没有任何安全收益。其余(应用、`/api`、升级路径)全部保持门卫。
- 页面会注入基于 `crypto.getRandomValues` 的 `crypto.randomUUID` polyfill:`crypto.randomUUID` 仅在安全上下文可用,在 LAN IP 上的纯 HTTP 里是 `undefined`,会导致客户端 RPC 发号崩溃、WebSocket 就绪握手失败("WebSocket is closed before the connection is established")。polyfill 在回环/HTTPS 下自动空操作。
- 通过令牌认证的 `/api` 请求会以回环权威(Host/Origin 在 Cookie 校验通过后改写)呈现给下游信任围栏。harness 把特权方法(`settings.*`、`credentials.*`、`agentPreset.*`、`host.*`、`llm.discoverModels`)钉在回环上"直到出现真正的认证层"——令牌门卫就是那层认证,因此配置平面可远程访问。门卫仍只放行带 Cookie 的同源客户端,非 `/api` 路径不受影响。
- 客户端侧的对应面:harness 的 `connection.isLoopback` 完全由页面 `location.hostname` 决定,LAN IP 下为 `false`,设置界面因此落入进程内 "memory" 作用域,模型/插件页报 "settings are unavailable in this browser"。本包在令牌门禁启用时向 index.html 注入脚本,在 `@deepseek-ai/dsh-client-connection` 提供 `connection` 服务时将其 `isLoopback` 置为 `true`,让已认证的远程浏览器呈现与回环访问一致的设置体验(模型页、插件页、设置文档编辑、交付物"打开文件"等)。这不会扩大信任面:页面只会在令牌门卫放行后才被渲染,且服务端 `/api` 信任围栏仍独立生效。
- 已知限制:`DSH_WEB_URL` 与 web-surface 模型提示仍是无令牌的回环 URL;本 bundle 不提供带令牌的模型侧 URL。

## 项目结构

```
src/
  index.ts        # 包入口,导出启动服务的类型与常量
  startup.ts      # fork @deepseek-ai/dsh-web-app/startup:解析 --host/--port/--trusted-host/--web_token
  webserver.ts    # fork @deepseek-ai/dsh-host-webserver:令牌门卫 + /api 回环呈现
  url.ts          # 打印带 ?web_token= 的 URL 行(本地 + LAN)
  polyfill.ts     # 向 index.html 注入 crypto.randomUUID polyfill
  loopback.ts     # 向 index.html 注入脚本,远程浏览器呈现回环视图(isLoopback)
tests/            # vitest:fork 契约 + 门卫行为
cordis.patch.yml  # dsh bundle patch 层
```

## 开发

```sh
pnpm install
pnpm test       # vitest:fork 契约 + 门卫行为
pnpm test:e2e   # 浏览器 e2e:在真实 dsh CLI(隔离 $DSH_HOME)上验证令牌门卫与 WebUI 启动;经由局域网 IP 访问以覆盖 polyfill(需全局 dsh;CI 每天对最新 dsh 跑)
pnpm test:e2e:local   # 浏览器 e2e:复用本地 ~/.dsh 的 web profile,把当前源码链接进去,同样经由局域网 IP 验证(仅本机,不入 CI)
pnpm build      # tsc -> lib/(ESM)
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 常见问题 (FAQ)

### 1. 忘记令牌怎么办?

- 启动日志里打印的 URL 自带 `?web_token=`,直接点开即可。
- 固定令牌:用 `--web_token <token>` 或环境变量 `DSH_WEB_TOKEN` 指定。

### 2. 浏览器打开提示 401?

- 检查是否首次访问:`http://<host>:<port>/?web_token=<token>`(带 query),成功后跳转到干净路径。
- 检查 Cookie 是否被浏览器拦截/清理:会话 Cookie 在浏览器关闭后失效,需重新用带 `?web_token=` 的 URL 打开。

### 3. 如何更换/吊销令牌?

- 重启服务并更换 `--web_token`(或环境变量)即可;旧令牌与所有已授权会话一并失效。

### 4. 可以不用令牌吗?

- 不可以,这是设计使然:令牌**永远存在**(随机令牌兜底),保证对外暴露的服务绝不无认证运行。若仅需回环访问,直接 `dsh --profile web` 即可,随机令牌只影响 URL 打印,不影响使用。

### 5. 和反代(如 Nginx/Caddy)怎么配合?

- 推荐:反代终结 TLS 后转发到 `dsh --profile web --host 127.0.0.1`(回环绑定),令牌门卫照常生效;也可让反代自己处理认证。详见 [SECURITY.md](SECURITY.md)。

### 6. 为什么 WebSocket 一直连不上?

- 最常见原因:纯 HTTP 的 LAN 访问缺少 `crypto.randomUUID`。本插件已注入 polyfill,请确认用的是本插件的 `web` profile;若仍失败,检查浏览器控制台错误与令牌 Cookie。

## Fork 来源与兼容性

`src/webserver.ts` 与 `src/startup.ts` 分别 fork 自 `@deepseek-ai/dsh-host-webserver` 与 `@deepseek-ai/dsh-web-app/startup`(基于 `0.1.0-rc.7`,cordis `4.0.1`,schemastery `3.18.1`)。需跟随上游演进;harness 自身测试不覆盖它们——由本包的 `tests/` 覆盖。

## 贡献

欢迎提交 issue 与 PR!请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 的私有渠道报告。

## 许可证

[MIT](LICENSE) © studyzy
