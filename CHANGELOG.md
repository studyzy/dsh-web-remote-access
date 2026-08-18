# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[1.0.0]: https://github.com/studyzy/dsh-web-remote-access/releases/tag/v1.0.0
