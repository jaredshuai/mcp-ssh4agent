<!-- lazypack:start block=artifacts-register src=DECISIONS.md@0.2.0 gen=aeb0254139bb9c52 input=c9534ae128690441 fp=82bb8cc01552c558 -->
# 产物登记册 (ARTIFACTS)

> 派生自 lazypack-discipline 固定层 DECISIONS.md@0.2.0（依据 lazypack-setup 内置快照编译，来源内容标识: 2b38b1b0543489226eda5e3bd2bf411c58c1c331；离线事实源查阅 lazypack-setup/references/DECISIONS.md）§4。
> 原则：一个东西只有一个家；能推导出来的不手写；有生命周期的写清何时死。

## 1. 产物状态词与流转规则

| 状态词 | 含义 | 流转约束 |
|---|---|---|
| `current` | 当前唯一的现行有效基准 | **在同一类别产物中全局唯一**。新产物标为 `current` 时，旧产物必须降级为 `superseded` |
| `reference` | 外部素材、外部规范、参考设计 | 永久作为参照依据 |
| `exploration` | 探索方案、对比调研 | 仅供比对，不作为实现基准 |
| `superseded` | 已废弃或被取代的旧产物 | `git mv` 归档至 `docs/archive/`，登记行同步更新，互指新产物 |
| `pipeline` | 由源文件生成的派生品（图标、数据） | 登记源与生成器命令；严禁手工修改派生文件，重新运行 pipeline 生成 |
| `wip` | 正在编写或设计中的未决草案 | 完成后裁决为 `current` 或归档 |

> [!IMPORTANT]
> **未登记产物视为未决**：册上查不到的产物，先向维护者核实，严禁按文件名或创建日期猜测新旧！

## 2. 现存产物登记表

| 产物相对路径 | 类别 | 状态 | 来源/对应票/ADR | 说明 |
|---|---|---|---|---|
| docs/agents/issue-tracker.md | 任务跟踪 | current | Matt Pocock skills 前置 | 项目当前现行 Issue / PR / Wayfinding 任务跟踪规范 |
| CODING_STANDARDS.md | 编码规范 | current | lazypack-discipline §6 | 项目当前现行编码规范与双角色门禁标准 |
| RELEASE.md | 发版规范 | current | lazypack-discipline §5 | 项目当前现行提交格式、版本号与发布流水线规范 |
| docs/agents/roles.md | 角色映射 | current | lazypack-discipline §3 | 项目当前现行 6 类角色职责定义与 Skill 映射表 |
<!-- lazypack:end block=artifacts-register -->

## 3. 全仓产物与文档目录 (人工维护扩展区)

> 本区在 lazypack 受管块之外维护，不受 `/lazypack-setup` 重新编译覆盖。
> 遵循 DECISIONS.md §4 产物状态分类（参见 [第 1 节产物状态词与流转规则](#1-产物状态词与流转规则)），同类别内 current 产物全局唯一。
> 集中分类索引详见 [docs/README.md](README.md)。

### 3.1 现行基准产物 (current)

| 产物相对路径 | 细分类别 (唯一性) | 状态 | 权威来源 | 说明 |
|---|---|---|---|---|
| README.md | 项目主入口 | current | 本地事实 | 项目核心使用说明、安装与运行指南 |
| CHANGELOG.md | 版本演进历史 | current | 本地历史 | 历史版本变更记录（Keep a Changelog 格式） |
| CONTEXT.md | 领域词汇表 | current | 本地事实 | 单上下文领域核心词汇与术语边界定义 |
| SECURITY.md | 安全披露政策 | current | 本地事实 | GitHub 漏洞私密报告与披露指南 |
| CONTRIBUTING.md | 社区贡献指南 | current | 本地事实 | 开源贡献流程、编码与提交规范指引 |
| docs/README.md | 文档中心总索引 | current | 本地事实 | 全仓文档总索引与按角色任务导航 |
| docs/TOOL_MANAGEMENT.md | 工具管理指南 | current | 本地事实 | 37 项工具分组管理、Token 消耗与精简模式 |
| docs/BACKUP_GUIDE.md | 备份恢复手册 | current | 本地事实 | MySQL/PG/Mongo 数据与文件备份恢复完整指引 |
| docs/DEPLOYMENT_GUIDE.md | 部署策略指南 | current | 本地事实 | 自动化部署、提权与批处理分发策略 |
| docs/SECURITY_MODES.md | 安全模式规范 | current | 本地事实 | 服务器级 per-server 安全策略与过滤规范 |
| docs/ALIASES_AND_HOOKS.md | 别名钩子指南 | current | 本地事实 | 命令别名体系与自动化触发钩子指南 |
| docs/agents/doc-governance.md | 文档治理规范 | current | lazypack-discipline §7 | 持续文档治理流程与代码同步契约 |
| docs/agents/domain.md | 领域定位指针 | current | 本地事实 | 单上下文领域事实源定位指针规范 |
| docs/agents/triage-labels.md | 标签分诊规范 | current | 本地事实 | GitHub Issue 5 种标准分诊标签规范 |
| docs/agents/development.md | Agent 开发调试 | current | 本地事实 | AI Agent 详细开发命令、CLI 操作与调试指南 |
| docs/agents/tools-and-config.md | Agent 工具配置 | current | 本地事实 | AI Agent 37 项工具速查与配置参数全集 |
| docs/adr/0001-node-native-type-stripping.md | 架构决策: 运行时选型 | current | 本地事实 | ADR: Node 原生类型剥离运行时 |
| docs/adr/0002-tool-context-injection.md | 架构决策: 工具注入解耦 | current | 本地事实 | ADR: 工具组上下文依赖注入 |
| docs/adr/0003-tunnels-own-their-connection.md | 架构决策: 隧道连接模型 | current | 本地事实 | ADR: SSH 隧道连接独立生命周期 |
| docs/adr/0004-tool-config-one-owner.md | 架构决策: 配置所有权模式 | current | 本地事实 | ADR: 工具配置单一所有者模式 |
| docs/adr/0005-advanced-stays-one-file.md | 架构决策: 高级模块聚合 | current | 本地事实 | ADR: 保持 advanced.ts 聚合单元 |
| cli/README.md | CLI 命令行手册 | current | 本地事实 | 原生 TypeScript CLI 手册与功能说明 |
| profiles/README.md | 预设配置集说明 | current | 本地事实 | 预设 Profile 结构与定制指南 |
| INSTALLATION.md | 根部安装跳转指针 | current | README.md#installation | 根目录安装指引重定向指针（防断链） |
| QUICKSTART.md | 根部快速开始跳转指针 | current | README.md#quick-start | 根目录快速开始重定向指针（防断链） |

### 3.2 参考材料与素材 (reference)

| 产物相对路径 | 类别 | 状态 | 权威来源 | 说明 |
|---|---|---|---|---|
| LICENSE | 开源许可证 | reference | MIT 官方 | MIT 开源许可证文本 |
| docs/images/ssh4agent-cli-menu.png | 界面截图素材 | reference | 本地生成 | README 引用的 CLI 交互菜单截图附件 |

### 3.3 历史归档与被取代产物 (superseded)

| 产物相对路径 | 类别 | 状态 | 替代来源 | 说明 |
|---|---|---|---|---|
| docs/archive/INSTALLATION.md | 早期安装指引 | superseded | [README.md#installation](../README.md#installation) | 早期独立安装指引（含已废弃字段），已归档供考证 |
| docs/archive/QUICKSTART.md | 早期快速开始 | superseded | [README.md#quick-start](../README.md#quick-start) | 早期 5 分钟上手指引（含旧 ssm 别名），已归档供考证 |

### 3.4 派生产物构建流水线 (pipeline)

| 产物相对路径 | 类别 | 状态 | 生成命令 / 源 | 说明 |
|---|---|---|---|---|
| dist/ | 构建发布产物 | pipeline | `npm run prepack` (tsc -p tsconfig.build.json) | 供 npm 发布和 npx 使用的纯 JS 编译产物 |

## 4. 待核实议题与事实边界清单

> 注：待核实事项属于演进议题与能力边界追踪，非固定层产物生命周期状态词。

| 议题编号 | 议题主题 | 现状事实与行为 | 证据缺口 / 后续验证条件 |
|---|---|---|---|
| ISSUE-01 | SSH 隧道跨跳板穿越 (ProxyJump) | ADR-0003 记录当前在带有 proxyJump/proxyCommand 的服务器上创建隧道会直接抛出明确错误拦截 | 完整的 jump host 隧道穿越逻辑尚未实现；需待具备真实多跳 SSH 测试拓扑时验证实现方案 |
