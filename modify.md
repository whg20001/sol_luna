

```markdown
# Sol / Luna Router 优化整改方案

版本：v2.0

目标：

在保持当前“Root Planner + Worker Executor + Recovery Agent”可靠编排模型的基础上，优化：

1. Token 消耗
2. Prompt Cache / KV Cache 利用率
3. Subagent失败恢复效率
4. 多模型动态路由能力
5. 长任务上下文稳定性

---

# 1. 当前架构问题分析

## 1.1 Agent Context重复加载问题

当前：

Root:
```

Planner Prompt
+
Task Context
+
Project Context

```
启动 Luna：
```

Executor Prompt
+
Task Context
+
Project Context

```
启动 Sol：
```

Recovery Prompt
+
重新读取 Project Context
+
重新理解失败原因

```
问题：

每个 Child Agent 都重新构造上下文。

导致：

- Prompt Cache命中率下降
- KV Cache无法持续复用
- Recovery阶段Token大量浪费


---

## 1.2 Recovery缺少执行状态继承

当前：

Luna失败：
```

Luna failed

↓

Sol new child

↓

重新分析项目

```
问题：

Sol不知道：

- Luna已经修改了什么
- 哪些方案已经尝试
- 为什么失败
- 当前项目状态


导致：

Recovery成本接近重新执行。


---

## 1.3 Root承担过多验证任务

当前：
```

Luna

↓

Root检查代码

↓

Root运行测试

↓

Root判断成功失败

```
问题：

Planner模型承担大量机械验证工作。

导致：

- 高推理成本
- Token浪费
- Planner上下文污染


---

# 2. 新总体架构


升级后：
                 User

                  |

            Root Planner
          (High Reasoning)

                  |

          Task State Manager

                  |

    +-------------+-------------+

    |                           |

  Luna                     Validator
```

Executor Low Cost Model

```
    |
```

Failure Snapshot

```
    |

  Sol Recovery
High Reasoning


    |
```

Final Validator

```
---

# 3. 引入 Agent Context Envelope


所有Agent必须共享统一Context协议。


## 3.1 Context Envelope结构


```json
{
 "runtime":

 {
   "task_id":"",
   "role":"",
   "version":"1.0"
 },


 "goal":

 {
   "objective":"",
   "acceptance":"",
   "constraints":[]
 },


 "state":

 {
   "completed":[],
   "pending":[],
   "blocked":[]
 },


 "artifact":

 {
   "changed_files":[],
   "diff_summary":"",
   "test_result":""
 },


 "failure":

 {
   "attempt":"",
   "reason":"",
   "error_log":""
 }

}
```

------

## 3.2 Prefix固定策略

所有Agent保持：

```
System Prompt

+
Agent Runtime Protocol

+
Context Envelope

+
Current Task
```

变化部分：

只允许：

```
role
task
state
```

减少：

Prompt Cache失效。

------

# 4. Agent角色重新定义

## 4.1 Root Planner

职责：

- 理解用户目标
- 任务拆解
- 调度Agent
- 最终决策

禁止：

- 直接修改文件
- 执行低级验证

模型：

High Reasoning

------

## 4.2 Luna Executor

职责：

- 实际执行
- 修改代码
- 调用工具

输入：

```
Context Envelope
+
Task Instruction
```

输出：

必须结构化：

```json
{
 "status":"success",

 "changes":[
 ],

 "tests":[
 ],

 "risk":[
 ]

}
```

------

## 4.3 Validator Agent

新增。

职责：

- diff检查
- 测试执行
- lint
- 静态分析

不负责：

- 修改代码
- 设计方案

模型：

Low / Medium Reasoning

输出：

```json
{
 "passed":true,

 "issues":[]
}
```

------

## 4.4 Sol Recovery Agent

职责：

失败恢复。

不允许：

重新探索整个项目。

输入：

必须包含：

```
Failure Snapshot
```

------

# 5. Failure Snapshot机制

## 5.1 Luna执行过程中维护Snapshot

结构：

```json
{

"task":

"implement authentication",


"current_progress":

[
"JWT parser updated",
"Database migration completed"
],


"modified_files":

[
"auth.py"
],


"attempt_history":

[

{

"action":
"modify token validation",

"result":
"failed",

"reason":
"expiry mismatch"

}

],


"current_error":

{

"type":
"test_failure",

"log":
"xxx"

}


}
```

------

# 5.2 Sol启动流程

修改：

原：

```
new child Sol

↓

read project

↓

repair
```

改：

```
new child Sol

↓

load Failure Snapshot

↓

inspect affected files

↓

repair
```

减少：

50%-80% Recovery Token。

------

# 6. Task Memory分层

新增Memory Manager。

结构：

```
Memory

|

+-- Runtime Memory

当前状态


+-- Task Memory

任务目标


+-- Artifact Memory

代码变化


+-- Failure Memory

失败历史
```

------

## Memory加载规则

| Agent     | Memory                    |
| --------- | ------------------------- |
| Root      | Task + Runtime            |
| Luna      | Task + Artifact           |
| Validator | Artifact                  |
| Sol       | Task + Failure + Artifact |

------

# 7. KV Cache优化策略

## 7.1 禁止动态System Prompt

错误：

```
每个Agent不同System Prompt
```

正确：

```
统一System Prompt

Role作为变量
```

------

## 7.2 Role切换不改变Prefix

例如：

```
<ROLE>
planner
</ROLE>
```

只修改变量。

------

# 8. Thinking Level策略

不建议所有Agent一致。

推荐：

| Agent     | Reasoning |
| --------- | --------- |
| Root      | High      |
| Luna      | Medium    |
| Validator | Low       |
| Sol       | High      |

原因：

Planner需要规划。

Executor需要执行。

Validator需要快速判断。

Recovery需要重新推理。

------

# 9. Token Budget Controller

新增组件。

负责：

- 控制Agent最大Token
- 动态调整thinking

示例：

```json
{

"task_complexity":"medium",

"budget":

{

"planner":4000,

"executor":8000,

"validator":2000,

"recovery":6000

}

}
```

------

# 10. 新状态机

原：

```
idle

↓

luna

↓

open

↓

sol

↓

passed
```

升级：

```
idle

 |

planning

 |

executing

 |

validating


      |

 +----+----+

 |         |

pass    failed


             |

        failure_snapshot


             |

          recovery


             |

        validating


             |

       passed/escalated
```

------

# 11. Worker调用协议修改

原：

```
sol_luna_worker(role=luna,prompt)
```

升级：

```
worker(

role=luna,

context_id,

task_id,

snapshot_id

)
```

------

# 12. Recovery优化流程

完整流程：

```
Luna

 |

失败

 |

生成Failure Snapshot

 |

保存Event Stream

 |

Sol启动

 |

加载Snapshot

 |

局部分析

 |

修复

 |

Validator

 |

Root确认
```

------

# 13. 最终收益预估

| 优化             | 收益                 |
| ---------------- | -------------------- |
| Context Envelope | 30%-50% Token下降    |
| Failure Snapshot | 50%-80% Recovery下降 |
| Validator Agent  | 20%-40% Planner下降  |
| Memory分层       | 30%-60% Context下降  |
| KV Cache优化     | 提高缓存命中率       |

综合：

预计：

```
Token下降:

60%-85%


可靠性:

提升20%-40%
```

------

# 14. 修改优先级

## P0 必须修改

- Agent Context Envelope
- Failure Snapshot
- Task Memory

## P1 推荐修改

- Validator Agent
- Token Budget Controller

## P2 后续优化

- RL Router
- 自动模型选择
- Agent性能反馈学习

------

# 最终目标

Sol/Luna Router 从：

```
可靠的双Agent执行系统
```

升级为：

```
Cache-friendly
Memory-aware
Failure-resilient
Token-efficient
Multi-model Agent Runtime

```

这个版本可以直接作为你当前 `ORCHESTRATION_STRATEGY.md` 的 v2.0 修改蓝本。你现有的状态机、权限控制、Root禁止绕过执行等设计可以保留，只需要在中间层增加 Context / Memory / Snapshot 三个核心组件。