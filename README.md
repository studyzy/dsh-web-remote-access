# dsh-web-remote-access

让 [dsh](https://github.com/deepseek-ai/deepseek-harness) Web UI 支持远程访问,并用访问令牌(web token)做访问控制——**不改动 harness 源码**,全部通过 bundle 插件实现。

开源项目:[github.com/studyzy/dsh-web-remote-access](https://github.com/studyzy/dsh-web-remote-access) · MIT 协议

## 功能

- `--host 0.0.0.0` 可用,且**始终有令牌保护**:对外暴露的服务绝不会无认证运行。
- 所有请求(页面、`/api` RPC、WebSocket 下行)都经过 web token 门卫:
  1. 首次打开 `http://<host>:<port>/?web_token=<token>` → 服务器 302 跳转到干净路径,并下发会话 Cookie(`dsh_web_token`, `HttpOnly`, `SameSite=Lax`,浏览器关闭即失效)。
  2. 之后请求携带 Cookie 正常访问,直到浏览器关闭。
- **令牌永远存在**。解析顺序:`--web_token <token>` → 环境变量 `$DSH_WEB_TOKEN` → 启动时随机生成的令牌。
- 启动时打印可直接打开的 URL(含 `?web_token=`),绑定所有网卡时还会打印 LAN 地址。

## 安装

从 GitHub 安装(推荐,免构建):

```sh
# SSH
dsh plugin --profile web add git@github.com:studyzy/dsh-web-remote-access.git

# 或 HTTPS
dsh plugin --profile web add https://github.com/studyzy/dsh-web-remote-access.git
```

本地源码安装(开发用):

```sh
dsh plugin --profile web add /path/to/dsh-web-remote-access
```

profile 层叠顺序变为 `dsh-base` → `dsh-web-app` → `dsh-web-remote-access`。执行 `dsh plugin --profile web remove dsh-web-remote-access` 可完全还原默认行为。

## 用法

```sh
dsh --profile web --host 0.0.0.0 --web_token <token>     # 远程,固定令牌
DSH_WEB_TOKEN=<token> dsh --profile web --host 0.0.0.0    # 远程,令牌来自环境变量
dsh --profile web --host 0.0.0.0                          # 远程,随机令牌(打印在 URL 里)
dsh --profile web                                        # 回环,随机令牌(打印在 URL 里)
```

## 工作原理

bundle 是一个 patch 层:禁用 web-app 的若干行,挂载本包自己的插件:

| 行 | 替换为 | 作用 |
|---|---|---|
| `web-startup` | `dsh-web-remote-access/startup` | fork `@deepseek-ai/dsh-web-app/startup`,新增 `--web_token`、`$DSH_WEB_TOKEN`、随机令牌兜底;提供同名 `webStartup` 服务,并带一个**始终存在**的 `webToken` |
| `webserver` | `dsh-web-remote-access/webserver` | fork `@deepseek-ai/dsh-host-webserver`,保持 `ctx.webServer` 契约不变,增加:路由匹配前的令牌门卫(含升级路径)、manifest 豁免、对已认证 `/api` 请求的回环呈现 |
| `web-runtime` 打印 | `dsh-web-remote-access/url` | 打印带 `?web_token=` 的 URL 行 |
| —(新增行) | `dsh-web-remote-access/polyfill` | 向 index.html 注入 `crypto.randomUUID` polyfill(非安全上下文支持) |

令牌解析为 `--web_token` → `$DSH_WEB_TOKEN` → 启动时随机生成,因此门卫始终开启,打印的 URL 始终能直接打开。绑定所有网卡时,`/api` 信任围栏推导出的 LAN IP 字面量也就是打印的 LAN URL 所用的地址。

## 安全说明

- **无 TLS、无账号体系**。这是纯 HTTP 上的共享密钥门卫,与 harness 面向开发的定位一致;除可信网络外,请用真正的反向代理前置 `dsh web` 终结 TLS。
- 令牌首次打开时出现在地址栏/历史记录里,重定向后会从地址栏清除。
- 令牌比较为常数时间(sha256 + `timingSafeEqual`)。
- `/manifest.webmanifest`(仅 GET/HEAD)不要求令牌:浏览器抓取 PWA manifest 时不带会话 Cookie,而该文件是随 dist 发布的公开静态元数据,拦住它只会 401 安装检测,没有任何安全收益。其余(应用、`/api`、升级路径)全部保持门卫。
- 页面会注入基于 `crypto.getRandomValues` 的 `crypto.randomUUID` polyfill:`crypto.randomUUID` 仅在安全上下文可用,在 LAN IP 上的纯 HTTP 里是 `undefined`,会导致客户端 RPC 发号崩溃、WebSocket 就绪握手失败("WebSocket is closed before the connection is established")。polyfill 在回环/HTTPS 下自动空操作。
- 通过令牌认证的 `/api` 请求会以回环权威(Host/Origin 在 Cookie 校验通过后改写)呈现给下游信任围栏。harness 把特权方法(`settings.*`、`credentials.*`、`agentPreset.*`、`host.*`、`llm.discoverModels`)钉在回环上"直到出现真正的认证层"——令牌门卫就是那层认证,因此配置平面可远程访问。门卫仍只放行带 Cookie 的同源客户端,非 `/api` 路径不受影响。
- 已知限制:`DSH_WEB_URL` 与 web-surface 模型提示仍是无令牌的回环 URL;本 bundle 不提供带令牌的模型侧 URL。

## Fork 来源

`src/webserver.ts` 与 `src/startup.ts` 分别 fork 自 `@deepseek-ai/dsh-host-webserver` 与 `@deepseek-ai/dsh-web-app/startup`(基于 `0.1.0-rc.7`,cordis `4.0.1`,schemastery `3.18.1`)。需跟随上游演进;harness 自身测试不覆盖它们——由本包的 `tests/` 覆盖。

## 开发

```sh
pnpm install
pnpm test       # vitest:fork 契约 + 门卫行为
pnpm build      # tsc -> lib/(ESM)
```
