<!-- lazypack:start block=coding-standards src=DECISIONS.md@0.2.0 gen=aeb0254139bb9c52 input=daef251ae90ea5c1 fp=63c3741247171c28 -->
# 编码标准与质量门禁 (CODING_STANDARDS)

> 派生自 lazypack-discipline 固定层 DECISIONS.md@0.2.0（依据 lazypack-setup 内置快照编译，来源内容标识: 2b38b1b0543489226eda5e3bd2bf411c58c1c331；离线事实源查阅 lazypack-setup/references/DECISIONS.md）§6。

## 1. 原则与职责

1. **工具能查的，不写进散文**：格式化、语法校验、类型检查由工具执行，本标准不重复复述已被 linter/formatter 覆盖的细则。
2. **审查者执行标准**：本文件由审查者（Reviewer）在代码审查时严格执行；执行者（Implementer）编码时对照执行。
3. **对抗性双跑门禁**：执行者提交前跑门禁，审查者审查时同样必须跑门禁，通过对抗性审查压低两边都没跑的概率（§6.4）。

## 2. 质量双轨制 (§6.5)

- **可测层（Domain & Data Logic）**：
  - 核心领域逻辑、状态推导、数据清洗与算法等行为改动，**必须配套自动化测试断言**。
  - 严禁提交无断言或断言被注销的可测层逻辑。
- **迭代层（UI & Pages & Components）**：
  - 页面、样式、交互组件以语法/类型检查为底线。
  - 复杂推导逻辑应下沉到可测层进行单元测试，避免页面层堆砌难以自动化测试的隐式逻辑。

## 3. 文档跟着代码改 (§7)

- 执行者提交代码时，必须同步 diff 涉及的文档行（§7.1）。
- 需求方或维护者变更决议时，新决议先进 `grill-with-docs`，落 ADR 并更新产物登记册状态（§7.3）。
<!-- lazypack:end block=coding-standards -->
