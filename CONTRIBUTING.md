# Contributing Guide

欢迎为 `@studyzy/dsh-web-remote-access` 贡献代码、文档或 issue!在动手前请先阅读本指南与 [README](README.md)。

## 开发环境

要求:Node.js ≥ 18、[pnpm](https://pnpm.io/)(本仓库使用 pnpm 管理依赖)。

```sh
pnpm install      # 安装依赖
pnpm test         # 运行 vitest 测试套件
pnpm build        # tsc 编译到 lib/(ESM)
```

## 项目结构

```
src/
  index.ts        # 包入口,导出启动服务的类型与常量
  startup.ts      # fork @deepseek-ai/dsh-web-app/startup:--host 0.0.0.0 → 具体网卡地址
  url.ts          # 打印绑定地址 + harness ?token= 的 URL 行
  polyfill.ts     # 非回环绑定时注入 crypto.randomUUID polyfill
  loopback.ts     # 注入脚本,远程浏览器呈现回环视图(暂未启用)
tests/            # vitest:startup/url/polyfill 行为(真实 Loader 组合)
cordis.patch.yml  # dsh bundle patch 层:替换 web-app 行、挂载本包插件
```

## 分支与提交

- 从 `main` 切出功能分支,命名如 `feat/<description>`、`fix/<description>`。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)(`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:` 等)。
- 保持提交聚焦:一个逻辑变更一个提交。

## 代码约定

- TypeScript,`strict` 模式(见 `tsconfig.json`);目标 ES2022、NodeNext 模块解析。
- 新增/修改行为必须配套测试,并跑通 `pnpm test`。
- 本包 fork 自上游 `@deepseek-ai/dsh-web-app/startup`(唯一分歧:通配绑定的处理)。改动时保持 `webStartup` 服务契约不变;`webserver` 行不再 fork,不要重新引入对请求权威的改写。
- 保持零运行时依赖的克制:能用 Node 内建/现有依赖解决的,不新增依赖。
- 代码注释用英文;面向用户文档(README 等)用中文(本项目 README 为中文)。

## 测试

```sh
pnpm test                 # 全部测试
pnpm vitest run <file>    # 单文件,如 tests/startup.spec.ts
```

测试覆盖两类:

1. **startup 契约**:真实 Loader 组合下发布的 `webStartup` 服务(flag 解析、`0.0.0.0` 解析为具体地址、`remote`、有界退出);
2. **url / polyfill / loopback 行为**:打印行内容与时机、索引 tap 的注入与惰性条件;
3. **浏览器 e2e**(`pnpm test:e2e`):在真实 `dsh` CLI 上通过局域网地址验证远程绑定、会话令牌门禁与 WebUI 启动。

## 提交 PR

1. 确保 `pnpm test` 与 `pnpm build` 全部通过。
2. 更新 `CHANGELOG.md`(若存在 `[Unreleased]` 一节则补入;发布时归档为版本章节)。
3. 若变更了用户可见行为(CLI flag、环境变量、URL 格式、安全边界),同步更新 README。
4. 描述 PR 动机、变更内容与测试方式。

## Issue 与安全

- Bug 报告:请附 dsh 版本、本包版本、复现步骤与日志。
- 安全问题:请走 [SECURITY.md](SECURITY.md) 的私有报告渠道,**不要**在 issue 中公开。
