# REFLECTION.md

## 1. 哪些 Superpowers 技能最有用，哪些形式大于实质

最有用的是 `writing-plans`、`subagent-driven-development`、`test-driven-development`、`requesting-code-review` 和 `verification-before-completion`。它们分别解决了一个关键问题：计划把模糊需求拆成可执行切片，subagent 工作流把实现和审查分离，TDD 把审查反馈变成可回归证据，代码审查持续发现安全边界，最终验证避免“看起来完成”的错觉。

其中作用最大的是 `requesting-code-review`。很多真正有价值的修正都不是实现者第一次写出来的，而是审查阶段抓出来的：Task 4 的命令注入和 PowerShell 递归别名、Task 5 的 symlink 越界和无效 UTF-8、Task 11 的 canonical realpath approval 与 TOCTOU、Task 12 的 Git diff fallback 和失败写入状态污染。这些问题如果没有独立审查，很容易被“测试通过”掩盖。

相对形式大于实质的是部分流程性技能的固定仪式。例如每个小任务都要求完整的实现者、规格审查者、质量审查者三段式，有时对 Task 3 这种边界清楚的配置加载显得偏重；每个 task 都开 PR 也让收尾成本明显上升。它的价值在于证据链，不在于效率。换句话说，作为课程或审计产物很有效，作为日常小改动的默认流程会偏重。

## 2. TDD 在 AI 协作下是阻碍还是放大器

结论是：TDD 是放大器，但不是所有场景都等价放大。

在安全、协议、状态机、diff、agent loop 这些模块里，TDD 明显放大了 AI 协作能力。AI 很擅长写“看起来合理”的实现，也很容易漏掉边界。先写失败测试会迫使 subagent 把问题具体化。例如 Task 4 中，审查发现 allowlisted 命令可嵌入 `$()`、换行命令、split flag 删除命令、PowerShell `Remove-Item -rec`，每次都先补失败测试再修分类器，这让安全规则从口头判断变成可执行约束。Task 11 的 TOCTOU 修复也一样，只有测试覆盖“批准目标”和“执行目标”绑定，才算真正修掉。

它的阻碍主要出现在脚手架、文档、简单 glue code 上。Task 1 的 CLI smoke test 有价值，但围绕 `dist` 测试重复发现的审查来回就暴露出一个问题：TDD 会把工程配置细节提前放大，短期打断实现节奏。不过这个阻碍不是坏事，因为后续 12 个 task 都依赖干净测试环境。我的判断是：TDD 对 AI 协作不是减速器，而是把隐性风险提前收费。

## 3. Subagent-driven 工作流能自主运行多久而不偏离

它能稳定自主运行“一个边界清晰 task”到提交级别，通常是 1 个模块或 1 条行为链路，加上对应测试。比如 Task 2 的协议解析器、Task 3 的配置上下文、Task 7 的 LLM client，subagent 基本可以根据 task 文本完成实现、提交，并接受审查反馈。

但它不能长时间无监督地跨 task 自主推进。原因不是模型不努力，而是跨 task 的隐性约束会不断累积。Task 11 是最典型的例子：计划片段基于早期代码，而前面 Task 5/8/9 已经加入 symlink/UTF-8 防护、plan-before-tool、session-authoritative final、slash error boundary。如果让 subagent 直接“按计划替换代码”，很可能回退前面的安全修复。主控必须明确提示：按 Task 11 的行为目标改造，但保留已硬化语义。

所以最可靠的自主长度是：subagent 负责一个 task 的实现和局部修复；主控负责 task 边界、审查判断、跨 task 语义一致性和最终全局复核。超过这个长度，漂移风险会明显上升。

## 4. 什么样的 task 颗粒度最优

最优颗粒度是“一个可命名能力 + 一组聚焦测试 + 可独立审查的文件边界”。它应该小到 subagent 能把上下文完整装进脑子里，又大到能交付用户可理解的能力。

本项目里比较好的颗粒度包括：

- Task 2：JSON Protocol Parser，文件少、接口清楚、测试直接。
- Task 5：Session State and File Tools，虽然风险高，但边界明确，能集中处理文件工具安全。
- Task 8：Agent Orchestrator Loop，行为复杂但主题统一，适合用集成式测试钉住顺序和状态。

偏大的 task 是 Task 11：confirmation paths、loop limits、router、process tool、agent、CLI final diff 都在同一块里。它不是不可做，但审查成本显著更高，而且很容易踩到已有安全修复。偏小的 task 是某些文档或配置修复，如果也强行走完整三段审查和 PR，会让流程成本超过产出。

我会把最佳范围定义为：普通 task 1-4 个源文件、1-2 个测试文件、一个主提交；安全或 orchestration task 可以更大，但必须预留复审和补丁提交。

## 5. SPEC / PLAN 质量如何影响实现质量

SPEC 决定“要什么”，PLAN 决定“别人能不能在没有对话历史的情况下做对”。这次最明显的案例是“plan 展示”。

产品意图是 agent 先展示计划，再执行工具。但早期 plan 只写了 agent loop 中会接收 `plan` response，没有明确 CLI 必须把 plan 打印给用户。冷启动实现者可能合理地认为“内部 session 记录了 plan”就满足要求，结果用户不可见。这不是 subagent 偷懒，而是规约把内部事件和用户体验混在一起。后来通过 `formatPlan` 和 `onPlan` 回调修正，确保工具执行前有用户可见输出。

另一个案例是 loop limit。Spec 说要有循环限制，但 plan 初版把限制绑定到 tool call。这样模型如果一直返回 invalid JSON 或重复 `plan`，不会产生任何工具调用，也不会触发工具上限。修正后加入 `maxLlmTurns`，把 invalid JSON repair 和 repeated plan 都算作 LLM turn。这个案例说明：PLAN 里的资源模型如果不精确，subagent 会实现一个“看似符合文字、实际不安全”的版本。

## 6. 最有效的 prompt / context 策略

最有效的策略是“窄上下文 + 强边界 + 审查角色分离”。

给实现 subagent 时，不让它自由浏览整个历史，而是给它当前 task 的完整文本、允许修改的文件范围、必须先写失败测试的要求、已知依赖和不能回退的历史修复。这样它的注意力集中在当前能力，不会被整个 plan 的后续任务诱导提前实现未来功能。Task 10 中 README 提前承诺 final diff 就是反例：它看到未来功能很近，于是把未来事实写进当前文档，审查必须把它拉回当前 task 事实。

给审查 subagent 时，最有效的是明确 base/head 范围和审查类型。规格审查看“是否符合 task 要求”，代码质量审查看“是否有 bug、安全风险、缺测试”。这两个 prompt 分开后，审查更锋利。Task 1 里 `dist` 测试重复发现是否违反计划，就是规格审查先判断范围，质量审查再判断工程风险，最后主控决定修。

对主控来说，最有效的 context 策略是持续维护“事实权威”：commit hash、测试输出、session 状态、diff 范围，而不是相信模型总结。最终 `AGENT_LOG.md` 和 plan 顶部 commit 表，本质上都是把聊天里的过程压缩成可核验索引。

## 7. 凭据与分发迫使我想清楚的问题

凭据要求迫使项目从一开始就区分“配置可用”和“秘密不可泄露”。这带来了几个原本容易忽略的问题：`.code-agent/config.json` 必须被 ignore；环境变量和本地 config 都可以读，但展示时必须 mask；`Claude.md` 可以存项目规范，不能存密钥；敏感文件如 `.env` 不能被普通 read/edit 自动访问；错误信息和 README 示例不能鼓励用户把真实 key 写进仓库。

分发要求迫使项目不只是“源码能跑”，还要“作为 CLI 安装后能跑”。这影响了 `package.json` 的 `bin`、Node 20 engine、ESM entry、`dist/src/index.js --help` 验证、README 用法、`npm run build` 与 `npm test` 的关系。Task 1 的 `dist` 测试重复发现问题，本质上就是分发产物和测试发现范围之间的冲突。分发还放大了 Windows 兼容性问题：路径不能用字符串拼接，大小写敏感假设不能写进测试，PowerShell 命令分类不能只按 Unix shell 思维设计。

## 8. 如果重做，我会改变什么

第一，我会把安全模型更早写成单独的 threat model。实际实现中，symlink、canonical realpath、TOCTOU、敏感文件、PowerShell 参数别名都是逐步被审查挖出来的。如果一开始就把“表面路径 vs 真实目标”“批准对象 vs 执行对象”“命令字符串 vs shell 解释”列成威胁模型，Task 4/5/11 会少几轮返工。

第二，我会把 Task 11 拆成两个任务：一个处理 confirmation/canonical target，一个处理 loop limits/CLI final diff。它们都重要，但耦合在同一 task 里让审查面太大。

第三，我会要求 PLAN 的每个 task 都写“不得回退的已有语义”。到了中后期，subagent 最大风险不是不会实现新功能，而是用旧代码片段覆盖掉前面审查驱动的硬化。

第四，我会在 spec 阶段就定义“事实来源优先级”：session 状态高于模型 final，自有 diff 高于模型描述，测试命令记录高于模型声称 passed。这个规则后来证明非常关键。

第五，我会减少文档类 task 的流程重量。对于纯记录型提交，保留验证和审查即可，不需要机械复制完整实现 task 的仪式。

## 9. 对 Superpowers 方法论的批判

Superpowers 方法论假设几件事：需求可以先被充分规格化；实现可以拆成相对独立的小任务；测试能表达关键正确性；审查者能发现实现者漏掉的风险；主控 agent 有能力协调多 subagent 并保持全局语义一致。

这些假设在本项目里大体成立。原因是这个项目本身就是一个可模块化的 CLI coding agent：协议、配置、权限、session、文件工具、router、LLM client、agent loop、CLI 都有清晰边界；Vitest 也适合快速表达行为约束。因此 Superpowers 的结构化流程确实放大了产出质量。

但这些假设不是无条件成立。首先，需求并不能一次性规格化完全。很多关键问题是在冷启动和代码审查后才暴露的，例如 non-tool LLM turn、plan 是否用户可见、confirmation 是否绑定真实路径。其次，测试不能完全覆盖用户体验和安全语义，必须靠审查和主控判断补足。第三，subagent 的“独立性”有上限：它擅长局部实现，不擅长记住跨 task 演化出来的隐性约束。第四，流程有明显固定成本，在小任务上会显得重。

因此我对这套方法论的评价是：它不是让 AI 自动写完项目的魔法，而是一套把 AI 产出变得可约束、可审查、可追责的工程脚手架。它最适合高风险、长链路、需要过程证据的项目；不适合所有日常小改都照搬全套仪式。真正有效的不是“使用了多少技能”，而是每个技能是否把某个具体风险变成了更清楚的约束。

## 10. 总结

这次开发最重要的收获是：AI 协作的核心不是让模型一次写对，而是建立一个系统，让模型写错时能被及时发现、被测试固定、被审查解释、被文档记录。Superpowers 的价值正在这里。它有形式化负担，也有方法论假设，但在这个项目中，TDD、subagent 审查、工作区隔离、最终验证和过程日志共同把一个容易发散的 coding agent 想法压成了可运行、可审计、可复盘的工程产物。
