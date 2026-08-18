# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅        |

## Security Model

`@studyzy/dsh-web-remote-access` 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 可远程访问,并以访问令牌(web token)做访问控制。请先理解其安全边界:

- **这是纯 HTTP 上的共享密钥门卫,不是完整的认证/授权层**。它没有账号体系、没有用户隔离、没有 TLS。
- 令牌即密钥:持有令牌(或持有已授权会话的 Cookie)即可完全访问 Web UI 及其 `/api` 配置平面(`settings.*`、`credentials.*`、`agentPreset.*`、`host.*`、`llm.discoverModels`)。
- 令牌**永远存在**:`--web_token` → `$DSH_WEB_TOKEN` → 启动时随机生成。对外绑定(`--host 0.0.0.0`)时绝不会无认证运行。
- 令牌比较为常数时间(`sha256` + `timingSafeEqual`),不泄漏令牌长度与内容。
- 会话 Cookie 属性:`HttpOnly`、`SameSite=Lax`、`Path=/`,浏览器关闭即失效(会话 Cookie)。
- `/manifest.webmanifest`(仅 GET/HEAD)为公开静态元数据,豁免令牌;其余所有路径(应用、`/api`、WebSocket 升级)都在门卫之后。

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
- 使用固定令牌(`--web_token` 或 `$DSH_WEB_TOKEN`),便于轮换与吊销;随机令牌会在进程重启后失效,适合临时使用。
- 令牌轮换:重启服务并更换 `--web_token` 即可使旧令牌与全部已授权会话失效。
- 不要将令牌提交进版本控制;通过环境变量或密钥管理工具注入。
- 遵循最小暴露原则:仅在有明确远程访问需求时才绑定 `--host 0.0.0.0`。
