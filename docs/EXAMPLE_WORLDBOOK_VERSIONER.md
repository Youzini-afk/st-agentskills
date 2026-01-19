# Worldbook Versioner 示例（自动修改世界书 + 版本回滚）

<!-- ASCII padding (Windows patch safety): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx -->
<!-- MORE ASCII padding (Windows patch safety): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx -->

这份示例的目标是：**让模型可以安全地“自动改世界书”，并且每次修改都有版本记录，随时一键还原。**

额外加分项：**带前端面板**，用户可以不依赖 AI，直接“查看改动 / 选择版本回滚”。

它是一个“技能包”脚本：`examples/worldbook_versioner_skillpack.js`  
加载后会注册 3 个技能（通过 `window.STAgentSkills.register`）：

- `worldbook.apply_patch`：修改世界书条目 + 记录版本
- `worldbook.history`：查看历史版本
- `worldbook.restore`：一键还原（可指定版本）

同时会在页面左下角额外出现一个按钮：`WB Versions`  
点击即可打开前端面板（查看历史、应用修改、撤销最近一次、选择版本回滚）。

## 1) 这是如何利用 STAgentSkills 基座的？

核心只有一句话：**它只负责注册 skill + 写 action；其余闭环由基座承担。**

在 `examples/worldbook_versioner_skillpack.js` 里，你会看到它做了：

1. `waitForBase()`：等待 `window.STAgentSkills.register` 可用（不要求加载顺序）
2. `window.STAgentSkills.register({ name, description, action })`：注册技能
3. `action({ args })`：拿到模型传来的 `args`，执行世界书修改/回滚，然后返回结果对象

而这些复杂部分 **不需要它管**（因为基座会自动做）：

- 注入提示词，让模型知道有哪些技能、怎么 `[CALL: ...]`
- 解析模型输出中的 `[CALL: ...]`
- 用队列串行执行，避免并发/重入
- try/catch 隔离，action 抛错也不会崩酒馆
- 把 action 的返回值塞回 System Message，并自动触发 `generate()` 让模型继续生成

## 2) 如何启用这个示例？

方式 A（最快）：把 `examples/worldbook_versioner_skillpack.js` 的内容复制到“会在酒馆页面执行的自定义脚本位置”加载。

方式 B（调试）：在酒馆页面打开开发者工具（Console），把整个文件内容粘贴进去回车执行。

执行成功后，你会在 Console 看到：

`[worldbook-versioner] loaded. Skills: worldbook.apply_patch / worldbook.history / worldbook.restore`

## 3) 先手工测试（建议）

你先不用让模型自己决定，直接在聊天里手工输入一次 CALL，看是否能跑通：

### 3.0 指定“改哪本世界书”（默认角色绑定）

- **默认**：不填 `bookName` 时，目标是“当前角色卡绑定的世界书”
- **指定某本书**：在参数里加 `bookName`
- **聊天绑定书**：可选传 `bookType:"chat"`（目标为 chat lore 绑定的世界书）

### 3.1 修改（replace）

`[CALL: worldbook.apply_patch({"entry":"你的条目标题","mode":"replace","text":"新的世界书内容"})]`

指定书名示例：

`[CALL: worldbook.apply_patch({"bookName":"Example Book","entry":"你的条目标题","mode":"replace","text":"新的世界书内容"})]`

### 3.2 追加（append）

`[CALL: worldbook.apply_patch({"entry":"你的条目标题","mode":"append","text":"追加的一段"})]`

### 3.3 查看历史

`[CALL: worldbook.history({"entry":"你的条目标题","limit":10})]`

### 3.4 一键还原（还原到上一个版本）

`[CALL: worldbook.restore({"entry":"你的条目标题"})]`

### 3.5 指定版本还原

先用 `worldbook.history` 查到某个 `versionId`，再：

`[CALL: worldbook.restore({"entry":"你的条目标题","versionId":3})]`

说明：该示例的还原语义是：

- `restore(versionId=3)`：还原到版本 #3 的“修改后内容”（after）
- `restore()`（不写 versionId）：撤销最近一次记录（回到 before）

## 4) 版本记录保存在哪里？

版本记录保存在浏览器本地：

- localStorage key：`st-agentskills.example.worldbook_versions.v1`

说明：

- 清理浏览器缓存/换浏览器/无痕窗口会导致记录丢失
- 这是“示例”的合理默认；如果你要做严肃生产版，建议改成导出/同步到文件或后端存储

## 5) 前端面板怎么用（最轮椅）

1) 点击左下角 `WB Versions`  
2) 选择目标世界书（默认“角色绑定”；也可选“聊天绑定”或按书名指定）  
3) 填 entry（id/name/comment/keys 片段都可）  
4) 点“加载历史”查看版本列表  
5) 点“回滚到此版本”即可一键还原

提示：面板里的“应用修改（记录版本）”会直接调用同一套核心逻辑，相当于不用模型也能改世界书并记录历史。

## 6) 兼容性说明（非常重要）

本示例现在优先走 SillyTavern 的 **world-info 系统与 API**（这是 Vectors Enhanced 也在用的主流方式）：

- 读取：`/api/worldinfo/get`
- 保存：`/api/worldinfo/edit`

“默认角色绑定世界书”的判定逻辑对齐 Vectors Enhanced：

- 角色主世界书：`character.data.extensions.world`
- 角色额外世界书：`world_info.charLore[file].extraBooks`
- 聊天绑定世界书（chat lore）：`chat_metadata[METADATA_KEY]` 或 `chat_metadata.world_info`

兼容性风险主要来自“不同版本前端模块路径不同”。示例通过多路径 `import()` 尝试加载：

- `/script.js`、`/scripts/extensions.js`、`/scripts/world-info.js`、`/scripts/utils.js`

如果你的版本路径不同，只需要改 `st.init()` 里的候选路径列表即可。

## 7) 建议你怎么把它变成“可发布技能”

如果你准备对外发布：

- 把 `st.init()` / `st.getDefaultCharacterWorldName()` 的适配做扎实（不同版本路径/字段差异）
- 给 `apply_patch` 加更严格的白名单（比如只允许改特定条目）
- 把版本记录做导入/导出（或接入更可靠的持久化）
- 在 description 里写清楚参数与限制，降低模型误用概率
