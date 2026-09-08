<!-- lazypack:start block=agent-roles src=DECISIONS.md@0.2.0 gen=aeb0254139bb9c52 input=daef251ae90ea5c1 fp=bb7deb008429ddc3 -->
# 角色与 Skill 映射表 (docs/agents/roles.md)

> 派生自 lazypack-discipline 固定层 DECISIONS.md@0.2.0（依据 lazypack-setup 内置快照编译，来源内容标识: 2b38b1b0543489226eda5e3bd2bf411c58c1c331；离线事实源查阅 lazypack-setup/references/DECISIONS.md）§3。
> 角色是跨项目不变的固定层；角色到具体 Skill 的映射是可换的适配层。换 Skill 只改本表。

## 1. 角色职责与防撞车边界

防撞车边界法则：同一时刻两个角色不得写入同一类文件。

| 角色 | 输入 | 输出 | 允许写（防撞车边界） |
|---|---|---|---|
| **规划者** (Planner) | 用户意图 + 调查者报告 | 规格、票据、ADR / CONTEXT 更新 | 文档、Issue；**严禁碰业务代码** |
| **调查者** (Investigator) | 规划者提出的具体问题 | 事实简报（附出处引用） | **只读**；严禁写入任何文件 |
| **执行者** (Implementer) | 单张已明确的实现票 | 代码提交（含 diff 涉及的文档行） | 代码、测试、与本 diff 直接相关的文档行 |
| **审查者** (Reviewer) | 代码 diff + 票据 + 编码标准 | 审查报告（通过 / 退回修改清单） | **只写审查意见**；严禁擅改代码 |
| **书记员** (Scribe) | 阶段性提交历史 + 全部文档 | 文档修补提交 | `docs/`、`CONTEXT.md`、`CHANGELOG.md`；**不碰代码** |
| **清道夫** (Sweeper) | 已关闭票据、已合并分支、登记册 | 清理无效临时目录、归档旧产物 | **只删和移动**已过时产物，不新增功能 |

## 2. 角色到 Skill 映射

> 状态说明规则：依据只读探测到的实际证据填写，严格区分四种正交维度：技能已安装证据、实际可调用证据、门禁接线状态与图谱建立状态，不彼此替代。种子模板中未经当前环境核验的技能状态默认标记为 [未验证]，严禁在未获实测调用证据前断言工具可用或全部就绪。

| 角色 | 当前分配的 Skill / 工具 | 状态说明（种子默认，装配时按实测证据替换） |
|---|---|---|
| **规划者** | `grill-with-docs` → `to-spec` → `to-tickets` | 技能已安装 (C:\Users\jared\.agents\skills\)；宿主调用未实测 [未验证] |
| **调查者** | `/understand-codebase`、`/research` | 技能与 MCP 已安装；项目含 .codegraph/ 目录，新鲜度与调用未实测 [部分依赖未验证/图谱未核] |
| **执行者** | `implement`（内部配合 `tdd`） | 技能已安装；受控门禁候选已接线，当前会话未调用验证 [未验证] |
| **审查者** | `code-review` | 技能已安装；对抗门禁复跑未实测调用 [未验证] |
| **书记员** | `retro` 文档部分 | 技能已安装；事件驱动调用未实测 [未验证] |
| **清道夫** | 暂无专用 skill，依据 DECISIONS §4.1 执行 | 暂无专用 skill，规则/人工执行 (发版前事件驱动调用) [人工执行] |
<!-- lazypack:end block=agent-roles -->
