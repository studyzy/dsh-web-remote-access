# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 浏览器 e2e(`tests/e2e/`, `pnpm test:e2e`):在真实 `dsh` CLI 链路上验证插件在最新 dsh 下可用——隔离 `$DSH_HOME` 中通过 `dsh plugin --profile web add` 安装 bundle,以 `--host 0.0.0.0 --web_token` 启动,断言启动行内嵌 `?web_token=` 授权 URL、无 Cookie/令牌时所有表面(页面、`/api`、WebSocket 升级)返回 401、`?web_token=` 授权会话 Cookie(302)、SPA 在 Cookie 下正常返回且注入 `crypto.randomUUID` polyfill、`/manifest.webmanifest` 保持公开、LAN 网卡上的门禁一致,并由 Playwright 通过**局域网 IP**(而非回环地址)启动 WebUI 断言零页面错误——回环是安全上下文,`crypto.randomUUID` 原生存在,只有局域网 IP 下的非安全上下文才会真正触发 polyfill。CI 新增 `e2e` job 对 `@deepseek-ai/dsh@next` 运行,无需密钥。
- 本地浏览器 e2e(`pnpm test:e2e:local`):复用开发者真实 `~/.dsh` 的 web profile,把当前源码链接进去,同样通过局域网 IP 验证令牌门禁与 WebUI 启动(不入 CI)。

## [1.0.2] - 2026-08-21

### Fixed

- 适配 dsh 0.1.1-rc.1(harness 更新后的 index 渲染契约):上游 `@deepseek-ai/dsh-host-webserver` 在 0.1.1 把 `applyIndexTaps` 扩展为 `renderIndex`(结构化 `webserver/index-inject` 注入表 + 原始 tap)。本 bundle 的 webserver fork 只保留了旧方法,而新的 `frontend-static` fallback 所有者调用 `ctx.webServer.renderIndex`,导致每个页面请求在 token 放行后抛错并返回 400 —— 页面完全无法打开。现在 fork 补齐了 `renderIndex`/`collectIndexInjections` 与 `webserver/index-inject` 事件,客户端模块引导表(`window.__DSH_BOOT__`)、主题注入与 `tapIndex` polyfill 都能正常渲染。
- 适配 dsh 0.1.1-rc.1 的 `--no-open` 标志与 `openBrowser` 启动值:startup fork 现在解析 `--no-open` 并透传 `openBrowser`,避免无头服务器默认尝试打开浏览器,同时保留原生的 `--no-open` CLI 契约。
- 远程浏览器通过局域网 IP 访问时,"设置 → 模型 / 插件"页面无法显示:客户端 `connection.isLoopback` 完全由 `location.hostname` 决定,局域网 IP 下为 `false`,设置界面因此落入进程内 "memory" 作用域,settings 镜像从不读取 Host(模型页报 "settings are unavailable in this browser")。现在当 `--web_token` 门禁启用时,向 index.html 注入脚本,在 `@deepseek-ai/dsh-client-connection` 提供 `connection` 服务时将其 `isLoopback` 置为 `true`,使已认证的远程浏览器呈现与回环访问一致的设置体验。

## [1.0.1] - 2026-08-19

### Fixed

- 远程访问下 WebSocket 下行(`/api/events.host`、`/api/events.mux`)握手失败:升级路径与 HTTP 路径不一致,未将凭 Cookie 认证的 `/api` 请求的 Host 改写为回环权威,被 harness 的浏览器信任围栏(DNS rebinding 防护)以 403 拒绝。现在升级路径与 HTTP 路径同样调用 `authorizeApiAsLoopback`,WebSocket 握手凭 Cookie 即可通过围栏。

## [1.0.0] - 2026-08-18

### Added

- `dsh --profile web` 支持 `--host 0.0.0.0`,让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI 可通过远程访问。
- Web 访问令牌门卫(`--web_token`),覆盖页面、`/api` RPC 与 WebSocket 下行:
  - 首次打开 `http://<host>:<port>/?web_token=<token>` 时 302 跳转到干净路径,并下发会话 Cookie(`dsh_web_token`,`HttpOnly`, `SameSite=Lax`,浏览器关闭即失效)。
  - 之后请求凭 Cookie 访问,直到浏览器关闭。
- 令牌永远存在:解析顺序 `--web_token` → 环境变量 `$DSH_WEB_TOKEN` → 启动时随机生成的令牌。
- 启动时打印可直接打开的 URL(含 `?web_token=`),绑定所有网卡时额外打印 LAN 地址。
- 常数时间令牌比较(`sha256` + `timingSafeEqual`)。
- `/manifest.webmanifest`(仅 GET/HEAD)豁免令牌:PWA manifest 是随 dist 发布的公开静态元数据。
- 通过令牌认证的 `/api` 请求以回环权威呈现给下游信任围栏,使 harness 的配置平面(settings/credentials/agentPreset/host/llm.discoverModels)可远程访问。
- 向 index.html 注入 `crypto.randomUUID` polyfill(基于 `crypto.getRandomValues`),修复非安全上下文(纯 HTTP LAN IP)下客户端 RPC 发号与 WebSocket 就绪握手失败。
- 基于 Vitest 的测试套件:`tests/` 覆盖 fork 契约(路由、fallback 席位、index tap、升级、错误隔离、teardown)与门卫行为(401 拒绝、`?web_token=` 授权、Cookie 放行、`/api` 回环呈现、manifest 豁免、升级路径 401)。
- 标准开源项目配套文件:`LICENSE`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`.github/` 模板与 CI 工作流、`.editorconfig`、`.gitattributes`。
- npm 包元数据:`@studyzy` scope 包名、`author`、`keywords`、`repository`、`homepage`、`bugs`、`engines`。

### Security

- 对外暴露的服务始终有令牌保护:绑定 `0.0.0.0` 时若未显式提供令牌,也会生成随机令牌,绝不无认证运行。

[1.0.2]: https://github.com/studyzy/dsh-web-remote-access/releases/tag/v1.0.2
[1.0.1]: https://github.com/studyzy/dsh-web-remote-access/releases/tag/v1.0.1
[1.0.0]: https://github.com/studyzy/dsh-web-remote-access/releases/tag/v1.0.0
