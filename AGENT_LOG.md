# AGENT_LOG.md

本日志记录轻量级终端 Coding Agent 从计划执行到 PR 收尾的关键过程证据。时间按 Asia/Shanghai（UTC+08:00）记录；提交时间来自 `git log --all --pretty=%cI`，PR 时间来自 `gh pr list --state all`。本文件中的“人工干预”指用户或主控 agent 对 subagent 输出、审查反馈、计划文本的非自动采纳决策。

## Evidence Sources

- 执行请求附件：`C:\Users\hp\.codex\attachments\860da85a-27fc-41ac-b74b-999edd821b5a\pasted-text.txt`
- Plan：`docs/superpowers/plans/2026-07-07-lightweight-terminal-coding-agent.md`
- Spec/process 复盘：`SPEC_PROCESS.md`
- Git commit graph：`git log --all`
- GitHub PR 元数据：`gh pr list --state all --limit 30`
- 实现 worktree：`D:\AI4SE_PROJECT_v2\.worktrees\lightweight-terminal-coding-agent`
- 主实现分支：`codex/lightweight-terminal-coding-agent`

## Timeline

### 2026-07-07 10:23:03 +08:00 / Task 0: Spec and Plan Baseline

- 触发的 Superpowers 技能：`superpowers:brainstorming`、`superpowers:writing-plans`。
- 关键 prompt/context 配置：目标被收敛为“Node.js + TypeScript 的本地可用型终端 coding agent”；OpenAI-compatible API 优先；默认自动编辑普通源码，高风险动作确认；agent 必须先展示 plan，再执行工具；项目根目录读取 `Claude.md`。
- Subagent 输出关键片段或 commit hash：`c5c01c6 docs: add lightweight coding agent spec and plan`；后续 merge `b0f7b52`。
- 人工干预：用户选择 MVP 级别 B、技术栈 Node.js + TypeScript、OpenAI-compatible API、自动编辑 + 风险确认、批量计划 + 分步执行，并主动加入 `Claude.md` 项目记忆要求。
- 学到的教训：主 agent 与用户“心里清楚”的约束必须落到 spec、plan、测试或接口里；否则冷启动实现者会把内部事件误解成用户可见行为。

### 2026-07-07 10:31:16 +08:00 / Task 0: Isolated Worktree Setup

- 触发的 Superpowers 技能：`superpowers:using-git-worktrees`、`superpowers:subagent-driven-development`、`superpowers:test-driven-development`。
- 关键 prompt/context 配置：先检测当前目录是否为 linked worktree；发现 `D:\AI4SE_PROJECT_v2` 是普通 `main` checkout；创建隔离 worktree `D:\AI4SE_PROJECT_v2\.worktrees\lightweight-terminal-coding-agent`，分支 `codex/lightweight-terminal-coding-agent`。
- Subagent 输出关键片段或 commit hash：`24237ba chore: ignore local worktrees`；过程记录中明确 “`.worktrees/` 目前没有被忽略，所以先在当前 checkout 增加一个最小 `.gitignore` 保护项”。
- 人工干预：主控没有直接在 `main` 上执行计划，而是先把 `.worktrees` 写入 `.gitignore` 并提交，避免 worktree 内容被误追踪。
- 学到的教训：隔离本身也会制造仓库状态，创建 worktree 前必须先让 worktree 目录进入 ignore 规则。

### 2026-07-07 10:37:19 +08:00 / Task 1: Bootstrap TypeScript CLI Project

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：只把 Task 1 完整文本交给实现者；保留 `.worktrees` ignore；先写失败的 CLI smoke test，再创建 `package.json`、`tsconfig.json`、`src/index.ts`、README scaffold。
- Subagent 输出关键片段或 commit hash：`316612d chore: scaffold TypeScript CLI`；实现者 concern：`npm run build` 后 `npm test` 会发现 `dist` 中的编译测试副本。
- 人工干预：主控先让规格审查复核 “dist 测试重复发现是否违反计划”；确认非阻塞后，再采纳代码质量审查的两个 Important：排除 `dist` 测试、对齐 Node 20 engine 与 `@types/node`。
- 修复提交：`bf19efa fix: tighten scaffold test configuration`。
- 学到的教训：项目 scaffold 阶段的小测试配置会影响后续所有任务；越早把测试发现范围收干净，后面越少噪音。

### 2026-07-07 10:55:37 +08:00 / Task 2: JSON Protocol Parser

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：新增 `src/protocol.ts` 与 `tests/protocol.test.ts`；协议支持 `plan`、`tool_call`、`final`；按计划保留 `extractJsonObject` 的宽松 JSON 提取。
- Subagent 输出关键片段或 commit hash：`b805333 feat: add custom JSON protocol parser`。
- 人工干预：代码质量审查质疑“严格 JSON vs 宽松提取 JSON”。主控没有改成严格解析，因为计划代码明确包含 `extractJsonObject`，而是要求补测试把宽松提取和 schema 断言固定下来。
- 修复提交：`e48a6d6 test: expand protocol parser coverage`。
- 学到的教训：协议解析器的“宽松”是产品意图时，必须用测试把边界讲清楚，否则后续 agent loop 会依赖一个含糊契约。

### 2026-07-07 11:08:57 +08:00 / Task 3: Project Context and Model Configuration

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：新增 `src/config.ts`、`src/project-context.ts`、`tests/config-context.test.ts`；配置来源为环境变量和 `.code-agent/config.json`；`Claude.md`/`CLAUDE.md` 进入项目上下文。
- Subagent 输出关键片段或 commit hash：`4e78b52 feat: load project context and model config`；subagent 为 Windows 大小写不敏感文件系统调整测试写入顺序。
- 人工干预：主控要求规格审查确认 Windows 平台修正不改变断言，并把几个 Windows/错误消息 minor 记录为后续 hardening 候选，而不是阻塞主线。
- 学到的教训：跨平台测试不仅要断言功能，还要避免大小写和文件系统顺序制造假失败。

### 2026-07-07 11:15:09 +08:00 / Task 4: Permission Guard

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：权限分类必须覆盖 workspace containment、敏感文件确认、破坏性命令阻断、Windows 路径/命令变体。
- Subagent 输出关键片段或 commit hash：`4953c9a feat: add permission guard`。
- 人工干预：审查发现 allowlisted 命令可嵌入 `$()` 或换行命令、嵌套 `.env` 漏判；主控要求先补失败测试再改分类器。复审又发现 split/long flag 删除命令和 PowerShell `Remove-Item -rec` 递归别名边界，主控选择继续收紧而不是降级为 confirm。
- 修复提交：`2d2c136 fix: harden permission classification`、`b31fdaf fix: block destructive command variants`、`9009ff8 fix: block powershell recursive delete aliases`。
- 学到的教训：安全模块不能只看 happy path；“确认”和“阻断”语义不同，破坏性命令应阻断就不能用确认代替。

### 2026-07-07 11:46:45 +08:00 / Task 5: Session State and File Tools

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：新增 `SessionState` 与 search/read/edit 文件工具；文件工具必须使用 Task 4 权限分类；编辑前保存 snapshot，后续支持 diff fallback。
- Subagent 输出关键片段或 commit hash：`b786a8a feat: add session state and file tools`。
- 人工干预：审查发现 symlink 越界读写、文件系统异常未统一成 `ToolResult`、无效 UTF-8 会损坏二进制文件、失败写入会把文件误计入 `filesModified`。主控要求分批 TDD 修复，并强调真实目标必须在 workspace 内，而不是表面路径在 workspace 内。
- 修复提交：`610c709 fix: harden file tool boundaries`、`6337c4e fix: reject invalid utf8 file content`；最终全局修复 `b5a9e40` 覆盖“失败写不计入 modified”。
- 学到的教训：路径安全必须看 canonical target；session 状态必须记录事实，而不是记录尝试。

### 2026-07-07 12:10:57 +08:00 / Task 6: Command, Diff, and Tool Router

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：新增 `src/tools/process-tools.ts` 与 `src/tools/router.ts`；router 统一校验工具名和参数，接入 permission guard，支持 `run_command` 与 `diff`。
- Subagent 输出关键片段或 commit hash：`736bb39 feat: route command and diff tools`。
- 人工干预：主控提前提醒 Task 11 后续会调整 `runCommandTool` 签名，因此 Task 6 只实现当前计划的最小版本。审查和后续全局检查发现 snapshot diff 不能丢重复行、内存需要上限、Git diff 在 untracked/失败场景要回退 snapshots。
- 修复提交：`26fd63e fix: preserve duplicate lines in snapshot diffs`、`e162a37 fix: cap snapshot diff memory usage`；最终全局修复 `b5a9e40` 覆盖 Git fallback。
- 学到的教训：diff 看似辅助功能，但它是用户信任 agent 的核心输出；错误 diff 比没有 diff 更危险。

### 2026-07-07 12:29:50 +08:00 / Task 7: OpenAI-Compatible LLM Client

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：新增 `src/llm.ts` 与 `tests/llm.test.ts`；LLM client 使用 `baseURL`、`apiKey`、`model`；system prompt 负责说明 JSON 协议和可用工具参数。
- Subagent 输出关键片段或 commit hash：`92ae298 feat: add OpenAI-compatible LLM client`。
- 人工干预：主控依据前期冷启动反馈要求 prompt 不只列工具名，还必须说明参数结构，避免实现者或模型只知道“有工具”却不知道如何调用。
- 修复提交：`c1ca574 test: cover llm request and error paths`。
- 学到的教训：对 agent 来说，system prompt 是接口定义的一部分；工具 schema 没写清楚，就等于 API 文档缺失。

### 2026-07-07 12:41:54 +08:00 / Task 8: Agent Orchestrator Loop

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：新增 `src/agent.ts` 与 `tests/agent.test.ts`；agent loop 必须先展示 plan，再执行工具；final 的 changedFiles/tests 必须以 session 为准；工具失败进入 observation。
- Subagent 输出关键片段或 commit hash：`067d27a feat: add agent orchestration loop`；初始全套测试 85 通过。
- 人工干预：质量审查要求补三点：plan 之前不能执行工具、final metadata 不能信模型自报、测试要断言消息顺序。复审又指出没有实际 test/build/lint 命令时不能让模型声称 passed，主控要求强制 `not run`。
- 修复提交：`91d3f50 fix: enforce planned agent execution`、`2edfc18 fix: make test summaries session authoritative`。
- 学到的教训：模型输出是建议，session 才是事实记录；agent loop 的可审计性来自“先计划、再工具、再观察”的顺序。

### 2026-07-07 13:02:39 +08:00 / Task 9: CLI, REPL, and Built-In Commands

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：替换 CLI 入口，新增 REPL 与 slash commands；`code-agent --help` 必须走真实 `runCli` 路径；`/help`、`/init`、`/diff`、`/status`、`/config`、`/exit` 都要可用。
- Subagent 输出关键片段或 commit hash：`f19156f feat: add CLI and REPL commands`；本地验证 `node dist/src/index.js --help` 正常输出 help。
- 人工干预：审查发现 slash command 抛错会退出 REPL、非 Git `/diff` 无 session snapshot 时误导用户、坏 `package.json` 可让 `/diff` 退出。主控要求 `handleSlashCommand` 外层统一 catch，失败只反馈诊断，不结束会话。
- 修复提交：`848dbb8 fix: harden slash command handling`、`cc70572 fix: contain slash command failures`。
- 学到的教训：交互式工具的错误边界很重要；一个坏项目文件应该变成一行诊断，而不是结束用户会话。

### 2026-07-07 13:28:04 +08:00 / Task 10: Integration Coverage and Acceptance Documentation

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：新增 MVP integration test，覆盖 search/read/edit/diff 链路；README 记录手工验收路径，但不能提前承诺 Task 11 才实现的 final diff。
- Subagent 输出关键片段或 commit hash：`d317778 test: cover MVP agent workflow`；subagent concern：CLI 还没有打印 final diff，属于 Task 11 范围。
- 人工干预：规格审查指出 README 提前承诺 final diff 不合规；主控要求文档回到当前事实，并让 integration test 故意让模型“撒谎”，验证 final metadata 仍以 session 为准。
- 修复提交：`cd3dc9a test: strengthen MVP workflow assertions`。
- 学到的教训：文档也必须遵守版本事实；integration test 应该覆盖模型乐观或不诚实输出。

### 2026-07-07 13:46:34 +08:00 / Task 11: Confirmation Paths and Loop Limit Hardening

- 触发的 Superpowers 技能：`superpowers:subagent-driven-development`、`superpowers:test-driven-development`、`superpowers:requesting-code-review`。
- 关键 prompt/context 配置：改造 router/process/agent/CLI 多处；加入 confirmation prompts、修改文件数量限制、大 patch 确认、LLM/tool loop limits、final diff 输出。
- Subagent 输出关键片段或 commit hash：`893d44c feat: add confirmations and loop limits`；提交后全套 108 测试通过，本地 focused suite 26 测试通过。
- 人工干预：Task 11 计划片段基于早期代码，主控明确禁止 subagent 整段替换导致回退，要求保留 Task 5/8/9 已硬化的 symlink/UTF-8、plan-before-tool、session-authoritative final、slash error boundary。
- 审查反馈与修复：确认授权未绑定 canonical realpath，`package-lock.json` symlink 可能指向 `.env`；`npx vitest run` 这类测试命令不计入 failure loop；TOCTOU 风险是批准 canonical target 后执行仍用原始 symlink 路径。
- 修复提交：`dec2e63 fix: bind confirmations to canonical targets`、`0609c5f fix: bind file approvals to real targets`；最终 focused suite 35/35、全套 117/117 通过。
- 学到的教训：用户批准的是实际对象，不是字符串路径；批准目标与执行目标必须绑定，否则确认流程仍可被路径切换绕过。

### 2026-07-07 14:28:21 +08:00 / Task 12: MVP Spec Review and Hardening Pass

- 触发的 Superpowers 技能：`superpowers:verification-before-completion`、`superpowers:requesting-code-review`、`superpowers:receiving-code-review`、`superpowers:test-driven-development`。
- 关键 prompt/context 配置：最终验收矩阵包括 `npm test`、`npm run build`、`node dist/src/index.js --help`、focused safety/orchestration suite、`git diff --check main..HEAD`、最终 diff 范围检查。
- Subagent 输出关键片段或 commit hash：初次 Task 12 验收显示 117 tests、build、built help、安全 focused tests 通过；随后全局审查覆盖 `main..HEAD` 完整实现。
- 人工干预：全局审查发现四项成立问题：Git diff 对 untracked/失败场景不回退 snapshots；写入失败会提前计入 modified；focused test command 自动允许不足；README stale note。主控读取 `receiving-code-review` 后确认反馈成立，并派 worker 先写失败测试再修。
- 修复提交：`b5a9e40 fix: address final review gaps`；最终验收：11 files / 122 tests passed，build 通过，built help 正常，focused safety/orchestration suite 71 tests passed，`git diff --check` clean。
- 学到的教训：逐任务审查不能替代全局审查；跨模块状态一致性问题往往只在最终整条分支视角出现。

### 2026-07-07 14:38:37 +08:00 / Task 12: Record Plan Task Commits

- 触发的 Superpowers 技能：`superpowers:finishing-a-development-branch`、`superpowers:verification-before-completion`。
- 关键 prompt/context 配置：在 plan 文件顶部补 Implementation Status，记录 worktree、branch、PR URL、每个 task 的 commit(s) 与 notes。
- Subagent 输出关键片段或 commit hash：`a8d7976 docs: record plan task commits`。
- 人工干预：主控把实现证据回写到 plan，而不是只依赖聊天记录；这让任务编号、commit 和 notes 可以直接从仓库文件复核。
- 学到的教训：实现完成后，计划文件应升级为可审计索引；commit 表比散落聊天更稳定。

### 2026-07-07 15:15:58-15:22:12 +08:00 / Tasks 1-12: Per-Task PRs

- 触发的 Superpowers 技能：`superpowers:finishing-a-development-branch`；同时使用 GitHub CLI 发布/合并 PR。
- 关键 prompt/context 配置：按用户原始要求“每一个 plan 都要提 PR”；每个 task 使用独立 `codex/task-XX-*` 分支，base 为 `main`。
- Subagent 输出关键片段或 commit hash：
  - PR #1 `codex/task-01-bootstrap-typescript-cli` -> merged `2026-07-07 15:20:43 +08:00`
  - PR #2 `codex/task-02-json-protocol-parser` -> merged `2026-07-07 15:20:54 +08:00`
  - PR #3 `codex/task-03-project-context-config` -> merged `2026-07-07 15:21:02 +08:00`
  - PR #4 `codex/task-04-permission-guard` -> merged `2026-07-07 15:21:09 +08:00`
  - PR #5 `codex/task-05-session-file-tools` -> merged `2026-07-07 15:21:17 +08:00`
  - PR #6 `codex/task-06-command-diff-router` -> merged `2026-07-07 15:21:25 +08:00`
  - PR #7 `codex/task-07-openai-compatible-llm-client` -> merged `2026-07-07 15:21:32 +08:00`
  - PR #8 `codex/task-08-agent-orchestrator-loop` -> merged `2026-07-07 15:21:42 +08:00`
  - PR #9 `codex/task-09-cli-repl-builtins` -> merged `2026-07-07 15:21:50 +08:00`
  - PR #10 `codex/task-10-integration-acceptance-docs` -> merged `2026-07-07 15:21:57 +08:00`
  - PR #11 `codex/task-11-confirmations-loop-limits` -> merged `2026-07-07 15:22:04 +08:00`
  - PR #12 `codex/task-12-mvp-hardening-pass` -> merged `2026-07-07 15:22:12 +08:00`
- 人工干预：主控没有只保留一个大 PR，而是把计划拆成 12 个可追溯 PR，保留每个 task 的 merge commit：`7edbd4e`、`4bd848f`、`72e8190`、`30fa241`、`f51b6d6`、`dfbf956`、`14c48ae`、`b409a48`、`cd7f775`、`0e1449c`、`4c85ee7`、`a3a7aa9`。
- 学到的教训：多 PR 增加收尾成本，但给过程证据带来了清晰边界；每个 task 可以独立复核实现、审查与合并点。

## Cross-Cutting Lessons

- TDD 的价值不只在功能正确性，也在把审查反馈变成可回归的边界。
- 对 coding agent 来说，安全分类、session 事实记录、diff 输出和 confirmation prompt 都属于用户信任面。
- Subagent 并行能提速，但主控必须控制审查范围、关闭旧代理句柄、避免安全任务无限发散。
- Plan 不是一次性脚手架；实现过程中发现的隐性约束要回写到 plan、README 或测试里。
- 最终全局审查必须覆盖 `main..HEAD`，因为很多问题是跨 task 组合后才显现的。
