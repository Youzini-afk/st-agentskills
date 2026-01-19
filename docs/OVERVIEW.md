# st-agentskills Documentation (Overview)

> 本文件尽量先用 ASCII 开头，以避免某些环境对多字节补丁的兼容问题；正文为中文。

## 这是什么

`st-agentskills` 是一个 SillyTavern 的“核心基座插件”。它不提供具体业务能力，而是提供一层**基于文本解析（Text-Parsing Based）**的通用接口层，让其它扩展/脚本可以用极简方式注册“技能（skill）”，并由基座自动完成：

- 提示词注入：把“有哪些技能、怎么调用”自动注入到上下文里（System + 深度注入兜底）
- 输出解析：从模型回复中解析出技能调用意图（容错的 `[CALL: ...]` 标签）
- 执行与隔离：以队列串行方式执行技能，并对异常做强隔离（绝不让酒馆崩溃）
- 结果回传闭环：把技能结果作为 System Message 插入聊天流，并触发 `generate()` 让模型继续生成
- 反循环保护：检测短时间内重复调用并熔断报警（防止模型陷入工具调用死循环）

设计理念：**“Internal Tank, External Wheelchair（内繁外简）”**  
对外一个 `register()`，对内把所有不确定性都挡在“坦克装甲”里。

## 为什么要做“文本解析兼容层”

SillyTavern 有原生的工具调用能力，但在实际使用中经常会遇到：

- 反代/服务端对 System Prompt 的干扰（削弱、截断、重写）
- 供应商或模型不完全支持原生 tool calling / function calling
- 用户不想改预设、不想维护复杂 schema，只想“注册即生效”

因此本基座采用**文本标签协议**作为最兼容的桥接方式：  
模型只需输出类似下面的结构，基座即可识别并执行：

`[CALL: skill_name({"k":"v"})]`

这使得“技能生态”可以不被某一种模型/某一种后端绑定。

## 核心模块与职责

以下内容对应 `index.js` 的结构（均为防御性实现）：

### 1) Global Registry（全局注册表）

- 全局单例：`window.STAgentSkills`
- 唯一入口：`window.STAgentSkills.register(skillConfig)`
- 允许重复注册（覆盖旧技能），方便热更新/调试
- 参数类型不对/字段缺失：自动补默认值并告警，**不抛错**

技能配置（当前实现支持字段）：

- `name`：String，技能 ID（必填但可自动生成兜底）
- `description`：String，给模型看的说明（为空则用占位文案）
- `action`：Async Function，执行逻辑（缺失则注册一个会返回错误对象的默认 action）
- `enabled`：Boolean，可选，默认 `true`

### 2) Prompt Injection（自动注入）

监听 `CHAT_COMPLETION_PROMPT_READY`，在每次请求模型前自动注入两层提示：

1. **System 注入**：追加“可用技能列表 + 调用格式 + 使用规则”
2. **深度注入（Depth Injection / Author’s Note 风格）**：尽量把一段短提醒追加到“最后一条 user 消息附近”

深度注入的意义：当 System Prompt 被反代/服务端干扰时，仍有更高概率让模型看到调用协议。

### 3) Robust Parser（强壮解析器）

监听 `MESSAGE_RECEIVED`，尝试从模型输出中提取第一个技能调用标签：

- 正则容错：忽略多余空格/换行，允许 Markdown 包裹
- 参数容错：
  - 优先尝试解析 JSON（对象/数组/字符串）
  - 其次解析 `a=1,b=true,c="x y"` 这类 key=value
  - 解析不了则保留到 `args._raw`（不丢信息）

### 4) Execution Engine（执行引擎：坦克层）

一旦解析出调用意图：

- 立刻显示“技能执行中…”的 UI 提示（优先 toastr，否则使用插件自带 Toast）
- 串行队列执行：避免并发导致的消息/状态错乱
- `try...catch` 强隔离：任何技能 action 报错都被捕获，并生成“执行失败”的 System Message
- 熔断机制：30 秒内技能调用次数超过 5 次，阻断后续调用并报警（防止死循环）
- 成功时：把结果作为 System Message 注入并触发 `generate()` 续写

## 一次完整闭环（简化时序）

1. 外部脚本调用 `window.STAgentSkills.register(...)` 注册技能
2. 用户发送消息 → ST 准备 prompt → 触发 `CHAT_COMPLETION_PROMPT_READY`
3. 基座注入技能说明（System + 深度注入）
4. 模型回复中输出 `[CALL: ...]`
5. ST 触发 `MESSAGE_RECEIVED` → 基座解析出 call
6. 基座队列执行 skill.action()（UI 提示 + try/catch 隔离 + 熔断保护）
7. 基座插入 System Message（结果/错误）→ 触发 `generate()` 让模型继续

## 未来接入技能的可能性（生态扩展方向）

本基座刻意把“协议/闭环/稳定性”做成通用层，后续技能生态可以自然演进为：

- **纯脚本技能**：本地计算、文本处理、正则清洗、模板渲染
- **数据技能**：读取本地知识库、向量检索（RAG）、会话摘要、角色记忆
- **工具桥接**：把其它扩展（或原生 tool calling）包装成统一的 `[CALL: ...]` 协议
- **工作流技能**：多步执行（拆成多个技能或一个技能内部状态机）
- **权限与审计**（建议未来实现）：敏感技能需要用户确认、记录调用日志、对外部 I/O 做白名单
- **更强协议**（建议未来实现）：为每个技能提供 JSON Schema，让模型更稳定地产生 args
- **可视化面板**（建议未来实现）：技能启用/禁用、调用次数、失败率、熔断状态、调试日志

下一份文档 `docs/INTEGRATION_GUIDE.md` 提供“如何接入技能/如何开放给他人使用”的详细教程。

