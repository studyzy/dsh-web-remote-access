# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅        |

## Security Model

`@studyzy/dsh-web-remote-access` 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 可远程访问(把上游拒绝的 `--host 0.0.0.0` 解析为具体网卡地址)。访问控制由 harness 自身的会话令牌承担,请先理解其安全边界:

- **这是纯 HTTP 上的共享密钥门禁,不是完整的认证/授权层**。它没有账号体系、没有用户隔离、没有 TLS。
- 密钥就是打印出来的那个 URL:其中的 `?token=`(进程启动令牌)可换取 `dsh-auth-*` 会话 Cookie,持有它即可完全访问 Web UI 及其 `/api` 配置平面(`settings.*`、`credentials.*`、`pluginInventory.*`、`host.*`、`llm.discoverModels`)。
- 该 Cookie 与**权威绑定**(Cookie 名 `dsh-auth-<sha256(authority)>`,载荷 `authority` 必须等于请求 Host),属性 `HttpOnly`、`SameSite=Strict`、`Path=/`,默认 30 天有效(`cookieMaxAgeDays`)。
- 上游拒绝通配绑定的理由是"通配绑定会把远程代码执行能力暴露到网络"。本插件收敛为绑定**一个具体网卡地址**,但仍然等于把 harness 的执行能力暴露到该网段——只在可信网络使用。
- 通过域名而非 LAN IP 访问时,`/api` 的 Host 信任围栏会拒绝(403),需显式 `--trusted-host <域名>`;这条也是防 DNS rebinding 的护栏,不要图省事把不受控的权威加进去。

## Reporting a Vulnerability

请**不要**公开披露漏洞。通过私有渠道报告:

- 项目维护者:[studyzy@163.com](mailto:studyzy@163.com)
- 或 GitHub 私有漏洞报告:https://github.com/studyzy/dsh-web-remote-access/security/advisories/new

请在报告中包含:

1. 受影响版本与复现步骤(最小化);
2. 影响评估(能做什么、绕过哪些防护);
3. 建议的修复方向(如适用)。

我们会在确认后尽快修复并发布补丁,修复落地前不会公开细节。

## Deployment Recommendations

- **生产环境必须前置 TLS**:在 `dsh web` 前使用反向代理(如 Caddy、Nginx、Traefik)终结 TLS。纯 HTTP 下令牌与 Cookie 均以明文传输,任何能嗅探网络的人都能截获。
- 会话 Cookie 默认 30 天有效(可用 `--cookie-max-age-days` 调整,浏览器上限 400 天):不要在不信任的机器上打开打印的 URL;要吊销访问,请让浏览器清除该站 Cookie(重启进程只会换启动令牌,已签发的 Cookie 在有效期内仍然有效)。
- 不要把打印的 URL 提交进版本控制、日志或聊天记录;它等同于密钥。
- 遵循最小暴露原则:仅在有明确远程访问需求时才绑定对外地址,能指定具体网卡地址时优先用 `--host <地址>`。
