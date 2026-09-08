# MCP SSH4Agent 文档中心 (Documentation Center)

欢迎查阅 MCP SSH4Agent 项目文档。本文档中心根据读者角色与使用任务对全仓文档进行分类组织与导航。

---

## 1. 🚀 快速上手与操作指南 (Users & Operators)

面向使用 MCP SSH4Agent 连接和运维远程主机的用户与运维人员：

| 文档 | 描述 | 关键内容 |
|---|---|---|
| [**README.md**](../README.md) | 项目主入口与使用概览 | 特性介绍、快速安装（[#installation](../README.md#installation)）、快速上手（[#quick-start](../README.md#quick-start)）、环境配置与核心命令 |
| [**TOOL_MANAGEMENT.md**](TOOL_MANAGEMENT.md) | 37 项 MCP 工具分组管理指南 | 工具分组（core, sessions, monitoring, backup, database, advanced）、运行模式（all, minimal, custom）与 Token 消耗优化 |
| [**BACKUP_GUIDE.md**](BACKUP_GUIDE.md) | 数据库与文件备份恢复手册 | MySQL、PostgreSQL、MongoDB 数据转储与恢复、自动定时计划与保留策略 |
| [**DEPLOYMENT_GUIDE.md**](DEPLOYMENT_GUIDE.md) | 自动化部署与权限策略指南 | 跨服务器部署策略、sudo 权限自动提权与批处理分发 |
| [**SECURITY_MODES.md**](SECURITY_MODES.md) | 服务器级安全模式规范 | `unrestricted`、`readonly`、`restricted` 细粒度执行拦截与审计机制 |
| [**ALIASES_AND_HOOKS.md**](ALIASES_AND_HOOKS.md) | 命令别名与自动化钩子指南 | 预设配置集（Profiles）、命令别名扩展与自动化触发钩子 |
| [**cli/README.md**](../cli/README.md) | 原生 TypeScript CLI 手册 | 交互式终端菜单、服务器添加/测试/移除与跨平台无依赖执行 |
| [**profiles/README.md**](../profiles/README.md) | 预设 Profile 配置说明 | 针对 Frappe、Docker、Node.js 等技术栈的专用别名与钩子定义 |

---

## 2. 🏛️ 架构决策与领域模型 (Architecture & Decisions)

面向需要理解系统边界、设计取舍与技术选型的架构师与开发者：

- [**CONTEXT.md**](../CONTEXT.md)：**领域核心词汇表与术语边界**，定义 Server、Resolved config、ToolContext、Registration funnel、Connection、Tunnel 等关键概念的精确语义与推荐称谓。
- **架构决策记录 (Architecture Decision Records, ADR)**：
  - [ADR-0001: Node.js 原生类型剥离运行时](adr/0001-node-native-type-stripping.md) — 确立无编译直接执行（Node >=23.6）的设计契约与发布时编译规则。
  - [ADR-0002: 工具模块上下文注入与解耦](adr/0002-tool-context-injection.md) — 工具组接收 `ToolContext` 依赖注入，杜绝反向依赖入口。
  - [ADR-0003: SSH 隧道连接拥有独立生命周期](adr/0003-tunnels-own-their-connection.md) — 隧道使用专用长连接，禁止混入连接池以避免被空闲回收。
  - [ADR-0004: 工具配置单一所有者模式](adr/0004-tool-config-one-owner.md) — 确立 `tool-config-manager.ts` 为配置唯一事实源，CLI 仅做视图展示。
  - [ADR-0005: 保持 advanced.ts 为统一聚合单元](adr/0005-advanced-stays-one-file.md) — 工具组以注册契约为边界，避免碎片化过度拆分。

---

## 3. 🤖 AI Agent 规范与工程纪律 (AI Agents & Collaborators)

面向在本项目中执行任务的 AI 编程智能体（Claude Code, Codex, Cursor 等）：

| 规范文档 | 说明 |
|---|---|
| [**AGENTS.md**](../AGENTS.md) | **智能体常驻交互规范**：命令约定、代码规范、身份生成、硬性安全禁令及工程纪律指针 |
| [**docs/agents/development.md**](agents/development.md) | **Agent 开发与调试手册**：CLI 详细指令、Codex 迁移、工具管理 CLI 与调试脚本汇总 |
| [**docs/agents/tools-and-config.md**](agents/tools-and-config.md) | **Agent 工具与配置速查**：37 项工具全清单、.env 与 TOML 语法字段及加载优先级 |
| [**docs/agents/roles.md**](agents/roles.md) | **6 类角色职责分工与防撞车边界**：规划者、调查者、执行者、审查者、书记员、清道夫 |
| [**docs/agents/doc-governance.md**](agents/doc-governance.md) | **持续文档治理流程**：文档落户原则、代码文档同步契约、归档替代要求与受管块保护边界 |
| [**docs/agents/issue-tracker.md**](agents/issue-tracker.md) | **任务跟踪与分支协作规范**：基于 GitHub Issues 的票据流转规则 |
| [**docs/agents/triage-labels.md**](agents/triage-labels.md) | **分诊标签标准**：`needs-triage`、`ready-for-agent` 等 5 种标准标签语义 |
| [**docs/agents/domain.md**](agents/domain.md) | **单上下文领域文档定位**：以 `CONTEXT.md` 与 `docs/adr/` 为单一事实源 |

---

## 4. 🛠️ 质量门禁、发版与协作 (Quality, Release & Contributing)

| 规范 | 描述 |
|---|---|
| [**CODING_STANDARDS.md**](../CODING_STANDARDS.md) | 审查者与执行者双角色代码质量门禁（Format / Lint / Type / Test / Validate） |
| [**RELEASE.md**](../RELEASE.md) | 提交规范（Conventional Commits 1.0.0 + Google CL 风格）与 SemVer 发版流水线 |
| [**CONTRIBUTING.md**](../CONTRIBUTING.md) | 社区贡献者指引、PR 流程与开发规范 |
| [**SECURITY.md**](../SECURITY.md) | 安全漏洞私密披露流程（GitHub Private Vulnerability Reporting） |
| [**docs/ARTIFACTS.md**](ARTIFACTS.md) | **项目产物登记册**：现存所有基准文档、参考材料、归档产物的权威状态与流转追踪 |

---

## 5. 🗄️ 归档资料与版本历史 (Archive & History)

- [**CHANGELOG.md**](../CHANGELOG.md)：版本演变全历史记录（Keep a Changelog 格式）。
- [**docs/archive/INSTALLATION.md**](archive/INSTALLATION.md)：早期独立安装指引（已归档，由 [README.md#installation](../README.md#installation) 替代）。
- [**docs/archive/QUICKSTART.md**](archive/QUICKSTART.md)：早期 5 分钟上手指南（已归档，由 [README.md#quick-start](../README.md#quick-start) 替代）。

---

## 6. ❓ 待核实议题与已知事实边界 (Issues & Boundary Limitations)

当前登记的已知能力边界与待核实事项：
- **SSH 隧道嵌套跳板**：根据 [ADR-0003](adr/0003-tunnels-own-their-connection.md)，`ssh_tunnel_create` 支持**单跳** `proxyJump` / `proxyCommand`（隧道自握门卫 Connection，不借用连接池）。门卫自身仍配置跳字段时继续拒绝；完整多跳链与真实多跳拓扑验证仍待后续。
