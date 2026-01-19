# st-agentskills

<!-- padding: keep this block ASCII-only to avoid some Windows patch tooling issues with multibyte chars near the beginning. -->
<!-- padding: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx -->

## 文档

- 零术语入门：`docs/QUICKSTART.md`
- 功能总览：`docs/OVERVIEW.md`
- 接入与开放教程：`docs/INTEGRATION_GUIDE.md`
- 示例：世界书自动修改 + 版本回滚：`docs/EXAMPLE_WORLDBOOK_VERSIONER.md`
- 发布到 GitHub 与安装：`docs/PUBLISH_GITHUB.md`

SillyTavern 核心基座插件：提供一个“基于文本解析 (Text-Parsing Based)”的通用兼容层。

目标是让外部开发者只用一个极简 API 注册技能；其余由基座以高防御性完成：提示词注入、调用解析、队列执行、错误隔离、熔断防死循环、结果回传并驱动模型续写。

## 轮椅级 API

插件会挂载全局单例：`window.STAgentSkills`，仅提供一个入口方法：`register(skillConfig)`。

```js
window.STAgentSkills.register({
  name: 'hello',
  description: '返回问候语。',
  action: async ({ args }) => {
    const who = args?.name ?? 'world';
    return `Hello, ${who}!`;
  },
});
```

说明：
- `name`：技能 ID（允许重复注册，会覆盖旧技能，便于调试）
- `description`：给 AI 看的能力描述（用于自动注入提示词）
- `action`：异步执行函数（所有异常都会被基座捕获，绝不让酒馆崩溃）

## 给 AI 的调用格式（文本标签）

当模型需要调用技能时，输出一个标签：

`[CALL: hello({"name":"SillyTavern"})]`

容错：基座会尽量忽略多余空格、换行和 Markdown 包裹，并尽力解析出技能名与参数。

## 提示词注入策略（对抗反代干扰）

- System Prompt 注入：监听 `CHAT_COMPLETION_PROMPT_READY`，自动追加技能列表与调用格式说明
- 深度注入（Depth Injection / Author's Note 风格）：尽量把一段“简短提醒”追加到最后一条用户消息附近，用于系统提示词被反代/服务端干扰时的兜底
