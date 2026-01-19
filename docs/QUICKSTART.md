# st-agentskills Quickstart (Plain Tutorial)

<!-- ASCII padding (Windows patch safety): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx -->

<!-- MORE ASCII padding: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx -->

## （可选）不写代码：用“轮椅配置面板”创建技能

如果你不想写/改脚本代码：

1) 在酒馆页面左下角找到 `AgentSkills` 按钮并点击  
2) 在弹出的面板里填 `技能名 / 描述 / 类型 / 内容`  
3) 点“新增/保存”即可生效（会保存到浏览器本地）  

然后你就可以用 `[CALL: 你的技能名(...)]` 进行手动测试。

这是一份“尽量不讲术语”的入门教程：你只需要复制粘贴几段代码，就能让模型在聊天里调用你的技能。

## 你会得到什么

当模型在回复里输出类似这一句：

`[CALL: hello({"name":"SillyTavern"})]`

基座就会：

1) 识别这是一次技能调用  
2) 执行你写的 `action()`  
3) 把结果作为 System Message 塞回聊天  
4) 自动让模型继续生成（你不需要手动点“继续”）

## 第 0 步：确认基座已启用

在浏览器控制台输入：

```js
window.STAgentSkills?.version
```

能看到版本号（例如 `0.1.0`）就说明基座工作正常。

## 第 1 步：复制粘贴一个最简单的技能

把下面这段贴到任意会在酒馆页面执行的脚本里（例如你自己的扩展/脚本入口）：

```js
(() => {
  if (!window.STAgentSkills?.register) {
    console.warn('[demo-skill] st-agentskills not found, please enable it first.');
    return;
  }

  window.STAgentSkills.register({
    name: 'hello',
    description: '返回一句问候。参数：name(可选)。',
    action: async ({ args }) => {
      const who = args?.name ?? 'world';
      return `Hello, ${who}!`;
    },
  });
})();
```

你现在已经“接入成功”了：技能已经在注册表里。

## 第 2 步：让模型真的去调用它（两种方式）

### 方式 A：你手动测试（最快）

在聊天里直接发送：

`[CALL: hello({"name":"Tester"})]`

你应该能看到：

- 右下角出现“技能执行中…”提示
- 聊天里出现一条 System Message：`Skill result: hello ...`
- 随后模型会继续生成一段自然语言回复

### 方式 B：让模型自己学会调用（更贴近日常）

你只需要对模型说一句很直白的话：

> 需要问候时请使用 `[CALL: hello({"name":"xxx"})]`，不要自己编结果。

基座也会自动注入“技能列表 + 调用格式”，所以通常模型很快能学会。

## 第 3 步：写一个更实用的技能（模板）

下面是一个“更不容易出错”的 action 模板（建议你照着写）：

```js
window.STAgentSkills.register({
  name: 'utils.echo',
  description: '原样返回文本。参数：text(string, 必填)。',
  action: async ({ args, rawArgs }) => {
    const text =
      (args && typeof args === 'object' && !Array.isArray(args) && typeof args.text === 'string')
        ? args.text
        : '';

    if (!text) {
      return { ok: false, error: '缺少 text 参数', rawArgs };
    }

    return { ok: true, text };
  },
});
```

你会发现：哪怕模型参数乱写，这个技能也不会崩，还会把“缺参数”的原因告诉模型。

## 常见踩坑（非常重要）

1) **action 里不要写死循环/长时间同步卡死**：耗时操作用 `await`，不要在一个 `while(true)` 里转
2) **永远不要相信 args**：它可能不是对象、字段可能缺失、类型可能不对
3) **返回值别太大**：太大的对象会把上下文撑爆，尽量返回摘要/关键字段
4) **模型如果疯狂连环 CALL**：基座会熔断（默认 30 秒 5 次）并提示“loop detected”

## 我想做“技能包”，一次注册很多技能，怎么写？

超级简单：写一个数组，然后循环 register：

```js
const skills = [
  { name: 'pack.a', description: 'A', action: async () => 'A' },
  { name: 'pack.b', description: 'B', action: async () => 'B' },
];

for (const s of skills) window.STAgentSkills.register(s);
```

## 我需要看更详细的版本

如果你已经跑通 Quickstart，想做“对外发布/更规范/更稳”，再看这份：

- `docs/INTEGRATION_GUIDE.md`

<!-- ASCII padding: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx -->

## 示例：自动修改世界书 + 版本回滚

如果你想看一个“能真正干活”的完整示例（而且带版本记录、一键还原）：

- 教程：`docs/EXAMPLE_WORLDBOOK_VERSIONER.md`
- 代码：`examples/worldbook_versioner_skillpack.js`
