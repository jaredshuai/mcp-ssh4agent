<!-- lazypack:start block=release-discipline src=DECISIONS.md@0.2.0 gen=aeb0254139bb9c52 input=daef251ae90ea5c1 fp=83357339ed3006a9 -->
# 发版与提交纪律 (RELEASE)

> 派生自 lazypack-discipline 固定层 DECISIONS.md@0.2.0（依据 lazypack-setup 内置快照编译，来源内容标识: 2b38b1b0543489226eda5e3bd2bf411c58c1c331；离线事实源查阅 lazypack-setup/references/DECISIONS.md）§5。

## 1. 提交与版本规则（固定段）

### 1.1 提交头 (Conventional Commits 1.0.0)
- 格式：`type(scope)!: 描述`
- 允许的 8 个 Angular type：`build`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `test`，加上 `chore`, `revert`。
- 破坏性改动使用 `!` 或正文注明 `BREAKING CHANGE`。
- 脚注使用 `Closes #n` 或 `Fixes #n` 关联票据。

### 1.2 提交正文 (Google CL 规范)
- 第一行独立说清「改了什么」。
- 正文说清「为什么做此改动」、有哪些未做完或折衷之处、关联的 Issue / Bug 号。

### 1.3 版本号映射 (SemVer 2.0.0)
- `!` 或 `BREAKING CHANGE` -> Major 升级 (`vX.0.0`)
- `feat` -> Minor 升级 (`v0.X.0`)
- `fix` / `perf` -> Patch 升级 (`v0.0.X`)
- 其他 type 不触发版本发版。
- 每次发版必须在 Git 打对应版本标签（如 `v1.2.0`）。
- 变更记录遵循 Keep a Changelog 1.1.0 格式，由提交历史自动编译生成，禁止手写篡改。

## 2. 平台打包与发布流水线 (Node.js / npm & GitHub Release)

> [!WARNING]
> 以下打包与发布流程基于项目现有本地事实（`package.json` 及 `.github/workflows/release.yml`）梳理，自动化发版实操在本会话中尚未执行验证（标记为未验证）。执行发版前请人工核对各项前置凭据与配置。

### 2.1 依赖安装与质量门禁
- **依赖锁定**：开发与发布依赖锁定于 [package-lock.json](package-lock.json)，执行 `npm install`。
- **本地发布前校验**：发布前必须通过全套静态门禁与测试套件：
  - 格式检查：`npx @biomejs/biome check .`
  - 静态检查：`npm run lint` (`npx @biomejs/biome lint .`)
  - 类型检查：`npm run typecheck` (`tsc -p tsconfig.json`，`noEmit: true`)
  - 完整测试：`npm test`（串行运行 `tests/` 下各测试套件，使用独立 `SSH4AGENT_HOME` 隔离）
  - 专有验证：`npm run validate` (`node scripts/validate.ts`)

### 2.2 打包构建 (Build & Prepack)
- **构建脚本**：`npm run build`（对应 `package.json` 中的 `prepack` 钩子）
  - 执行 `tsc -p tsconfig.build.json` 将 TypeScript 源码编译输出为 `dist/` 下的纯 JavaScript（运行时兼容 Node.js ≥20）；
  - 自动将 `profiles/` 配置目录与 `package.json` 复制同步至 `dist/` 目录；
  - 打包前检查：执行 `npm pack --dry-run` 检验待发布文件，核查 `dist/src/index.js`、`dist/cli/ssh-manager.js` 及 `dist/profiles` 存在性。

### 2.3 远端发布流水线 (.github/workflows/release.yml)
- **触发机制**：向 GitHub 仓库推送匹配 `v*` 的版本标签（例如 `git tag v4.0.0 && git push origin v4.0.0`），或通过 GitHub Actions 手动触发 `workflow_dispatch`（输入已存在的 tag，如 `v4.0.0`）。
- **CI 流水线步骤**：
  1. 检出标签代码并配置 Node.js 24 环境；
  2. 严格校验 Git 标签名与 `"v" + package.json` 版本一致（`PKG_VERSION="v$(node -p "require('./package.json').version")"`，不一致则直接阻断发布）；
  3. 执行完整测试 `npm test`、类型检查 `npm run typecheck` 及语法检查 `npx @biomejs/biome lint .`；
  4. 执行 `npm run build` 构建待发布产物；
  5. 发布至 npm：执行 `npm publish --provenance --access public`（依赖仓库密钥 `NPM_TOKEN`）；
  6. 从 [CHANGELOG.md](CHANGELOG.md) 中自动提取对应版本说明，通过 `gh release create` 自动创建附带对应更新日志的 GitHub Release。
- *(注：CI 配置历史注释曾提及 `docs/agents/release.md`，经查该文件实际不存在；本项目发布流程以本文件与现有 `release.yml` 实际逻辑为准)*。
<!-- lazypack:end block=release-discipline -->
