# st-agentskills Documentation (Integration Guide)

> 本文件以“接入教程 + 开放教程”为目标：你既可以自己写技能，也可以把你的技能封装成对外可复用的扩展/脚本。

## 先看这个（更通俗）

如果你觉得本文件太长/太“工程化”，先从零术语版开始：

- `docs/QUICKSTART.md`

## 0. 基础认知：你需要实现什么

你只需要做两件事：

1) **注册技能**：调用 `window.STAgentSkills.register({ name, description, action })`  
2) **实现 action**：一个 async 函数，接收基座传入的参数，返回结果（字符串或可 JSON 序列化对象均可）

其余（提示词注入、调用解析、执行队列、错误隔离、结果回传、熔断防循环）都由基座处理。

## 1. 最小接入：注册一个技能

在任何能运行到浏览器环境（SillyTavern 前端页面）的脚本中执行：

```js
window.STAgentSkills.register({
  name: 'hello',
  description: '返回问候语。',
  action: async ({ args }) => {
    return `Hello, ${args?.name ?? 'world'}!`;
  },
});
```

### action 入参签名（当前实现）

action 会收到一个对象：

- `name`：技能名（字符串）
- `args`：解析后的参数（可能是对象/数组/字符串；解析失败时可能是 `{ _raw: "..." }`）
- `rawArgs`：模型输出的原始参数文本（字符串，可能为空）

示例（更防御的写法）：

```js
action: async ({ args, rawArgs }) => {
  const city = (args && typeof args === 'object' && !Array.isArray(args) && args.city) ? String(args.city) : '';
  if (!city) return { ok: false, error: '缺少 city 参数', rawArgs };
  return { ok: true, city, time: Date.now() };
}
```

### 返回值建议

基座会把返回值插入为 System Message：

- 返回 `string`：直接作为正文
- 返回 `object/array`：会 `JSON.stringify`（失败则降级为字符串）
- 返回 `undefined/null`：会显示 `(empty result)`（不建议）

## 2. 给模型的调用格式（你需要教它怎么用）

基座会自动注入“技能列表 + 调用格式”，因此一般不需要你手工改预设。

模型应输出：

`[CALL: skill_name({"k":"v"})]`

容错提示：

- 允许空格/换行：`[ CALL : skill ( {"k": "v"} ) ]`
- 参数也可以是 `a=1,b=true`（但建议优先用 JSON，更稳定）

## 3. 防御性编程建议（写技能的人要配合什么）

基座会兜底，但你写 action 时仍建议遵守：

- **永远不要阻塞 UI**：避免长时间同步循环；耗时操作用 `await`，必要时拆分步骤
- **输入永远不可信**：`args` 可能不是对象；字段可能缺失；数值可能是字符串
- **输出可控**：避免返回超大对象；必要时截断、摘要化
- **外部 I/O 要谨慎**：涉及本地文件、网络、执行命令等敏感动作（未来建议加入权限确认）

## 4. 如何把技能做成“可复用的扩展/脚本”（开放教程）

下面提供三种常见的“对外开放形态”，按门槛从低到高：

### 4.1 形态 A：一段可复制脚本（最简单）

你可以把注册代码封装为一个 IIFE，用户复制到自定义脚本位置即可：

```js
(() => {
  if (!window.STAgentSkills?.register) return;
  window.STAgentSkills.register({
    name: 'my_skill',
    description: '示例技能。',
    action: async () => 'ok',
  });
})();
```

优点：零打包、零工程。缺点：版本管理与分发不方便。

### 4.2 形态 B：独立 ST 扩展（推荐）

做成一个标准扩展目录（manifest + index.js），在扩展加载时注册技能。

关键点：

- **不要假设基座已先加载**：需要做“等待/重试”或提示用户先启用 `st-agentskills`
- 注册建议放在一个 `init()` 内，失败只告警不崩溃

一个等待基座的通用模板（建议复制使用）：

```js
async function waitForBase({ timeoutMs = 15_000, tickMs = 250 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (window.STAgentSkills?.register) return true;
    await new Promise((r) => setTimeout(r, tickMs));
  }
  return false;
}

(async () => {
  const ok = await waitForBase();
  if (!ok) {
    console.warn('[my-skillpack] st-agentskills not found; please enable it first.');
    return;
  }

  window.STAgentSkills.register({
    name: 'my_skill',
    description: '……',
    action: async ({ args }) => ({ ok: true, args }),
  });
})();
```

### 4.3 形态 C：技能包（多技能聚合）

把多个技能做成一个“技能包”，统一注册：

- `name` 命名建议加前缀：`packName.skillName`（例如 `utils.slugify`）
- 在 description 中明确输入输出与注意事项，降低模型误用概率

## 5. 推荐的技能设计规范（让模型更稳）

为了提高模型输出 `[CALL: ...]` 的准确率，建议你在 `description` 中包含：

- **一句话目标**：这个技能做什么
- **参数表**：每个参数的类型、是否必填、默认值、示例
- **输出说明**：返回什么结构、关键字段是什么
- **边界与限制**：最大长度、允许的枚举值、失败时返回什么

示例 description（建议风格）：

> 获取天气信息。参数：`city`(string, 必填)；`days`(number, 可选, 默认 1)。输出：`{ ok, city, days, forecast[] }`。若参数缺失，返回 `{ ok:false, error }`。

## 6. 常见问题（FAQ）

### Q1：为什么模型不调用技能？

常见原因：

- 模型/后端强干扰 System Prompt：依赖深度注入兜底，但仍可能失败
- 你的 description 不够“可操作”：没有明确参数示例，模型不敢调用
- 模型输出被其他提示词约束：例如强制“不要使用括号/标签”

排查建议：

- 在对话中手工输入一次 `[CALL: skill_name(...)]` 看基座能否触发执行
- 在浏览器控制台看 `[st-agentskills]` 的日志

### Q2：技能执行失败了但酒馆没崩，是正常的吗？

是的。基座会把错误捕获后作为 System Message 回传给模型，并提示用户失败原因（UI Toast + 系统消息）。

### Q3：如何避免模型进入“连续调用技能”的死循环？

基座有熔断（默认 30 秒 5 次），但你也可以在技能层面配合：

- 结果里明确告诉模型“现在可以继续正常回复，不要再次调用”
- 对相同输入做缓存/去重
- 在 action 里检测相同参数短时间重复并返回提示（而不是继续做昂贵操作）

## 7. 未来开放接口设想（便于你提前规划）

以下是适合后续在基座中加入的能力（当前版本未必已经实现）：

- 技能权限：敏感技能弹窗确认、白名单/黑名单
- 调用日志与统计：成功率、耗时、熔断次数、最近错误
- 参数 schema：为每个技能提供 JSON Schema，生成更强约束的注入提示
- 更强回传格式：标准化 `ok/error/data`，并支持“流式结果/进度更新”
- 取消/超时：让长任务可中断、可设置超时
