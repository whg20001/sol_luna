# Sol / Luna Router 当前模型架构

> 对应实现：`pi-sol-luna-router@2.1.0`  
> 架构代号：Sol / Luna Router v2.1  
> 最后同步：当前工作区实现

## 1. 架构定位

Sol / Luna Router 是一个面向 Pi、Codex、DeepSeek 及其他 Agent Harness 的多模型任务运行时。它不把多个 Agent 简单串联，而是通过统一的路由服务强制执行：

- Root Planner 只负责规划、调度和最终决策。
- Luna 是默认实现 Worker。
- Validator 采用 Fast / Deep 两级只读验证。
- Sol 只在累计两次会计入 Luna 熔断的失败后执行一次恢复；计数来源可以是 Deep Validator 失败，也可以是 Luna 执行异常或非法输出。
- 所有 Worker 调用都经过策略授权、上下文投影、预算计算、模型选择、持久化、派发和结构化结果校验。
- Worker 的自报成功不能直接完成任务，任务必须由 Validator 或可信宿主验证通过。

v2.1 在 v2.0 的 Context Envelope、Task Memory、Failure Snapshot 和状态机之上增量增加：

- Reasoning Profile Freeze
- Execution Policy Engine
- Context Projection
- Fast / Deep Validator
- Decision Summary
- Semantic Memory
- 动态 Token Budget
- Model Performance Ranking
- Runtime Lifecycle Events

## 2. 版本矩阵

为了兼容 v1 路由文件和 v2.0 快照，系统中的版本号并不全部同时升级。

| 层级 | 当前版本 | 说明 |
|---|---:|---|
| npm 包 | `2.1.0` | 当前发布版本 |
| Router Worker Protocol | `2.1` | Worker 请求和严格 Prompt 协议 |
| Reasoning Profile | `2.1` | 冻结的角色推理配置 |
| Context Envelope Schema | `2.0` | 保持 v2.0 Envelope 兼容 |
| Task Memory Schema | `2.0` | 保持 v2.0 Memory 兼容 |
| Core State Protocol | `2.0` | `state.protocol` 保持兼容 |
| Snapshot 外层格式 | `1` | `{ version: 1, state: ... }` |
| Model Route 配置 | `1` 或 `2` | v1 自动补全 Planner 和 Validator |
| Managed Marker | `v2` | 可安全升级 v1 两 Agent Marker |
| Project Runtime Pause | `1` | `.pi/sol-luna-runtime.json`; 缺失表示 active |

## 3. 总体组件图

```text
User
  |
  v
+------------------------------------------------------------------+
| Host / Root Planner                                              |
| Pi parent session、Codex harness、DeepSeek harness 或自定义宿主   |
| - 理解目标                                                       |
| - 定义 acceptance / constraints / complexity / taskType         |
| - 调用 Router API                                                |
| - 不直接执行实现修改                                             |
+------------------------------+-----------------------------------+
                               |
                               v
+------------------------------------------------------------------+
| Router Service                                                   |
|                                                                  |
|  +----------------------+   +---------------------------------+  |
|  | Core State Machine   |   | Execution Policy Engine         |  |
|  | phase + stage        |   | frozen profile + next action    |  |
|  +----------------------+   +---------------------------------+  |
|                                                                  |
|  +----------------------+   +---------------------------------+  |
|  | Task Memory          |   | Context Projection              |  |
|  | 5 logical layers     |   | Root/Luna/Fast/Deep/Sol views   |  |
|  +----------------------+   +---------------------------------+  |
|                                                                  |
|  +----------------------+   +---------------------------------+  |
|  | Token Budget         |   | Model Routing / Ranking         |  |
|  | complexity+feedback  |   | availability+history            |  |
|  +----------------------+   +---------------------------------+  |
|                                                                  |
|  +----------------------+   +---------------------------------+  |
|  | Prompt Protocol      |   | Runtime Events                  |  |
|  | fixed prefix+JSON    |   | bounded lifecycle telemetry     |  |
|  +----------------------+   +---------------------------------+  |
+-----------+----------------------+-------------------+-----------+
            |                      |                   |
            v                      v                   v
+----------------------+  +----------------------+  +----------------------+
| Luna Worker          |  | Validator Worker     |  | Sol Recovery Worker  |
| implementation       |  | fast / deep          |  | one recovery attempt |
| medium by default    |  | read-only            |  | fixed high reasoning |
+----------------------+  +----------------------+  +----------------------+
```

## 4. Agent 角色与能力边界

### 4.1 Root Planner

Root Planner 是宿主父会话，不是 Router 派发的普通 Worker。

职责：

- 理解用户目标、风险和兼容性约束。
- 定义验收标准和任务复杂度。
- 启动任务并准备下一次 Worker 请求。
- 按 Execution Policy 调度 Luna、Validator 或 Sol。
- 读取状态和验证结论，向用户报告最终结果或升级问题。

限制：

- 不把 Luna 或 Sol 的成功声明当作最终完成。
- 不绕过 `prepare -> dispatch -> record` 生命周期。
- 在 Pi 适配器激活后，Root 的 `edit`、`write` 和 `bash` 调用全部被阻止。
- 在 Pi 中只能调用已准备的 `luna-worker`、`validator-worker` 或 `sol-worker`，非托管 Agent 被阻止。

默认推理级别为 `high`，但 Pi 可从 Planner Model Route 冻结实际 thinking。

### 4.2 Luna Executor

Luna 是默认实现 Worker。

职责：

- 检查与当前任务直接相关的文件。
- 实现最小、正确且兼容的修改。
- 执行聚焦检查并记录事实证据。
- 返回严格 JSON，实现报告必须包含 Decision Summary。

Pi 模板能力：

```text
read, grep, find, ls, bash, edit, write
```

约束：

- 每次必须是新的隔离调用，禁止 resume。
- 不允许自行切换模型或 thinking。
- 最多允许两次会影响熔断计数的 Luna 实现尝试。

默认推理级别为 `medium`，可在任务开始时根据路由配置和复杂度冻结。

### 4.3 Validator

Validator 是只读 Worker，分为 Fast 和 Deep 两种模式。

共同职责：

- 按 acceptance criteria 检查 Artifact Memory 和代码证据。
- 独立判断实现是否通过。
- 返回严格 JSON，不修改项目文件。

Pi 模板能力：

```text
read, grep, find, ls, sol_luna_validate
```

`sol_luna_validate` 只提供以下非项目脚本检查：

```text
node-check       # .js/.mjs/.cjs 语法检查
json-check       # JSON 解析检查
git-diff-check   # git diff --check
git-status       # git status --short
```

安全边界：

- 路径经过词法归一化后必须位于当前项目内。
- 对规范化项目根目录下的每一级路径执行 `lstat`，拒绝中间目录及最终目标的符号链接，要求最终目标为普通文件，并通过 `realpath` 复核目标仍在项目内。项目根本身可以使用合法别名路径。
- 这不是抗并发路径替换的文件系统沙箱；恶意进程同时替换目录的竞态仍需宿主隔离。
- 不执行 `npm test`、lint 脚本或任意项目代码。
- 编译、测试和 lint 结果由 Validator 检查 Artifact 中的证据；需要执行项目代码的强验证应由受控 Harness、CI 或外部只读沙箱提供。

#### Fast Validator

- 默认模式。
- 主要检查 acceptance、constraints、diff 和现有验证证据。
- 默认 thinking 为 `low`。
- Fast 失败、执行异常或非法 JSON **只升级到 Deep Validator**。
- Fast 失败不增加 `lunaValidationFailures`，也不创建实现失败快照。

#### Deep Validator

- 在 Fast 失败后执行。
- 当 objective 或 constraints 中包含高风险、安全、架构、公开 API 或向后兼容信号时，可直接进入 Deep；单独的 `risk` 字段只有在直接调用 Policy API 时才参与判断，当前 Router `start_task` 不持久化该字段。
- 除 Fast 内容外，还加载任务状态与 Failure Memory。
- 默认 thinking 为 `medium`。
- 在 Validator 路径中，只有 Deep 失败才推进 Luna/Sol 熔断流程并创建 Failure Snapshot；Luna Worker 自身的执行异常或非法输出可绕过 Validator，直接计入失败。

### 4.4 Sol Recovery

Sol 是熔断后的单次恢复 Worker。

启动前提：

- Luna 已累计两次计入熔断的失败（Deep 验证失败、执行异常或非法输出）。
- `phase` 为 `open`。
- 当前任务存在最新 Failure Snapshot。
- 本任务尚未启动过 Sol。

职责：

- 使用最新 Failure Snapshot 和 Decision Summary 恢复。
- 从已有进度、已修改文件和错误证据继续。
- 不重新探索整个项目。
- 只实施一次最小安全恢复。

Pi 模板能力：

```text
read, grep, find, ls, bash, edit, write
```

Sol thinking 在 Reasoning Profile 中固定为 `high`。每个任务只允许一次新的 Sol 调用，禁止 resume 或 Luna/Sol 热切换。

## 5. Reasoning Profile Freeze

每个任务在启动时生成并冻结一个 v2.1 Reasoning Profile：

```json
{
  "version": "2.1",
  "taskId": "task-123",
  "complexity": "medium",
  "roles": {
    "planner": { "thinking": "high" },
    "luna": { "thinking": "medium" },
    "validator": {
      "fast": { "thinking": "low" },
      "deep": { "thinking": "medium" }
    },
    "sol": { "thinking": "high" }
  },
  "frozenAtRevision": 1
}
```

冻结规则：

- 同一任务不能改变 complexity。
- 同一任务不能覆盖角色 thinking。
- 所有 Worker 都复用同一个冻结 Profile。
- 相同 Profile 重复冻结是幂等操作。
- 新任务可以创建新的 Profile。
- Sol 不从 Luna 动态升级，也不会被降级。

Pi 启动任务时会从实际 Model Routes 构建 Profile，并尝试将 Planner 模型和 thinking 应用于当前父会话。

## 6. Execution Policy Engine

`src/execution-policy.js` 根据以下输入做确定性决策：

- 当前 `phase` / `stage`。
- Luna 验证失败次数。
- Sol 是否已使用。
- 最新 Failure Snapshot 是否存在。
- Fast Validator 是否失败。
- 风险、架构、安全和 API 兼容关键词。
- 冻结的 Reasoning Profile。

主要输出：

```json
{
  "allowed": true,
  "nextAction": "run_validator",
  "role": "validator",
  "reasonCode": "VALIDATOR_DEEP_AFTER_FAST_FAILURE",
  "reason": "Fast validation failed; run the deep Validator.",
  "validatorMode": "deep",
  "projection": {
    "version": "2.1",
    "taskId": "task-123",
    "complexity": "medium",
    "role": "validator",
    "validatorMode": "deep",
    "thinking": "medium",
    "frozenAtRevision": 1
  },
  "budgetRole": "validator"
}
```

策略可能返回：

```text
run_luna | run_validator | run_sol | complete | escalate | wait
```

显式请求只有与策略要求的 action、role 和 validator mode 一致时才被授权。Profile 漂移会返回 `REASONING_PROFILE_DRIFT`。

自定义 Policy 插件接收内部数据的深拷贝；抛错时回退到默认策略，不能通过修改参数污染 Router 内部状态。

## 7. 状态机与验证闭环

系统保留兼容的粗粒度 `phase`，同时使用细粒度 `stage`。

### 7.1 主流程

```text
idle
  |
  | start_task + freeze profile
  v
planning
  |
  | Luna prepared/dispatched
  v
executing (Luna)
  |
  | Luna report recorded
  v
validating
  |
  +--> Fast Validator passed ---------------------------> passed
  |
  +--> Fast Validator failed/error/invalid JSON
  |                  |
  |                  v
  |              Deep Validator
  |                  |
  |                  +---------------- passed ----------> passed
  |                  |
  |                  +---------------- failed
  |                                      |
  |                                      v
  |                               Failure Snapshot
  |                                      |
  |                         +------------+------------+
  |                         |                         |
  |                  first Luna failure        second Luna failure
  |                         |                         |
  |                         v                         v
  |                  Luna retry                 circuit open
  |                                                   |
  |                                                   v
  |                                            Sol Recovery once
  |                                                   |
  |                                                   v
  +-------------------------------------------- validation
                                                      |
                                               +------+------+
                                               |             |
                                             passed       escalated
```

### 7.2 `phase`

```text
idle | luna | open | sol-recovery | passed | escalated
```

### 7.3 `stage`

```text
idle
planning
executing
validating
failure_snapshot
recovery
passed
escalated
```

### 7.4 核心状态字段

```json
{
  "protocol": "2.0",
  "taskLabel": "升级路由器",
  "taskId": "task-123",
  "contextId": "ctx-task-123",
  "phase": "luna",
  "stage": "validating",
  "activeRole": "validator",
  "lunaValidationFailures": 0,
  "solAttempted": false,
  "attempts": {
    "luna": 1,
    "validator": 1,
    "sol": 0
  },
  "latestFailureSnapshotId": null,
  "reasoningProfile": {},
  "validatorMode": "fast"
}
```

状态恢复时会归一化并修复旧快照中不一致的 phase、stage、failure count 和 Sol 状态。

## 8. Task Memory

Task Memory schema 保持 `2.0`，当前由五个逻辑层组成。

```text
Task Memory
|
+-- Runtime Memory
|   +-- taskId / contextId
|   +-- status / role / attempt / validatorMode
|   +-- frozen Reasoning Profile
|   +-- bounded lifecycle events
|   +-- processed request IDs
|   +-- usage feedback
|
+-- Task Memory
|   +-- objective / taskType
|   +-- acceptance / constraints
|   +-- completed / pending / blocked
|   +-- currentTask
|
+-- Artifact Memory
|   +-- modifiedFiles
|   +-- diffSummary
|   +-- tests
|   +-- workerReports
|   +-- validationReports
|
+-- Failure Memory
|   +-- attemptHistory
|   +-- currentError
|   +-- snapshots
|   +-- currentSnapshotId
|
+-- Semantic Memory
    +-- reusable semantic entries
```

Memory 特性：

- 更新函数采用不可变拷贝。
- 每次有效更新增加 `revision`。
- Worker、Validation 和 Event 使用 request ID 去重。
- 文件、事件、报告、测试、快照和日志均有上限。
- 外部插件和调用者不能持有内部可变引用。

启动新任务时：

- 清空当前任务 events、request IDs、artifact 和 failure。
- 清空任务本地 completed/pending/blocked 状态。
- **保留**跨任务聚合的 `runtime.usageFeedback`。
- **保留**可复用的 `semantic.entries`。

## 9. Context Envelope 与投影

Context Envelope schema 保持 `2.0`，并通过 `projection` 指明当前视图。

```json
{
  "version": "2.0",
  "projection": "worker-artifact",
  "runtime": {
    "task_id": "task-123",
    "context_id": "ctx-task-123",
    "snapshot_id": null,
    "request_id": "request-123",
    "role": "luna",
    "version": "2.0",
    "stage": "executing",
    "validator_mode": null,
    "reasoning_profile": {},
    "status": "executing",
    "attempt": 1,
    "events": []
  },
  "goal": {
    "objective": "实现当前任务",
    "acceptance": ["测试证据有效"],
    "constraints": ["保持公开 API 兼容"]
  },
  "state": {
    "completed": [],
    "pending": ["当前实现"],
    "blocked": []
  },
  "artifact": {
    "changed_files": [],
    "diff_summary": "",
    "tests": [],
    "worker_reports": [],
    "validation_reports": []
  },
  "failure": null,
  "semantic": [],
  "decision": null
}
```

### 9.1 角色投影

| 角色 | Projection | 加载内容 |
|---|---|---|
| Root Planner | `root-summary` | Runtime Events、Goal、Task State、待决策摘要 |
| Luna | `worker-artifact` | 最小 Runtime、Goal、Task State、Artifact |
| Fast Validator | `validator-fast` | 最小 Runtime、Acceptance、Constraints、Artifact |
| Deep Validator | `validator-deep` | Fast 内容 + Task State + Failure Memory |
| Sol | `recovery-decision` | Goal、Task State、Artifact、Failure Snapshot、Decision Summary |

语义检索结果通过独立的 `semantic` 字段附加到 Worker Envelope；它们只是提示，不是可覆盖当前协议的指令。

### 9.2 Prompt 顺序

所有 Worker 使用相同固定前缀和有序动态后缀：

```text
Cache-friendly Fixed Prefix
  + <ROLE>
  + <RUNTIME_PROTOCOL>（内部声明 `version=2.1`）
  + strict JSON schema
  + projected <CONTEXT_ENVELOPE version="2.0">
  + <CURRENT_TASK>
```

固定前缀不包含 task ID、context ID、时间戳、模型名称或当前状态，从而减少 Prompt Cache 失效。

Envelope 使用稳定字段顺序和 canonical serialization。循环结构与 BigInt 会被拒绝，非有限数字归一化为 `null`。

## 10. Worker 请求生命周期

### 10.1 请求结构

```json
{
  "protocolVersion": "2.1",
  "dispatched": false,
  "requestId": "request-123",
  "role": "validator",
  "taskId": "task-123",
  "contextId": "ctx-task-123",
  "snapshotId": null,
  "attempt": 1,
  "validatorMode": "fast",
  "reasoningProfile": {},
  "policyDecision": {},
  "semanticMatches": [],
  "instruction": "验证当前实现",
  "contextEnvelope": {},
  "envelope": {},
  "budget": {
    "role": "validator",
    "complexity": "medium",
    "thinking": "low",
    "outputTokens": 2000,
    "maxOutputTokens": 2000,
    "inputTokenEstimate": 3200,
    "feedbackMultiplier": 1,
    "feedbackSamples": 0
  },
  "routing": {
    "provider": "openai",
    "model": "validator-model",
    "thinking": "low"
  },
  "renderedPrompt": "..."
}
```

`contextEnvelope` 和 `envelope` 是兼容别名。

### 10.2 生命周期

```text
prepareWorkerRequest
  -> persist prepared request
  -> markWorkerDispatched
  -> persist dispatched=true
  -> execute worker exactly once
  -> validate strict JSON
  -> recordWorkerReport / recordValidation
  -> persist resulting state
```

保护规则：

- 同一时间只允许一个 `pendingRequest`。
- 未准备的 Worker 不能派发。
- 同一 request 不能重复派发。
- 未标记 dispatched 的结果不能写入。
- 显式提供的 request ID 与 pending request 不匹配时结果被拒绝；Pi `tool_result` 还同时校验 task ID。
- `sol_luna_record_result` 为兼容旧调用允许省略 request ID，此时会采用当前 pending request，因此宿主应始终回传 prepare 阶段得到的 request ID，避免把迟到结果写入新请求。
- Pi 的 Agent 启动失败会清理对应 pending 状态并推进正确的失败流程。
- Session start、新任务和 reset 会清理 Pi 内存中的 dispatch 映射。
- Router 操作异常会恢复完整旧快照。
- Harness 在持久化失败时回滚状态，并串行化同一实例内的事务。

## 11. 严格结构化输出

所有 Worker 只能返回一个 JSON 对象，禁止 Markdown fence、前后说明和额外顶层字段。

### 11.1 Luna

```json
{
  "status": "success",
  "completed": [],
  "inspected_files": [],
  "changed_files": [],
  "diff_summary": "",
  "changes": [],
  "commands": [],
  "tests": [
    {
      "command": "npm test",
      "passed": true,
      "evidence": "94 tests passed"
    }
  ],
  "risks": [],
  "current_error": null,
  "decision_summary": {
    "attempt_goal": "完成当前实现",
    "approach": "最小增量修改",
    "reason": "与现有 API 兼容",
    "evidence": ["相关测试通过"],
    "not_attempted": ["未进行无关重构"],
    "next_action": "交给 Validator"
  }
}
```

Luna `status`：

```text
success | failed | blocked
```

只要 JSON Schema 合法，三种状态都会先作为 Worker Report 写入并进入 Validator；`failed` 或 `blocked` 不会在 `recordWorkerReport()` 中自动增加熔断计数，最终失败仍由 Validator 结论或 Worker 执行/解析异常推进。

### 11.2 Validator

```json
{
  "passed": true,
  "reason": "验收标准和证据一致",
  "issues": [],
  "tests": [],
  "current_error": null
}
```

### 11.3 Sol

Sol 使用与 Luna 相同的实现字段，并额外要求：

```json
{
  "status": "recovered",
  "remaining_issues": []
}
```

Sol `status`：

```text
recovered | failed | blocked
```

合法的 Sol Report 同样先进入 Validator；只有执行/解析异常或后续验证失败才会将恢复流程升级为 `escalated`。

Decision Summary 只保存目标、方案、基于证据的理由、证据、未尝试方案和下一步，不保存私有 chain-of-thought。

## 12. Failure Snapshot

只有会推进实现熔断的失败才创建 Failure Snapshot，例如：

- Deep Validator 失败。
- Luna Worker 执行失败。
- Luna 非法结构化输出。
- Sol 执行、输出或最终验证失败。

Fast Validator 失败只升级 Deep，不创建实现失败快照。

快照结构：

```json
{
  "snapshotId": "failure-2",
  "taskId": "task-123",
  "contextId": "ctx-task-123",
  "sourceRole": "luna",
  "attempt": 2,
  "currentProgress": ["已完成步骤"],
  "modifiedFiles": ["src/example.js"],
  "diffSummary": "当前差异摘要",
  "attemptHistory": [],
  "currentError": {
    "type": "validation_failure",
    "message": "测试证据失败",
    "log": "有界错误日志"
  },
  "validation": {},
  "decisionSummary": {
    "attemptGoal": "修复当前问题",
    "approach": "局部修改",
    "reason": "基于失败证据",
    "evidence": [],
    "notAttempted": [],
    "nextAction": "重试或恢复"
  },
  "memoryRevision": 7
}
```

进入 Context Envelope 时字段会序列化为 snake_case，例如 `decision_summary` 和 `memory_revision`。

直接调用 `createFailureSnapshot()` 且未指定 ID 时，使用共享递归规范序列化加 SHA-256 生成 `fs-...` ID，完整纳入嵌套错误、验证和 Decision Summary，避免 JSON 字段白名单过滤掉关键证据。已有/显式 ID 不变；Router 默认的 UUID 工厂也保持不变。

## 13. Semantic Memory

Semantic Memory 用于跨任务保留可复用经验。

条目结构：

```json
{
  "id": "semantic-abc",
  "taskType": "api-compatibility",
  "summary": "兼容旧快照字段",
  "problem": "升级后仍需读取 v1 state",
  "resolution": "归一化旧字段并保留 phase",
  "tags": ["snapshot", "compatibility"],
  "success": true,
  "createdAtRevision": 12
}
```

行为：

- 默认最多保留 100 条，ID 相同保留最新条目。
- 默认使用确定性的词法重叠评分。
- 中文按汉字、其他语言按字母数字 Token 归一化。
- `prepareWorkerRequest()` 默认取 Top 3。
- 独立检索 API 默认 Top 5，默认最低分数为 `0.1`。
- 相同分数保持原始稳定顺序。
- 可注入自定义 scorer 或 retriever。
- 自定义 retriever 抛错时回退到默认检索；返回非数组时按无匹配结果处理。
- 传给插件的数据为深拷贝，不能修改内部 Memory。

## 14. Token Budget Controller

### 14.1 默认输出预算

| Role | 默认 Thinking | Output Tokens |
|---|---:|---:|
| Planner | high | 4000 |
| Luna | medium | 8000 |
| Validator | low | 2000 |
| Sol | high | 6000 |

最终 Worker thinking 以冻结的 Reasoning Profile 为准。

### 14.2 复杂度倍率

```text
low    -> 0.75
medium -> 1.00
high   -> 1.25
```

### 14.3 Usage Feedback

反馈字段：

```text
requestId
role
inputTokens
outputTokens
latencyMs
success
truncated
validatorMode
taskType
```

预算反馈规则：

- 最多保留 50 条反馈。
- 只使用相同 `role + taskType` 的反馈。
- 每次只观察最近 10 条匹配记录。
- 成功、失败和截断率共同调整 output budget。
- 默认最大调整范围为基础预算的 `±25%`。
- 全部成功且无截断时可适度降低预算。
- 失败或截断增加时可提高预算。

### 14.4 输入预算与压缩

Worker Prompt 默认使用紧凑 JSON；显式传入 `serialization: { pretty: true }` 可启用可读调试格式，不会改变字符串内部空白。

`maxInputTokens` 对完整 `renderedPrompt` 生效（不包括宿主另外添加的系统提示词和工具定义），包括：

- 固定 Prefix。
- Runtime Protocol。
- 严格 JSON Schema。
- Context Envelope。
- Current Task。

压缩顺序：

1. 删除旧 Runtime Events。
2. 逐步缩短日志、stdout、stderr 和 diff summary。
3. 删除旧 tests、worker reports、validation reports、attempt history 和 snapshots。
4. 删除非必要 completed、pending、blocked 和 constraints。

始终保留：

- Objective。
- Acceptance Criteria。
- Current Error。

压缩在一次流程中直接测量完整 Prompt，不假设协议、任务和 Envelope 的 Token 估算可线性相加；相同候选的测量会缓存。如果仍无法满足预算，则拒绝创建 Worker 请求，而不是静默删除必要证据。

## 15. 模型路由与动态排名

### 15.1 Runtime 角色

```text
planner | luna | validator | sol
```

### 15.2 v1 路由兼容

```json
{
  "version": 1,
  "luna": {
    "thinking": "medium",
    "candidates": [
      { "provider": "provider-a", "model": "luna-model" }
    ]
  },
  "sol": {
    "thinking": "high",
    "candidates": [
      { "provider": "provider-a", "model": "sol-model" }
    ]
  }
}
```

v1 运行时自动补全：

- Planner：`mode=inherit`、`thinking=high`。
- Validator：复用 Luna candidates、`thinking=low`。

### 15.3 v2 路由

```json
{
  "version": 2,
  "planner": {
    "mode": "inherit",
    "thinking": "high"
  },
  "luna": {
    "thinking": "medium",
    "thinkingByComplexity": {
      "low": "low",
      "medium": "medium",
      "high": "high"
    },
    "candidates": [
      { "provider": "provider-a", "model": "luna-model" }
    ]
  },
  "validator": {
    "thinking": "low",
    "candidates": [
      { "provider": "provider-a", "model": "validator-model" }
    ]
  },
  "sol": {
    "thinking": "high",
    "candidates": [
      { "provider": "provider-a", "model": "sol-model" }
    ]
  }
}
```

Planner 支持：

```text
mode=inherit | mode=route
```

Worker route 还可包含 `budgetProfile`。它可以引用 `planner`/`root`、`luna`/`executor`、`validator` 或 `sol`/`recovery` 的基础输出预算，或显式提供 `{ "outputTokens": 1200 }`（兼容 `outputBudget`、`maxOutputTokens`、`maxTokens` 单字段对象）。复杂度倍率和 Usage Feedback 仍会生效，冻结的 thinking 不会被覆盖。未知名称、字段、冲突别名和非正数会显式拒绝；原先被静默忽略的任意 profile 需要迁移到此格式。

输出预算是 `request.budget` 元数据，宿主需要将其映射到 Provider 输出限制；当前 Pi Agent API 不提供输出 Token 上限，因此 Pi 路径不是硬限额。

### 15.4 可用性与排名

使用内置路由器时，模型必须同时满足：

- `provider/model` 精确匹配配置候选。
- 当前模型注册表可用。
- Provider 已配置认证。

当项目路由文件不存在时，Pi 初始化会从已经认证且处于当前 Session model scope 内的模型中生成显式 v2 路由。优先级为：专用 Luna/Sol 模型、当前 Pi 模型、确定性 `provider/model` 顺序。现有 v1/v2 文件继续严格使用，不会静默回退或重写。

存在历史性能时，可用候选按 `provider + model + taskType` 排名。默认分数：

```text
score = successRate * 0.5
      + quality     * 0.3
      - costPenalty * 0.1
      - latencyPenalty * 0.1
```

规则：

- 有历史记录的可用候选优先于无历史候选。
- 分数相同时保持配置文件中的稳定顺序。
- 不可用候选不会被选中。
- 自定义 scorer 抛错或返回非有限分数时回退默认评分。
- 自定义 ranker 抛错、返回非数组或改变候选数量时回退原顺序。
- 当前自定义 ranker 接口只校验数组长度，不重新校验候选集合和可用性；它属于可信插件边界，恶意 ranker 可以替换候选，因此不应加载不受信任的 ranker。

Pi 在每次 `sol_luna_prepare_worker` 时使用最新 performance store 解析实际模型，并在 Agent `tool_call` 中注入选中的 `provider/model` 和冻结 thinking。托管 Agent 模板故意不写固定 `model`/`thinking` frontmatter，确保 pi-subagents 使用每次请求的动态路由值，而不是物化时的旧配置。Root 提供的 model 和 thinking override 会被阻止。

## 16. Runtime Lifecycle Events

当前支持 14 类事件：

```text
task_started
reasoning_profile_frozen
agent_selected
context_projected
context_compressed
worker_dispatched
worker_failed
validation_started
validation_completed
snapshot_created
recovery_started
usage_recorded
task_completed
task_escalated
```

统一事件结构：

```json
{
  "type": "worker_dispatched",
  "taskId": "task-123",
  "contextId": "ctx-task-123",
  "role": "luna",
  "attempt": 1,
  "revision": 4,
  "timestamp": "2026-01-01T00:00:00.000Z",
  "message": "",
  "log": "",
  "metadata": {}
}
```

事件特性：

- Runtime Memory 默认最多保留 100 条。
- log、metadata 字符数、条目数和嵌套深度均有界。
- 事件先写入 Memory，再尝试发送到可选 `eventSink`。
- sink 接收事件深拷贝。
- 同步异常和异步 Promise rejection 均被隔离，不影响主状态机。

## 17. Router Service API

`createRouterService()` 是宿主无关的核心门面。

### 17.1 可注入组件

```text
snapshot
taskIdFactory
contextIdFactory
snapshotIdFactory
requestIdFactory
budgetPolicy
modelRoutes
isModelAvailable
executionPolicy
memoryRetriever
modelRanker
modelScorer
modelPerformanceStore
eventSink
```

### 17.2 只读查询

```text
getState()
getMemory()
getPendingRequest()
getReasoningProfile()
getPolicyDecision()
getModelPerformanceStore()
getContextEnvelope()
getFailureSnapshot()
retrieveRelevantMemory()
snapshot()
```

### 17.3 状态操作

```text
restore()
gate()
prepareAgentCall()       # 兼容 API
prepareWorkerCall()      # 兼容 API
prepareWorkerRequest()
markWorkerDispatched()
recordWorkerReport()
recordValidation()
recordUsageFeedback()
recordModelFeedback()
addSemanticMemory()
reset()
```

所有会修改状态的公开操作都在 Router 内部原子执行；操作抛错时恢复完整旧快照。

## 18. Pi Adapter

### 18.1 项目物化

初始化后生成：

```text
.pi/agents/luna-worker.md
.pi/agents/validator-worker.md
.pi/agents/sol-worker.md
.pi/subagents.json
.pi/sol-luna-models.json
.pi/sol-luna-router.json
```

`subagents.json` 合并的托管值：

```json
{
  "disableDefaultAgents": true,
  "fallbackSubagent": "none",
  "strictAgentFiles": true
}
```

安全措施：

- 只有可信项目可执行 init、update、模型配置和 remove 写入。
- 新创建的 `.pi` 和 agent 目录使用 `0700`。
- 文件通过临时文件原子写入并使用 `0600`。
- 拒绝跟随配置文件或目录符号链接。
- Marker 保存每个托管模板的 SHA-256，运行时激活前重新校验三个模板；不一致时阻止 Root mutation、Agent 和 Router 工具，并要求 update/reset 修复。
- 用户修改的托管文件不会被静默覆盖；需要确认或 `--force`。
- remove 只删除 Marker 记录的托管文件，并保留模型路由和无关配置。

### 18.2 工具

```text
sol_luna_validate
sol_luna_gate
sol_luna_prepare_worker
sol_luna_record_result
sol_luna_record_usage
```

职责：

| 工具 | 作用 |
|---|---|
| `sol_luna_validate` | Validator 的受限语法、JSON 和 Git 检查 |
| `sol_luna_gate` | `start_task`、`plan_ready`、`status` |
| `sol_luna_prepare_worker` | 策略授权、投影、预算、模型和 Prompt 准备 |
| `sol_luna_record_result` | 严格解析并记录 Luna/Validator/Sol JSON |
| `sol_luna_record_usage` | 写入 Token/延迟反馈和可选模型性能 |

### 18.3 命令

```text
/sol-luna-disable
/sol-luna-enable
/sol-luna-init
/sol-luna-update
/sol-luna-models
/sol-luna-models status
/sol-luna-models auto [--force]
/sol-luna-models reset [--force]
/sol-luna-models set ... [--force]
/sol-luna-token-ui on|off|status|reset
/sol-luna-status
/sol-luna-remove
/sol-luna-reset
```

`/sol-luna-disable` 和 `/sol-luna-enable` 只作用于当前规范化项目路径。暂停状态严格保存为 `.pi/sol-luna-runtime.json` 的 `{version: 1, paused: boolean}`；缺失表示 active，`disable` 和 `enable` 分别写入显式 paused/active 文件。暂停时保留 Marker、Agent 模板、模型路由、Router Session snapshot 和 Token 累计，只清理 adapter 的临时 dispatch/planner correlation，省略系统提示注入、隐藏 Token widget、跳过项目 Token 统计，并拒绝 `sol_luna_*` 工具及 `luna-worker`、`validator-worker`、`sol-worker` 托管 Agent dispatch；普通无关 Pi edit/write/bash/Agent 与其他扩展继续运行。`enable` 可显式修复普通文件中的 malformed JSON，但目录和文件符号链接均拒绝。init/update/remove/reset 不会静默删除 pause 文件；status 显示 active、paused 或 invalid。invalid/unsafe runtime 状态对全部 Sol-Luna 编排 fail closed：阻止所有 `sol_luna_*` 工具以及 `luna-worker`、`validator-worker`、`sol-worker` 托管 Agent dispatch，但普通无关 Pi 工具和 Agent 调用继续可用。Session start 和事件边界刷新 pause 状态；TUI 配置目录 watcher 对 runtime 文件事件刷新 pause 状态、对 token 文件事件刷新 token 状态，并在 filename 为 `null` 或 `undefined` 的原子替换事件中同时刷新两者。

`/sol-luna-models` 在 Pi TUI/RPC 中提供交互向导，可显式选择 Planner 模式以及 Luna、Validator、Sol 模型；Planner、Luna 和 Fast Validator thinking 可配置，Sol 按恢复策略固定为 `high`。无需编辑 JSON。非交互环境可使用：

```text
/sol-luna-models set --planner-mode inherit --luna provider/model --validator provider/model --sol provider/model --force
```

`/sol-luna-models reset` 重建项目模型配置，与 `/sol-luna-reset` 的 Session 状态重置完全不同。

只有用户应主动执行 `/sol-luna-reset`。它清空当前 Session 的任务/熔断状态、Task Memory 和 pending request；当前实现保留模型性能聚合及最后一次 Policy Decision。显式 reset 会清除原本可跨普通任务保留的 Usage Feedback 和 Semantic Memory。

### 18.4 Pi 调用流程

```text
sol_luna_gate(start_task)
  -> freeze Reasoning Profile
  -> sol_luna_prepare_worker(luna)
  -> Agent(luna-worker)
  -> sol_luna_record_result(luna)
  -> sol_luna_prepare_worker(validator)
  -> Agent(validator-worker)
  -> sol_luna_record_result(validator)
  -> optional sol_luna_record_usage
```

Fast 失败时再次准备 Deep Validator；Deep 失败后由状态机决定 Luna retry 或 Sol。

### 18.5 Pi 运行时保护

当项目已正确物化时：

- Root `edit`、`write`、`bash` 被阻止。
- 非托管 Agent 被阻止。
- 项目 paused 时不注入 Sol-Luna system prompt；阻止 `sol_luna_*` 工具和三类托管 worker Agent，普通无关 Pi edit/write/bash/Agent 不受阻止。
- runtime JSON invalid/unsafe 时不注入 Sol-Luna system prompt，阻止全部 `sol_luna_*` 工具和三类托管 worker Agent，但允许普通无关 Pi 工具与 Agent。
- 未准备的托管 Agent 被阻止。
- `schedule`、`resume`、model override、thinking override 被阻止。
- Agent prompt 被替换为 Router 生成的 `renderedPrompt`。
- Agent model 和 thinking 使用 Router 的实际选择与冻结值。
- `inherit_context=false`、`run_in_background=false` 被强制设置。
- Agent 启动失败通过 `tool_result` 回写失败状态。
- Agent `tool_result` 的迟到结果必须同时匹配 request ID 和 task ID；手工调用 `sol_luna_record_result` 时仍应显式提供 request ID。

Pi 状态通过 `pi.appendEntry("pi-sol-luna-router/state", snapshot)` 写入 Session branch，并在 `session_start` 恢复最新条目。

### 18.6 当前项目 Token 占比

Pi TUI 可选地在输入框下方右对齐显示：

```text
P(…%),L(…%),V(…%),S(…%)
```

该统计严格属于当前正在使用的项目，不读取或分摊 Pi 全局 Token 总量：

- 项目标识使用规范化后的当前项目路径。
- 同一项目跨 Session、跨任务累计。
- 切换项目后读取该项目独立的 `.pi/sol-luna-ui.json`。
- 新任务和 `/sol-luna-reset` 不清零项目累计值。
- `/sol-luna-token-ui reset` 只清零当前项目，并保留可见性与事件去重历史；显式 reset 也可修复格式损坏的普通 JSON 文件，但仍拒绝符号链接或不安全目录。
- paused 项目停止 Planner/worker Token accounting 并暂时隐藏 widget；resume 后沿用原有累计值和 visibility preference。
- `/sol-luna-remove` 不删除用户拥有的 Token 统计文件。

角色归属：

| 标签 | 统计来源 |
|---|---|
| P | 活跃 Sol-Luna 任务期间 Root Planner 的 Pi `message_end` usage |
| L | 已关联托管 dispatch 的 `luna-worker` lifecycle usage |
| V | 已关联托管 dispatch 的 Fast/Deep `validator-worker` lifecycle usage |
| S | 已关联托管 dispatch 的 `sol-worker` lifecycle usage |

计数公式为 `input + output + cacheWrite`，明确排除 `cacheRead`。Worker 调度时注入包含 request ID 的确定性 description，并使用 pi-subagents 的 `subagents:started` 将该 description、agent type 与当前 pending request 三者关联；后续只接受同一 Agent ID 的 `subagents:completed`/`subagents:failed`，每个 Agent ID 只记一次，不能仅凭 agent type 或 `sol_luna_record_usage` 计费。Planner 使用 Assistant message 摘要去重；包含 `start_task` 的首条 Planner 消息只在 Gate 成功并持久化后提交。

显示百分比使用最大余数法稳定分配整数百分点；非零总量时四项之和恒为 100。项目文件更新通过带随机 owner 标识的短期排他锁串行化 read-modify-write，写入前再次校验 lock ownership，并使用原子 rename；TUI 监听当前项目文件变化，因此同一项目的其他 Pi Session 更新也会刷新显示。可视化默认关闭，但项目计数在隐藏期间继续。实现使用 `setWidget(..., { placement: "belowEditor" })`，不替换 Footer 或 Editor，非 TUI 模式只保留配置和统计。

## 19. Generic / Codex / DeepSeek Harness

`createHarnessAdapter()` 是回调驱动的宿主适配器。Codex 和 DeepSeek 只是设置不同 `harnessName` 的薄封装。

必需输入：

```text
workerBindings.luna
workerBindings.sol
invokeWorker()
```

可选：

```text
workerBindings.validator
saveSnapshot()
autoRecordValidator
strictWorkerOutput
modelRoutes
isModelAvailable
budgetPolicy
ID factories
```

每次 `invokeWorker()` 可获得：

```text
binding / input / routerState / snapshot
request / requestId / taskId / contextId / snapshotId
contextEnvelope / budget / routing
reasoningProfile / policyDecision / validatorMode
semanticMatches / renderedPrompt
```

Harness 行为：

- 单实例中的状态操作和持久化按事务队列串行执行。
- Worker 启动前先持久化 `dispatched=true`。
- 持久化失败恢复完整旧快照。
- 默认严格校验 Worker JSON。
- Fast Validator 执行异常或非法 JSON 只升级 Deep。
- Validator binding 可以省略；此时宿主不能调用 Validator Agent，必须通过可信宿主验证 API 记录真实结果。

安全责任边界：

- Generic Harness 无法自动限制宿主父进程、Worker 文件权限或命令权限。
- 宿主必须提供 sandbox、只读工作区或等价权限控制。
- 多个 Harness 实例共享同一持久化存储时，宿主应提供 CAS、锁或其他并发控制；内置事务队列只覆盖单个 Adapter 实例。

## 20. 持久化与升级兼容

Snapshot 外层格式：

```json
{
  "version": 1,
  "state": {
    "protocol": "2.0",
    "memory": {},
    "pendingRequest": null,
    "policyDecision": null,
    "modelPerformanceStore": { "records": [] },
    "revision": 0
  }
}
```

兼容策略：

- 支持恢复旧 raw state。
- 支持恢复旧 `{ version: 1, state }`。
- 保留 v1 `phase` 和旧熔断语义。
- 保留 `prepareAgentCall()` 和 `prepareWorkerCall()`。
- 支持 Model Route version 1。
- v1 Validator 运行时复用 Luna route。
- 支持 v1 两 Agent managed marker 安全升级到 v2 三 Agent marker。
- Pending request 恢复时校验 role、request ID、task ID 和 context ID。

## 21. 主要源码映射

| 文件 | 当前职责 |
|---|---|
| `src/core.js` | phase/stage 状态机、熔断规则、Agent 授权、Marker 与 v1 兼容 |
| `src/execution-policy.js` | Reasoning Profile Freeze、Fast/Deep 决策和策略授权 |
| `src/task-memory.js` | 五层 Memory、Usage Feedback、Decision Summary 和 Failure Snapshot |
| `src/context-envelope.js` | Context Envelope、角色投影、规范序列化 |
| `src/prompt-protocol.js` | v2.1 固定 Prefix、Runtime Suffix、严格 JSON Schema |
| `src/token-budget.js` | Token 估算、复杂度预算、反馈调整和上下文压缩 |
| `src/token-share.js` | 当前项目 Token 累计、事件去重、占比舍入和显示格式 |
| `src/semantic-memory.js` | 语义条目、确定性词法检索和 scorer 插件 |
| `src/model-ranking.js` | 模型性能聚合、评分和稳定候选排名 |
| `src/runtime-events.js` | 14 类有界生命周期事件和非致命 sink |
| `src/model-routing.js` | v1/v2 路由归一化、精确模型选择和模板渲染 |
| `src/router-service.js` | 策略、Memory、预算、模型、事件和调用生命周期总编排 |
| `src/adapters/pi.js` | Pi 物化、工具、命令、权限门控、Session 持久化和项目 Token TUI |
| `src/adapters/harness.js` | Generic Harness 事务、Worker 调用和持久化回滚 |
| `src/adapters/codex.js` | Codex Harness 薄封装 |
| `src/adapters/deepseek.js` | DeepSeek Harness 薄封装 |
| `templates/agents/*.md` | Luna、Validator、Sol 的托管模板和工具边界 |

## 22. 当前架构不变量

```text
1. 在 Pi 或遵循协议的宿主中，Root Planner 不直接修改项目文件。
2. 一个任务只使用一个冻结的 Reasoning Profile。
3. 同一时间最多存在一个 pending Worker request。
4. Worker 必须先准备、持久化并标记 dispatched，结果才可记录。
5. Luna/Sol 自报成功不能绕过 Validator。
6. Fast Validator 失败只升级 Deep，不消耗 Luna 熔断次数。
7. Validator 路径中只有 Deep 失败创建实现 Failure Snapshot；Worker 执行或输出失败也会直接创建快照。
8. Luna 最多两次失败，Sol 最多一次恢复。
9. Sol 必须使用当前任务的最新 Failure Snapshot。
10. Decision Summary 只保留有界决策摘要，不保存 chain-of-thought。
11. Token 压缩不能删除 objective、acceptance 或 current error。
12. 内置模型选择精确匹配 provider/model 和认证可用性；自定义 ranker 是可信扩展边界。
13. 内置隔离路径中的插件异常和异步 event sink 失败不能破坏 Router 状态。
14. v1 Route、Snapshot 和 managed marker 可安全升级。
```

## 23. 架构目标

```text
Policy-driven
Cache-friendly
Memory-aware
Failure-resilient
Read-only validated
Token-efficient
Feedback-adaptive
Backward-compatible
Host-independent
Multi-model Agent Runtime
```
