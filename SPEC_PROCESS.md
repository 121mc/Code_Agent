# SPEC_PROCESS.md

## 1. 背景与产物

本项目目标是设计并实现一个受 Claude Code 启发的轻量级终端式 Coding Agent。规格与计划主要通过 Superpowers 的 `brainstorming` 和 `writing-plans` 流程形成。

相关产物：

- Spec: `docs/superpowers/specs/2026-07-07-lightweight-terminal-coding-agent-design.md`
- Plan: `docs/superpowers/plans/2026-07-07-lightweight-terminal-coding-agent.md`

本过程文档记录三件事：

1. brainstorming 阶段如何把模糊想法收敛成 MVP spec。
2. writing-plan 阶段如何把 spec 拆成可执行实现计划。
3. 冷启动/第二 agent 仅凭 SPEC + PLAN 暴露出的歧义和缺陷，以及后续修订。

## 2. Brainstorming 关键节点

### 2.1 MVP 范围

智能体首先没有直接进入架构设计，而是追问第一版产品边界：

> 你希望第一版 MVP 优先做到哪一级？
> A. 演示型原型
> B. 可用型本地助手
> C. 接近 Claude Code 的完整体验

我的选择是 **B：可用型本地助手**。这个问题很关键，因为它把项目从“完整 Claude Code 复刻”收敛为“能真实修改代码、运行测试、展示 diff，但关键风险可控”的 MVP。

### 2.2 技术栈与模型接入

智能体继续追问运行时：

> 你希望 MVP 用什么语言/运行时？
> A. Node.js + TypeScript
> B. Python
> C. Go/Rust

我选择 **Node.js + TypeScript**。这让后续 CLI、流式输出、工具编排和 npm 分发的方向都更明确。

随后它追问 LLM 接入方式：

> A. OpenAI-compatible API 优先
> B. Anthropic Claude API 优先
> C. Provider Adapter 架构

我选择 **OpenAI-compatible API 优先**。智能体原本更倾向 provider adapter，但我希望第一版更轻、更兼容 DeepSeek/Qwen/OpenAI-compatible 服务，因此没有采用更重的多 provider 抽象。

### 2.3 自动编辑与安全边界

智能体问：

> Agent 生成修改后，应该怎么落地？
> A. 先生成 patch/diff，用户确认后应用
> B. 直接编辑文件，但每个文件写入前确认
> C. 默认自动编辑，失败或高风险时再确认

我选择 **C**。这修正了更保守的默认路径：项目目标不是只做建议器，而是做真正可用的 coding agent。但智能体随后把这个选择约束为“常规代码文件自动修改，敏感路径、批量删除、配置凭证、锁文件等触发确认”，避免自动化越界。

### 2.4 Agent Loop 形态

在已经确定“小范围代码修改”后，智能体提出三种执行方式：

> A. 保守 Agent Loop：每轮只允许一个工具动作
> B. 批量计划 + 分步执行
> C. 自主循环优先

它推荐 **B：批量计划 + 分步执行**，我采纳。这个建议直接影响了后续 spec：Agent 先展示计划，再按步骤搜索、读取、编辑、测试和展示 diff。

### 2.5 Project Memory

我主动补充：

> 要在项目的根目录放一个 Claude.md 作为项目级记忆和规范

智能体采纳并扩展为 Project Context Loader：

- 启动时读取项目根目录 `Claude.md`
- 可兼容 `CLAUDE.md`
- `/init` 可生成初始 `Claude.md`
- 上下文优先级为：安全规则 > 当前用户明确指令 > `Claude.md` > Agent 默认策略

这个补充让 spec 不只是“工具调用器”，而是具备项目级规范入口。

## 3. 至少 3 轮关键迭代与处理决策

### 迭代 1：从完整设想到 MVP

对话节选：

> 智能体：你希望第一版 MVP 优先做到哪一级？
>
> 我：B

处理决策：

- 采用“可用型本地助手”作为 MVP。
- 保留真实编辑、测试、diff 展示。
- 暂缓多轮长期记忆、上下文压缩、完整 Claude Code 级自治。

影响：

- Spec 的 `Out of Scope For MVP` 明确排除了 full-screen TUI、多 repo、长期跨项目记忆、大型重构和 daemon。

### 迭代 2：安全模式从保守确认变成自动编辑 + 风险确认

对话节选：

> 智能体：编辑权限怎么设？
>
> 我：C

处理决策：

- 不采用“所有修改先 patch 再确认”。
- 默认允许普通源码小范围自动编辑。
- 高风险文件、删除、锁文件、凭证、批量修改等需要确认。

影响：

- Permission Guard 成为核心模块。
- Plan 中必须覆盖路径 containment、敏感文件识别、命令风险分类和确认回调。

### 迭代 3：Agent Loop 采用批量计划 + 分步执行

对话节选：

> 智能体：我的推荐是 B：批量计划 + 分步执行。
>
> 我：B

处理决策：

- Agent 先输出结构化 plan。
- CLI 需要把 plan 打印给用户。
- 工具调用按观察结果继续推进。

影响：

- 这后来也暴露出一个冷启动缺陷：最初 plan 写了 plan 事件，但没有真正要求 CLI 打印 plan。该问题在 writing-plan 反馈后修订。

### 迭代 4：加入 `Claude.md`

对话节选：

> 我：要在项目的根目录放一个 Claude.md 作为项目级记忆和规范
>
> 智能体：可以，这个很关键。

处理决策：

- 将 `Claude.md` 纳入 spec 的 Project Memory。
- `/init` 负责生成初始文件。
- `Claude.md` 不存密钥，只存项目规范、常用命令、目录说明、禁止触碰文件和偏好。

影响：

- Plan 增加 `src/project-context.ts`、配置加载、项目根目录上下文和测试项。

### 迭代 5：writing-plan 冷启动反馈后的计划修订

对话节选：

> 我：如果模型一直返回 invalid JSON，或者一直返回 plan，循环不会触发上限，这个要调整
>
> 我：LLM 系统提示词要说明每一个工具的参数
>
> 我：task11 里改了 runCommandTool 签名，但测试更新不完整
>
> 我：没有真正打印 plan
>
> 我：工具执行最好加 try/catch
>
> 我：runDiffTool 里不要用字符串拼路径

处理决策：

- 不把这些当作小修小补，而是视为第二 agent 仅凭 SPEC + PLAN 暴露出的 spec/plan 可执行性缺陷。
- 主要修订 PLAN，而不是重写 SPEC，因为产品意图大体正确，问题集中在执行计划的精确性和代码块一致性。

## 4. AI 建议的采纳、推翻与修正

### 4.1 AI 提出并采纳

- **Node.js + TypeScript**：适合 CLI、流式输出、工具编排和 npm 分发。
- **批量计划 + 分步执行**：比单步工具循环更接近实际 coding agent，又比完全自治更容易验证。
- **工作区限定为启动目录**：简单、可审计，避免多 repo 访问边界复杂化。
- **自定义 JSON 工具协议**：兼容更多 OpenAI-compatible 模型。
- **Git-first diff + 非 Git 快照 fallback**：兼顾真实仓库和无 Git 项目。
- **硬性循环限制**：单任务工具调用上限、修改文件上限、连续失败上限等。

### 4.2 AI 提出但我修正或没有采纳

- **Provider Adapter 架构**：AI 推荐作为 MVP 边界，但我选择 OpenAI-compatible API 优先。原因是第一版更重视快速可用和兼容常见国产/兼容模型服务，不希望一开始设计多 provider 抽象。
- **先生成 patch/diff，确认后应用**：AI 提供的保守选项更安全，但我选择默认自动编辑。原因是项目目标是 coding agent，不是只读建议器；但需要用 Permission Guard 把风险动作拦住。
- **Bug 修复与测试验证作为主路径**：AI 推荐 bug fix 主路径，我修正为“小范围代码修改”。原因是第一版不只服务 bug fix，也要能做轻量调整、补测试和小重构。
- **内部快照优先 diff**：AI 推荐内部快照优先，我选择 Git-first。原因是大多数真实代码库有 Git，用户更熟悉 `git diff`；非 Git 再用快照 fallback。

## 5. 第二 agent / 冷启动验证记录

### 5.1 执行方式

按要求，冷启动验证的目的不是让主 agent 凭共享上下文自证 spec 清晰，而是让一个不同上下文的实现者仅凭 SPEC + PLAN 尝试推进 1-2 个任务。

冷启动约束：

- 不导入 brainstorming 对话历史。
- 仅依据 SPEC 和 PLAN。
- 从 PLAN 中挑选 1-2 个实现切片试读/试实现。
- 遇到不确定之处暂停提问，而不是凭猜测继续。

### 5.2 暂停点、暴露的缺陷与判断

| 冷启动暂停点 | 暴露的问题 | 归因 | 处理决策 |
| --- | --- | --- | --- |
| Agent loop / Task 8 | 如果模型一直返回 invalid JSON，或一直返回 `plan`，只按工具调用计数不会触发上限。 | PLAN 缺陷。Spec 说有 loop limit，但 plan 把上限绑定到 tool call，漏掉非工具 LLM turn。 | 增加 `maxLlmTurns`，invalid JSON repair 和 repeated plan 都消耗 LLM turn。 |
| LLM prompt / Task 7 | 系统提示词没有列出每个工具的参数结构。 | PLAN 缺陷。Spec 有工具列表，但不足以让实现者写出精确 prompt。 | 在 system prompt 中明确 `search/read/edit/command/diff` 的 JSON 参数。 |
| Command tool / Task 11 | `runCommandTool` 签名改变后，测试更新不完整。 | PLAN 内部一致性缺陷。 | 补齐测试迁移，所有调用点改为新签名。 |
| CLI / Task 9 | Plan 被 agent 产生，但 CLI 没有真正打印。 | PLAN 缺陷，也会违背 Spec 的用户体验。 | 增加 `formatPlan` 和 `onPlan` 回调，在工具执行前输出 plan。 |
| Tool Router / Task 6/11 | 工具执行缺少 try/catch，工具抛错会打断 loop，而不是变成 observation。 | PLAN 与 Spec 不一致。Spec 写了工具失败应成为 observation。 | 增加 `safeDispatch`，捕获异常并返回失败 observation。 |
| Diff tool / Task 6 | `runDiffTool` 用字符串拼路径，跨平台和路径规范性差。 | PLAN 代码质量缺陷。 | 改用 `join(root, file)`。 |

### 5.3 与原意不一致的解读

- 冷启动实现者可能会把“最多 20 次工具调用”理解为完整 loop 上限；但模型反复返回 invalid JSON 或 plan 时没有任何工具调用。这不是它读错，而是 PLAN 没写清楚。
- 冷启动实现者可能会认为“Agent 输出 plan”已经满足“展示 plan”；但用户可见 CLI 没有打印。这是 PLAN 把内部事件和用户输出混淆了。
- 冷启动实现者可能沿用 `runCommandTool(root, args)` 旧签名，因为 Task 11 只更新了部分代码块和测试。这是 PLAN 自身不一致。
- 冷启动实现者可能接受 `` `${root}/${file}` ``，因为在类 Unix 路径上看似能跑；但本项目运行在 Windows 工作区，必须使用路径 API。这是 PLAN 代码块的可移植性缺陷。

### 5.4 产出与预期差距

如果不修订 PLAN，正式实现会出现明显偏差：

- LLM 可在 invalid JSON/重复 plan 状态下无限循环。
- 用户看不到计划，违背 CLI 体验设计。
- 工具异常会直接崩溃，而不是进入可观察、可恢复的 agent loop。
- Task 11 的实现和测试会因函数签名迁移不完整而失败。
- Diff 工具在 Windows 路径上存在脆弱实现。

差距判断：**中高**。这些不是审美问题，而是会影响 MVP 是否可运行、是否安全、是否符合 spec 的问题。

## 6. 根据冷启动反馈做出的关键修订 diff

以下为关键逻辑 diff 摘要，重点记录修订方向，而不是完整文件 diff。

### 6.1 Agent loop: 工具调用上限改为 LLM turn 上限 + 工具上限

修订前：

```diff
- while (session.toolCallCount < maxToolCalls) {
-   const raw = await llm.complete(messages);
-   const parsed = parseModelResponse(raw);
-   ...
- }
```

修订后：

```diff
+ let llmTurnCount = 0;
+ const maxLlmTurns = input.maxLlmTurns ?? DEFAULT_MAX_LLM_TURNS;
+ while (llmTurnCount < maxLlmTurns) {
+   llmTurnCount += 1;
+   const raw = await llm.complete(messages);
+   const parsed = parseModelResponse(raw);
+   ...
+   if (toolCallCount >= maxToolCalls) {
+     return stopBecauseToolLimitReached();
+   }
+ }
```

新增测试：

- repeated invalid JSON 会在 LLM turn limit 停止。
- repeated `plan` response 会在 LLM turn limit 停止。

### 6.2 LLM system prompt: 明确工具参数

修订前：

```diff
- You may call tools: search, read, edit, command, diff.
```

修订后：

```diff
+ Available tools and arguments:
+ - search: { "query": string }
+ - read: { "path": string }
+ - edit: { "path": string, "oldText": string, "newText": string }
+ - command: { "command": string }
+ - diff: {}
+ Return exactly one JSON object matching the protocol.
```

### 6.3 CLI: 真正打印 plan

修订前：

```diff
- const result = await runAgentTask({ userRequest, context, llm });
```

修订后：

```diff
+ export function formatPlan(_summary: string, steps: string[]): string {
+   return ["Plan:", ...steps.map((step, index) => `${index + 1}. ${step}`)].join("\n");
+ }
+
+ const result = await runAgentTask({
+   userRequest,
+   context,
+   llm,
+   onPlan: (plan) => console.log(formatPlan(plan.summary, plan.steps))
+ });
```

### 6.4 Router: 工具异常转为 failed observation

修订前：

```diff
- return dispatch(root, session, call, options);
```

修订后：

```diff
+ async function safeDispatch(root, session, call, options) {
+   try {
+     return await dispatch(root, session, call, options);
+   } catch (error) {
+     return {
+       ok: false,
+       tool: call.tool,
+       error: error instanceof Error ? error.message : String(error)
+     };
+   }
+ }
+
+ return safeDispatch(root, session, call, options);
```

### 6.5 `runCommandTool` 签名迁移补齐测试

修订前：

```diff
- const result = await runCommandTool(root, { command: "npm test", timeoutMs: 1000 }, executor);
- const denied = await runCommandTool(root, { command: "git reset --hard" });
```

修订后：

```diff
+ const result = await runCommandTool(root, session, { command: "npm test", timeoutMs: 1000 }, {
+   executor,
+   confirm
+ });
+ const denied = await runCommandTool(root, session, { command: "git reset --hard" }, {
+   confirm
+ });
```

### 6.6 `runDiffTool`: 路径 API 替代字符串拼接

修订前：

```diff
- const after = await readFile(`${root}/${file}`, "utf8");
```

修订后：

```diff
+ import { join } from "node:path";
+ const after = await readFile(join(root, file), "utf8");
```

## 7. 对 Superpowers Brainstorming 的反思

### 做得好的地方

- **问题顺序合理**：先问范围，再问技术栈、模型接入、权限、工作区、CLI、协议、diff 和任务主路径，避免一开始沉迷实现细节。
- **能把模糊想法变成边界**：从“Claude Code 启发的 coding agent”收敛到“小范围代码修改”的 MVP。
- **安全边界被系统性提出**：文件访问、命令执行、敏感路径、危险命令、diff 和回滚都被纳入 spec。
- **能接住我的补充**：例如 `Claude.md` 不是它最初提出的，但它很快把它放进 Project Context Loader 和优先级模型里。
- **writing-plan 自检有效**：后续计划不仅写任务，还能根据反馈修订 loop limit、prompt、router、CLI 输出和测试迁移。

### 不满意的地方

- **初版 plan 对冷启动实现者不够友好**：很多隐性意图主 agent 知道，但 PLAN 没写到可执行粒度，比如 plan 事件如何显示、工具参数 schema、异常如何转 observation。
- **对自动编辑风险的追问还可以更强**：我选择默认自动编辑后，智能体接受得较快，虽然补了 Permission Guard，但本可以更早要求明确批量修改阈值、敏感文件列表和确认文案。
- **代码块重复导致后续修订容易漏**：Task 8 和 Task 11 都涉及 agent/router 代码替换，第一次修订时需要同步多个片段，说明计划结构有维护成本。
- **Spec 与 Plan 的责任边界不够清晰**：一些问题是产品要求，一些是实现策略。冷启动反馈后才发现部分产品级要求只在对话里清楚，计划里不够清楚。
- **没有一开始就把“非工具 LLM turn”作为 loop 资源**：这是 agent loop 的核心风险，应该在 spec 初版就显式写出。

## 8. 结论

这次 Superpowers 协作最大的价值，是把一个容易膨胀的 coding agent 想法压缩成可实现、可测试、可审查的 MVP。同时，冷启动反馈证明：仅有主 agent 与用户之间的共识是不够的；spec/plan 必须让没有上下文的新实现者也能正确执行。

后续正式实现时，应继续保持两个原则：

1. 每个 task 都要能被只读 SPEC + PLAN 的 agent 独立理解。
2. 凡是主 agent “心里知道”的约束，都必须落到文档、测试或代码接口里。
