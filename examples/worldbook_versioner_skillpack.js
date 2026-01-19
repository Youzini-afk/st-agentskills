// st-agentskills 示例技能包：Worldbook Versioner（指定世界书 + 版本 + 前端面板）
// ------------------------------------------------------------
// ASCII padding (Windows patch safety):
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//
// 目标（给创作者的“轮椅”体验）：
// - 不改基座、不改后端：直接加载本文件即可获得 3 个技能：
//   1) worldbook.apply_patch   自动修改世界书条目，并记录版本
//   2) worldbook.history       查看某条目的修改历史（版本列表）
//   3) worldbook.restore       一键还原到某个版本（不写 versionId 则还原到上一个版本）
// - 同时附带一个前端面板：查看“我改了什么”、选择版本一键回滚（不必通过 AI 调用）
//
// 重要说明：
// - 本示例通过 window.STAgentSkills.register(...) 注册技能，这就是基座的唯一公开 API。
// - 基座会负责：提示词注入、[CALL: ...] 解析、队列执行、try/catch 错误隔离、结果回传与触发 generate()。
// - 本示例只负责：拿到参数 → 修改世界书 → 写入版本记录 → 返回结果对象。
//
// 安全提示：
// - 本示例会直接修改你本地的世界书数据（前端内存/本地存储/或由酒馆提供的保存函数写回）。
// - “版本记录”保存在浏览器 localStorage；换浏览器/清缓存会丢失。

(() => {
  'use strict';

  const LOG_PREFIX = '[worldbook-versioner]';

  const safeString = (v, fallback = '') => {
    try {
      if (typeof v === 'string') return v;
      if (v === null || v === undefined) return fallback;
      return String(v);
    } catch {
      return fallback;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
  const now = () => Date.now();

  const isPlainObject = (v) => {
    if (!v || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };

  const safeJsonParse = (text, fallback) => {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  };

  // -----------------------------
  // 0) 等待基座（轮椅：不要求加载顺序）
  // -----------------------------
  const waitForBase = async ({ timeoutMs = 15_000, tickMs = 250 } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.STAgentSkills?.register) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(tickMs);
    }
    return false;
  };

  // -----------------------------
  // 0.5) 尽力接入 SillyTavern 的“主流世界书系统”
  // -----------------------------
  // 你提供的 Lorebook V3（character card v3）规范非常重要，但在酒馆前端实际操作世界书时，
  // 最稳定的“可编辑入口”通常来自 world-info.js 对外暴露的 World Info 系统与 /api/worldinfo/* 接口。
  //
  // Vectors Enhanced 的做法也印证了这一点：
  // - 读取：getSortedEntries() / world_info.data
  // - 绑定：chat_metadata[METADATA_KEY] / character.data.extensions.world / world_info.charLore.extraBooks
  // - 保存：saveWorldInfo(...) 或直接调用 /api/worldinfo/edit
  //
  // 本示例因此采用“优先用 world-info 系统”的策略，以满足你提出的硬要求：
  // - 必须能改“指定世界书”
  // - 默认目标 = “角色卡绑定世界书”
  const st = (() => {
    let cache = null;

    const tryImport = async (paths) => {
      for (const p of paths) {
        try {
          // eslint-disable-next-line no-await-in-loop
          return await import(p);
        } catch {
          // ignore
        }
      }
      return null;
    };

    const init = async () => {
      if (cache) return cache;

      // 注意：不同部署下前端脚本路径可能不同，这里做多路径尝试。
      const script = await tryImport(['/script.js', '/scripts/script.js']);
      const extensions = await tryImport(['/scripts/extensions.js', '/extensions.js']);
      const worldInfo = await tryImport(['/scripts/world-info.js', '/world-info.js']);
      const utils = await tryImport(['/scripts/utils.js', '/utils.js']);

      cache = {
        script,
        extensions,
        worldInfo,
        utils,
      };
      return cache;
    };

    const postJson = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return res;
    };

    // 读取某本世界书（按书名）
    const getWorldBook = async (name) => {
      const bookName = safeString(name, '').trim();
      if (!bookName) return null;

      // 1) 优先通过 API（最稳定：与 ST 内部结构解耦）
      try {
        const res = await postJson('/api/worldinfo/get', { name: bookName });
        if (res.ok) return await res.json();
      } catch {
        // ignore
      }

      // 2) 回退：从 world_info.data 读（如果该版本暴露了）
      try {
        const m = await init();
        const wi = m.worldInfo;
        const data = wi?.world_info?.data || wi?.world_info?.data;
        const maybe = data?.[bookName];
        if (maybe && typeof maybe === 'object') return maybe;
      } catch {
        // ignore
      }

      return null;
    };

    // 保存某本世界书（按书名）
    const saveWorldBook = async (name, data) => {
      const bookName = safeString(name, '').trim();
      if (!bookName) throw new Error('worldbook name is empty');

      // 1) API 保存（MemoryService 也使用该接口）
      const res = await postJson('/api/worldinfo/edit', { name: bookName, data });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`保存世界书失败：${res.status} ${text}`.trim());
      }

      // 2) 尽力触发 UI 更新事件（非必须，但有助于让界面立刻刷新）
      try {
        const eventSource = window.eventSource;
        const event_types = window.event_types;
        if (eventSource && event_types?.WORLDINFO_UPDATED) {
          await eventSource.emit(event_types.WORLDINFO_UPDATED, bookName, data);
        }
      } catch {
        // ignore
      }
    };

    // 计算“默认角色绑定世界书”的书名（对齐 Vectors Enhanced 的判定方式）
    const getDefaultCharacterWorldName = async () => {
      const m = await init();

      const chat_metadata = m.script?.chat_metadata || window.chat_metadata;
      const METADATA_KEY = m.worldInfo?.METADATA_KEY;
      const getContext = m.extensions?.getContext;
      const getCharaFilename = m.utils?.getCharaFilename;
      const this_chid = m.script?.this_chid ?? window.this_chid;
      const world_info = m.worldInfo?.world_info;

      // chat 绑定世界书（chat lore）
      const chatWorld = (METADATA_KEY && chat_metadata?.[METADATA_KEY]) || chat_metadata?.world_info || null;

      // 角色主世界书：character.data.extensions.world
      let characterPrimaryWorld = null;
      try {
        const ctx = typeof getContext === 'function' ? getContext() : null;
        const character = ctx?.characters?.[ctx.characterId];
        characterPrimaryWorld = character?.data?.extensions?.world || null;
      } catch {
        // ignore
      }

      // 角色额外世界书：world_info.charLore[file].extraBooks
      let extraBooks = [];
      try {
        const fileName = typeof getCharaFilename === 'function' ? getCharaFilename(this_chid) : null;
        const extraCharLore = Array.isArray(world_info?.charLore) ? world_info.charLore.find((e) => e?.name === fileName) : null;
        extraBooks = Array.isArray(extraCharLore?.extraBooks) ? extraCharLore.extraBooks : [];
      } catch {
        // ignore
      }

      // 你提出“默认绑定角色卡世界书”，因此优先 characterPrimaryWorld。
      return {
        characterPrimaryWorld,
        characterExtraBooks: extraBooks,
        chatWorld,
        defaultWorld: characterPrimaryWorld || extraBooks[0] || chatWorld || null,
      };
    };

    return { init, getWorldBook, saveWorldBook, getDefaultCharacterWorldName };
  })();

  // -----------------------------
  // 1) 世界书定位（基于 world-info 系统）
  // -----------------------------
  // 世界书在 world-info 系统里通常以“world name（书名）”作为主键。
  // 角色卡绑定关系（Vectors Enhanced 采用的主流做法）：
  // - 角色主世界书：character.data.extensions.world
  // - 角色额外世界书：world_info.charLore[file].extraBooks
  // - 聊天绑定世界书（chat lore）：chat_metadata[METADATA_KEY] 或 chat_metadata.world_info
  //
  // 统一入口：根据 args 决定目标世界书名称。
  // - 默认：角色绑定世界书（满足你提出的“默认绑定角色卡世界书”硬要求）
  // - 指定：args.bookName
  // - 可选：args.bookType = character | chat
  const resolveTarget = async (args) => {
    const bookName = safeString(args?.bookName ?? args?.book ?? args?.worldbook, '').trim();
    const bookType = safeString(args?.bookType, '').trim().toLowerCase();

    const info = await st.getDefaultCharacterWorldName();
    const pickCharacter = info.characterPrimaryWorld || info.characterExtraBooks?.[0] || null;
    const pickChat = info.chatWorld || null;

    if (bookName) {
      return {
        kind: 'named',
        bookKey: `world:${bookName}`,
        bookName,
        worldName: bookName,
        debug: info,
      };
    }

    if (bookType === 'chat') {
      if (!pickChat) return { error: '找不到 chat lore 绑定的世界书（chat_metadata 缺少 world_info）', debug: info };
      return { kind: 'chat_bound', bookKey: `world:${pickChat}`, bookName: pickChat, worldName: pickChat, debug: info };
    }

    // 默认/character
    if (!pickCharacter) {
      return {
        error:
          '找不到“角色绑定世界书”。请确认：你已选择角色卡，且该角色在 extensions.world 或 extraBooks 中确实绑定了世界书。',
        debug: info,
      };
    }

    return {
      kind: 'character_bound',
      bookKey: `world:${pickCharacter}`,
      bookName: pickCharacter,
      worldName: pickCharacter,
      debug: info,
    };
  };

  // 将 ST 的 worldbook 数据（worldBookData.entries 为对象）规范成数组，便于查找与 UI 展示。
  // 说明：SillyTavern 的 world info 系统（/api/worldinfo/get 返回）常见结构：
  // { entries: { "<uid>": { uid, comment, key:[...], content, disable, ... }, ... }, ... }
  const entriesFromWorldBookData = (worldBookData) => {
    const entriesObj = isPlainObject(worldBookData?.entries) ? worldBookData.entries : {};
    return Object.entries(entriesObj).map(([uidKey, entry]) => {
      const e = isPlainObject(entry) ? entry : {};
      const uid = e.uid ?? e.id ?? uidKey;
      const keyArr = Array.isArray(e.key) ? e.key : Array.isArray(e.keys) ? e.keys : [];
      return { ...e, uid, id: e.id ?? uid, key: keyArr, keys: keyArr };
    });
  };

  const getWorldBookDataOrCreate = async (worldName) => {
    const existing = await st.getWorldBook(worldName);
    if (existing && typeof existing === 'object') return existing;
    return { entries: {} };
  };

  const writeEntryContent = (worldBookData, entry, newContent) => {
    const entriesObj = isPlainObject(worldBookData?.entries) ? worldBookData.entries : null;
    if (!entriesObj) throw new Error('worldBookData.entries 不存在或不是对象');
    const uidKey = safeString(entry?.uid ?? entry?.id, '').trim();
    if (uidKey && entriesObj[uidKey]) {
      entriesObj[uidKey].content = safeString(newContent, '');
      return uidKey;
    }
    // 兜底：按遍历匹配 uid
    for (const [k, v] of Object.entries(entriesObj)) {
      if (safeString(v?.uid ?? v?.id, '') === uidKey) {
        entriesObj[k].content = safeString(newContent, '');
        return k;
      }
    }
    throw new Error('无法定位条目的 uid 键（entries 对象内）');
  };

  const findEntry = (entries, entrySelector) => {
    // entrySelector 允许：
    // - 数字/数字字符串：按 uid/id 查找
    // - 字符串：按 uid 精确匹配，或按 name/comment（标题）/ key(keys)（触发关键词）模糊查找
    const selRaw = entrySelector;
    const sel = safeString(entrySelector, '').trim();
    if (!sel) return null;

    const asNum = Number(selRaw);
    if (Number.isFinite(asNum)) {
      const byId = entries.find((e) => Number(e?.uid) === asNum || Number(e?.id) === asNum);
      if (byId) return byId;
    }

    const lower = sel.toLowerCase();
    const byUid = entries.find((e) => safeString(e?.uid ?? e?.id, '').toLowerCase() === lower);
    if (byUid) return byUid;
    const byName = entries.find((e) => safeString(e?.name, '').toLowerCase() === lower);
    if (byName) return byName;
    const byComment = entries.find((e) => safeString(e?.comment, '').toLowerCase() === lower);
    if (byComment) return byComment;

    // keys/key 为数组（ST world-info 常用 key；V3 常用 keys）
    const byKeys =
      entries.find((e) => Array.isArray(e?.keys) && e.keys.some((k) => safeString(k, '').toLowerCase().includes(lower))) ||
      null;
    if (byKeys) return byKeys;

    // 最后兜底：标题包含
    return (
      entries.find((e) => safeString(e?.name, '').toLowerCase().includes(lower)) ||
      entries.find((e) => safeString(e?.comment, '').toLowerCase().includes(lower)) ||
      null
    );
  };

  // -----------------------------
  // 2) 版本记录（localStorage）
  // -----------------------------
  const VERSION_KEY = 'st-agentskills.example.worldbook_versions.v1';

  const readDb = () => {
    try {
      const raw = window.localStorage?.getItem(VERSION_KEY);
      if (!raw) return { byTarget: {} };
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.byTarget && typeof parsed.byTarget === 'object') return parsed;
      return { byTarget: {} };
    } catch {
      return { byTarget: {} };
    }
  };

  const writeDb = (db) => {
    try {
      window.localStorage?.setItem(VERSION_KEY, JSON.stringify(db));
      return true;
    } catch {
      return false;
    }
  };

  const entryKeyOf = (entry) => {
    // 稳定标识优先 uid/id，其次 comment
    const uid = entry?.uid ?? entry?.id;
    if (uid !== undefined && uid !== null && safeString(uid, '').trim() !== '') return `id:${safeString(uid)}`;
    const name = safeString(entry?.name, '').trim();
    if (name) return `name:${name}`;
    const comment = safeString(entry?.comment, '').trim();
    if (comment) return `comment:${comment}`;
    const keys0 = Array.isArray(entry?.keys) ? safeString(entry.keys[0], '').trim() : '';
    if (keys0) return `keys:${keys0}`;
    return `fallback:${Math.random().toString(16).slice(2)}`;
  };

  const targetKeyOf = ({ bookKey, entryKey }) => `${bookKey}::${entryKey}`;

  const addVersion = ({ bookKey, entryKey, before, after, meta }) => {
    const db = readDb();
    const k = targetKeyOf({ bookKey, entryKey });
    const list = Array.isArray(db.byTarget[k]) ? db.byTarget[k] : [];
    const lastId = list.length ? Number(list[list.length - 1]?.id) || 0 : 0;
    const id = lastId + 1;
    const item = {
      id,
      ts: now(),
      meta: meta || {},
      before: safeString(before),
      after: safeString(after),
    };
    list.push(item);
    db.byTarget[k] = list;
    writeDb(db);
    return { targetKey: k, versionId: id };
  };

  const listVersions = ({ bookKey, entryKey }, limit = 20) => {
    const db = readDb();
    const k = targetKeyOf({ bookKey, entryKey });
    const list = Array.isArray(db.byTarget[k]) ? db.byTarget[k] : [];
    const lim = Math.max(1, Math.min(200, Number(limit) || 20));
    // 返回最近的在前面（更符合“查看历史”的直觉）
    return { entryKey: k, versions: list.slice(-lim).reverse() };
  };

  const getVersion = ({ bookKey, entryKey }, versionId) => {
    const db = readDb();
    const k = targetKeyOf({ bookKey, entryKey });
    const list = Array.isArray(db.byTarget[k]) ? db.byTarget[k] : [];
    const id = Number(versionId);
    if (!Number.isFinite(id)) return null;
    return list.find((x) => Number(x?.id) === id) || null;
  };

  const getPreviousVersion = ({ bookKey, entryKey }) => {
    const db = readDb();
    const k = targetKeyOf({ bookKey, entryKey });
    const list = Array.isArray(db.byTarget[k]) ? db.byTarget[k] : [];
    if (list.length < 1) return null;
    return list[list.length - 1];
  };

  // -----------------------------
  // 3) 实际修改逻辑（带版本）
  // -----------------------------
  const applyPatch = async (args) => {
    const target = await resolveTarget(args);
    if (target?.error) return { ok: false, error: target.error, debug: target.debug };

    const worldBookData = await getWorldBookDataOrCreate(target.worldName);
    const entries = entriesFromWorldBookData(worldBookData);

    const entrySel = args?.entry ?? args?.id ?? args?.comment;
    const entry = findEntry(entries, entrySel);
    if (!entry) {
      return {
        ok: false,
        error: `找不到世界书条目：${safeString(entrySel)}`,
        hint: 'entry 可以填 uid/id（数字/字符串）或 name/comment（条目标题）或 key(keys)（关键词片段）',
        book: { kind: target.kind, name: target.bookName, worldName: target.worldName },
      };
    }

    const mode = ['replace', 'append', 'prepend'].includes(args?.mode) ? args.mode : 'replace';
    const patchText = safeString(args?.text ?? args?.content ?? args?.patch, '').trim();
    if (!patchText) return { ok: false, error: 'text/content 不能为空', book: target.bookName };

    const before = safeString(entry?.content, '');
    let after = before;
    if (mode === 'replace') after = patchText;
    else if (mode === 'append') after = `${before}${before ? '\n' : ''}${patchText}`;
    else if (mode === 'prepend') after = `${patchText}${before ? '\n' : ''}${before}`;

    const dryRun = !!args?.dryRun;
    if (!dryRun) {
      try {
        writeEntryContent(worldBookData, entry, after);
        await st.saveWorldBook(target.worldName, worldBookData);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : safeString(e),
          book: { kind: target.kind, name: target.bookName, worldName: target.worldName },
        };
      }
    }

    // 只要是“真实修改”（非 dryRun）就记录版本；dryRun 只做预览，不写入历史。
    const entryKey = entryKeyOf(entry);
    const version = dryRun
      ? null
      : addVersion({
          bookKey: target.bookKey,
          entryKey,
          before,
          after,
          meta: {
            mode,
            kind: target.kind,
            bookName: target.bookName,
            entrySelector: safeString(entrySel),
            uid: safeString(entry?.uid ?? ''),
          },
        });

    return {
      ok: true,
      dryRun,
      book: { kind: target.kind, name: target.bookName, key: target.bookKey },
      entry: {
        id: entry?.id ?? entry?.uid ?? null,
        name: entry?.name ?? '',
        comment: entry?.comment ?? '',
        keys: Array.isArray(entry?.keys) ? entry.keys : [],
      },
      version,
      preview: after.slice(0, 320),
      note: dryRun ? 'dryRun：未写入世界书，仅生成预览。' : '已保存到世界书（/api/worldinfo/edit）。',
    };
  };

  const restore = async (args) => {
    const target = await resolveTarget(args);
    if (target?.error) return { ok: false, error: target.error, debug: target.debug };

    const worldBookData = await getWorldBookDataOrCreate(target.worldName);
    const entries = entriesFromWorldBookData(worldBookData);

    const entrySel = args?.entry ?? args?.id ?? args?.comment;
    const entry = findEntry(entries, entrySel);
    if (!entry) return { ok: false, error: `找不到世界书条目：${safeString(entrySel)}`, book: target.bookName };

    const versionId = args?.versionId ?? args?.id;
    const entryKey = entryKeyOf(entry);
    const v = versionId
      ? getVersion({ bookKey: target.bookKey, entryKey }, versionId)
      : getPreviousVersion({ bookKey: target.bookKey, entryKey });
    if (!v) return { ok: false, error: '没有可还原的版本记录（或 versionId 不存在）' };

    const before = safeString(entry?.content, '');
    // 语义：
    // - 指定 versionId：还原到该版本“修改后”的状态（v.after）
    // - 不指定 versionId：一键撤销最近一次记录（回到 v.before）
    const after = versionId ? safeString(v.after, '') : safeString(v.before, '');
    try {
      writeEntryContent(worldBookData, entry, after);
      await st.saveWorldBook(target.worldName, worldBookData);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : safeString(e),
        book: { kind: target.kind, name: target.bookName, worldName: target.worldName },
      };
    }

    // 还原也是一次“修改”，也记录一个版本：方便撤销还原
    const version = addVersion({
      bookKey: target.bookKey,
      entryKey,
      before,
      after,
      meta: { restoreFrom: v.id, kind: target.kind, bookName: target.bookName },
    });

    return {
      ok: true,
      book: { kind: target.kind, name: target.bookName, key: target.bookKey },
      restoredFrom: v.id,
      mode: versionId ? 'restore_to_version' : 'undo_last',
      entry: { id: entry?.id ?? entry?.uid ?? null, name: entry?.name ?? '', comment: entry?.comment ?? '' },
      version,
      preview: after.slice(0, 320),
    };
  };

  const history = async (args) => {
    const target = await resolveTarget(args);
    if (target?.error) return { ok: false, error: target.error, debug: target.debug };

    const worldBookData = await getWorldBookDataOrCreate(target.worldName);
    const entries = entriesFromWorldBookData(worldBookData);

    const entrySel = args?.entry ?? args?.id ?? args?.comment;
    const entry = findEntry(entries, entrySel);
    if (!entry) return { ok: false, error: `找不到世界书条目：${safeString(entrySel)}`, book: target.bookName };

    const limit = args?.limit ?? 20;
    const entryKey = entryKeyOf(entry);
    const r = listVersions({ bookKey: target.bookKey, entryKey }, limit);
    return {
      ok: true,
      book: { kind: target.kind, name: target.bookName, key: target.bookKey },
      entry: { id: entry?.id ?? entry?.uid ?? null, name: entry?.name ?? '', comment: entry?.comment ?? '' },
      entryKey: r.entryKey,
      versions: r.versions.map((v) => ({
        id: v.id,
        ts: v.ts,
        meta: v.meta,
        beforePreview: safeString(v.before).slice(0, 120),
        afterPreview: safeString(v.after).slice(0, 120),
      })),
      tip: 'restore：指定 versionId = 还原到该版本；不指定 = 撤销最近一次记录（回到 before）。',
    };
  };

  // -----------------------------
  // 4) 前端面板（查看历史/回滚，不依赖 AI）
  // -----------------------------
  // 目的：让普通用户也能“看见我改了什么”，并点击按钮回滚版本。
  // 注意：这里直接调用 applyPatch/history/restore（同一份核心逻辑），不走 STAgentSkills。
  // STAgentSkills 负责的是“AI → 调用技能”的闭环；而 UI 属于“用户手动操作”。
  const ui = (() => {
    const BTN_ID = 'st-agentskills-worldbook-versioner';
    const CSS_ID = 'st-agentskills-worldbook-versioner-css';

    let backdropEl = null;
    let modalEl = null;
    let listEl = null;

    const injectCss = () => {
      if (document.getElementById(CSS_ID)) return;
      const style = document.createElement('style');
      style.id = CSS_ID;
      style.textContent = `
        #${BTN_ID}{
          position: fixed; left: 16px; bottom: 56px; z-index: 999999;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(18,18,18,0.86);
          color: rgba(255,255,255,0.92);
          border-radius: 12px;
          padding: 8px 10px;
          font-size: 13px;
          cursor: pointer;
          backdrop-filter: blur(10px);
          box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        }
        .wbv-backdrop{ position:fixed; inset:0; z-index:999998; background:rgba(0,0,0,0.55); }
        .wbv-modal{
          position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
          z-index:999999; width:min(900px, calc(100vw - 28px));
          max-height:min(86vh, 900px); overflow:auto;
          border-radius:16px; border:1px solid rgba(255,255,255,0.14);
          background:rgba(18,18,18,0.92); color:rgba(255,255,255,0.92);
          box-shadow:0 18px 50px rgba(0,0,0,0.45);
          padding:14px;
        }
        .wbv-modal h2{ margin:0 0 10px 0; font-size:15px; font-weight:800; }
        .wbv-help{ font-size:12px; opacity:0.82; margin:6px 0 10px 0; line-height:1.4; }
        .wbv-row{ display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
        .wbv-field{ display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
        .wbv-field label{ font-size:12px; opacity:0.8; }
        .wbv-field input,.wbv-field select,.wbv-field textarea{
          border-radius:10px; border:1px solid rgba(255,255,255,0.14);
          background:rgba(0,0,0,0.18); color:rgba(255,255,255,0.92);
          padding:8px 10px; font-size:13px; outline:none;
        }
        .wbv-field textarea{ min-height:86px; resize:vertical;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size:12px; line-height:1.35;
        }
        .wbv-actions{ display:flex; gap:8px; flex-wrap:wrap; margin:6px 0 12px 0; }
        .wbv-actions button{
          border-radius:12px; border:1px solid rgba(255,255,255,0.14);
          background:rgba(0,0,0,0.18); color:rgba(255,255,255,0.92);
          padding:8px 10px; font-size:13px; cursor:pointer;
        }
        .wbv-actions button:hover{ border-color: rgba(110,220,255,0.35); }
        .wbv-list{ border-top:1px solid rgba(255,255,255,0.12); padding-top:10px; }
        .wbv-item{ border-bottom:1px solid rgba(255,255,255,0.08); padding:10px 0; display:grid; grid-template-columns: 1fr auto; gap:10px; }
        .wbv-meta{ display:flex; flex-direction:column; gap:4px; }
        .wbv-title{ font-weight:800; }
        .wbv-pre{ white-space:pre-wrap; opacity:0.8; font-size:12px; max-width: 680px; }
        .wbv-pill{ font-size:11px; padding:3px 7px; border-radius:999px; border:1px solid rgba(255,255,255,0.14); opacity:0.9; }
      `;
      document.head.appendChild(style);
    };

    const el = (tag, attrs = {}, children = []) => {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v !== undefined) node.setAttribute(k, String(v));
      }
      for (const c of children) node.appendChild(c);
      return node;
    };

    const close = () => {
      try {
        modalEl?.remove();
        backdropEl?.remove();
      } catch {}
      modalEl = null;
      backdropEl = null;
      listEl = null;
    };

    const fmtTs = (ts) => {
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return String(ts);
      }
    };

    const renderList = (historyResult, argsForRestore) => {
      if (!listEl) return;
      listEl.innerHTML = '';
      if (!historyResult?.ok) {
        listEl.appendChild(el('div', { class: 'wbv-help', text: historyResult?.error || '加载失败' }));
        return;
      }
      const versions = Array.isArray(historyResult.versions) ? historyResult.versions : [];
      if (!versions.length) {
        listEl.appendChild(el('div', { class: 'wbv-help', text: '没有历史记录。' }));
        return;
      }
      for (const v of versions) {
        const metaText = safeString(v?.meta?.mode || (v?.meta?.restoreFrom ? 'restore' : ''), '').trim();
        const title = el('div', { class: 'wbv-title' }, [
          el('span', { text: `#${v.id} ` }),
          el('span', { class: 'wbv-pill', text: fmtTs(v.ts) }),
          el('span', { text: ' ' }),
          el('span', { class: 'wbv-pill', text: metaText || 'change' }),
        ]);
        const pre = el('div', {
          class: 'wbv-pre',
          text: `after:\n${safeString(v.afterPreview, '')}\n\nbefore:\n${safeString(v.beforePreview, '')}`,
        });
        const meta = el('div', { class: 'wbv-meta' }, [title, pre]);
        const restoreBtn = el('button', {
          text: '回滚到此版本',
          onclick: async () => {
            const ok = window.confirm?.(`确定回滚到版本 #${v.id} 吗？`) ?? true;
            if (!ok) return;
            // 直接调用核心函数（同一份逻辑），回滚成功后刷新列表
            const r = await restore({ ...argsForRestore, versionId: v.id });
            const hr = await history(argsForRestore);
            renderList(hr, argsForRestore);
            // eslint-disable-next-line no-console
            console.log(`${LOG_PREFIX} restore result`, r);
          },
        });
        listEl.appendChild(el('div', { class: 'wbv-item' }, [meta, el('div', {}, [restoreBtn])]));
      }
    };

    const open = () => {
      if (modalEl) return;
      injectCss();

      backdropEl = el('div', { class: 'wbv-backdrop', onclick: close });
      modalEl = el('div', { class: 'wbv-modal' });
      modalEl.appendChild(el('h2', { text: 'Worldbook Versioner（查看改动 / 选择版本回滚）' }));
      modalEl.appendChild(
        el('div', {
          class: 'wbv-help',
          html:
            [
              '默认目标：<b>当前角色卡绑定的世界书</b>。',
              '你也可以填 bookName 指定某本世界书（前提是它在前端可见/已加载）。',
              'entry 支持：id / name / comment / keys 片段匹配。',
            ].join('<br/>'),
        }),
      );

      const bookType = el(
        'select',
        {},
        [
          el('option', { value: 'character', text: '角色绑定（默认）' }),
          el('option', { value: 'chat', text: '聊天绑定（chat lore）' }),
          el('option', { value: 'name', text: '按书名指定' }),
        ],
      );
      const bookName = el('input', { placeholder: '世界书名称（可选）' });
      const entrySel = el('input', { placeholder: '条目选择（id / name / comment / keys 片段）' });

      const modeSel = el(
        'select',
        {},
        [
          el('option', { value: 'replace', text: 'replace（覆盖）' }),
          el('option', { value: 'append', text: 'append（追加）' }),
          el('option', { value: 'prepend', text: 'prepend（前插）' }),
        ],
      );
      const textBox = el('textarea', { placeholder: '要写入的文本（用于 apply_patch）' });

      const fields = el('div', {}, [
        el('div', { class: 'wbv-row' }, [
          el('div', { class: 'wbv-field' }, [el('label', { text: '目标世界书' }), bookType]),
          el('div', { class: 'wbv-field' }, [el('label', { text: 'bookName（按书名指定时填写）' }), bookName]),
        ]),
        el('div', { class: 'wbv-row' }, [
          el('div', { class: 'wbv-field' }, [el('label', { text: 'entry（要改哪个条目）' }), entrySel]),
          el('div', { class: 'wbv-field' }, [el('label', { text: 'mode（如何改）' }), modeSel]),
        ]),
        el('div', { class: 'wbv-field' }, [el('label', { text: 'text（写入内容）' }), textBox]),
      ]);

      listEl = el('div', { class: 'wbv-list' });

      const buildArgs = () => {
        const args = {
          entry: safeString(entrySel.value, '').trim(),
          mode: modeSel.value,
          text: safeString(textBox.value, ''),
        };
        if (bookType.value === 'name') args.bookName = safeString(bookName.value, '').trim();
        else args.bookType = bookType.value;
        return args;
      };

      const actions = el('div', { class: 'wbv-actions' }, [
        el('button', {
          text: '加载历史',
          onclick: async () => {
            const a = buildArgs();
            const hr = await history(a);
            renderList(hr, a);
          },
        }),
        el('button', {
          text: '应用修改（记录版本）',
          onclick: async () => {
            const a = buildArgs();
            const r = await applyPatch(a);
            const hr = await history(a);
            renderList(hr, a);
            // eslint-disable-next-line no-console
            console.log(`${LOG_PREFIX} apply_patch result`, r);
          },
        }),
        el('button', {
          text: '撤销最近一次',
          onclick: async () => {
            const ok = window.confirm?.('确定撤销最近一次记录吗？') ?? true;
            if (!ok) return;
            const a = buildArgs();
            const r = await restore(a);
            const hr = await history(a);
            renderList(hr, a);
            // eslint-disable-next-line no-console
            console.log(`${LOG_PREFIX} undo result`, r);
          },
        }),
        el('button', { text: '关闭', onclick: close }),
      ]);

      modalEl.appendChild(fields);
      modalEl.appendChild(actions);
      modalEl.appendChild(listEl);
      document.body.appendChild(backdropEl);
      document.body.appendChild(modalEl);
    };

    const init = () => {
      try {
        if (document.getElementById(BTN_ID)) return;
        injectCss();
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.textContent = 'WB Versions';
        btn.addEventListener('click', (e) => {
          try {
            e.preventDefault();
            e.stopPropagation();
          } catch {}
          open();
        });
        document.body.appendChild(btn);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`${LOG_PREFIX} ui init failed`, err);
      }
    };

    return { init };
  })();

  // -----------------------------
  // 5) 注册到基座（这就是“如何利用 STAgentSkills”）
  // -----------------------------
  const registerSkills = () => {
    // 关键点：这里不需要监听事件、不需要解析文本、不需要 generate()。
    // 因为这些都由 st-agentskills 基座自动完成。
    window.STAgentSkills.register({
      name: 'worldbook.apply_patch',
      description:
        '修改世界书条目并记录版本（默认角色绑定书）。参数：entry(id/name/comment/keys片段), mode=replace|append|prepend, text(content), bookName(可选指定书名), dryRun(可选)。返回：versionId、预览。',
      action: async ({ args }) => applyPatch(args),
    });

    window.STAgentSkills.register({
      name: 'worldbook.history',
      description: '查看某世界书条目的版本历史（默认角色绑定书）。参数：entry, limit(可选), bookName(可选)。',
      action: async ({ args }) => history(args),
    });

    window.STAgentSkills.register({
      name: 'worldbook.restore',
      description:
        '还原世界书条目到某版本（默认角色绑定书）。参数：entry, versionId(可选：填=回到该版本；不填=撤销最近一次记录回到 before), bookName(可选)。',
      action: async ({ args }) => restore(args),
    });
  };

  (async () => {
    const ok = await waitForBase();
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn(`${LOG_PREFIX} st-agentskills not found; please enable st-agentskills first.`);
      return;
    }

    try {
      registerSkills();
      // 前端面板：让普通用户也能查看/回滚（不必通过 AI）
      if (document?.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ui.init());
      } else {
        ui.init();
      }
      // eslint-disable-next-line no-console
      console.log(`${LOG_PREFIX} loaded. Skills: worldbook.apply_patch / worldbook.history / worldbook.restore`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`${LOG_PREFIX} failed to register skills`, err);
    }
  })();
})();
