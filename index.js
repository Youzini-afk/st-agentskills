/**
 * st-agentskills（核心基座插件）
 * ------------------------------------------------------------
 * 设计理念："Internal Tank, External Wheelchair"（内繁外简）
 *
 * 外部（API）：window.STAgentSkills.register({ name, description, action })
 * - 只暴露一个方法，降低学习成本
 * - 接受“不完美”的配置：缺字段自动补默认值，只告警不抛错（轮椅级）
 *
 * 内部（执行引擎）：极端防御性
 * - 所有外部 action() 都在 try/catch 隔离区执行，永不影响酒馆主流程
 * - 串行队列：避免并发/重入导致的 UI 和消息流错乱
 * - 死循环熔断：短时间内连续调用超过阈值直接阻断并报警
 * - 自动注入提示词：System 注入 + 深度注入（Author's Note 风格兜底）
 * - 基于文本解析的通用兼容层：即使原生 tool calling 不可用，或系统提示词被反代干扰，也能工作
 */

(() => {
  'use strict';

  // -----------------------------
  // 超防御工具函数
  // -----------------------------

  const EXT_ID = 'st-agentskills';
  const EXT_VERSION = '0.1.0';

  const safeConsole = {
    debug: (...args) => {
      try {
        // eslint-disable-next-line no-console
        console.debug(`[${EXT_ID}]`, ...args);
      } catch {}
    },
    warn: (...args) => {
      try {
        // eslint-disable-next-line no-console
        console.warn(`[${EXT_ID}]`, ...args);
      } catch {}
    },
    error: (...args) => {
      try {
        // eslint-disable-next-line no-console
        console.error(`[${EXT_ID}]`, ...args);
      } catch {}
    },
  };

  const isPlainObject = (value) => {
    if (!value || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };

  const safeString = (value, fallback = '') => {
    try {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return fallback;
      return String(value);
    } catch {
      return fallback;
    }
  };

  const safeJsonStringify = (value) => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return safeString(value);
    }
  };

  const nowMs = () => {
    try {
      return Date.now();
    } catch {
      return 0;
    }
  };

  // 轻量 sleep（防御性：总能 resolve）
  const sleep = (ms) =>
    new Promise((resolve) => {
      try {
        window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
      } catch {
        resolve();
      }
    });

  // -----------------------------
  // 最小 UI（零依赖）
  // -----------------------------

  const ui = (() => {
    const ROOT_ID = 'st-agentskills-toast-root';

    const ensureRoot = () => {
      try {
        const existing = document.getElementById(ROOT_ID);
        if (existing) return existing;
        const root = document.createElement('div');
        root.id = ROOT_ID;
        document.body.appendChild(root);
        return root;
      } catch {
        return null;
      }
    };

    const show = ({ title, subtitle = '', level = 'info', timeoutMs = 1800 } = {}) => {
      // 优先使用 SillyTavern 的 toastr（如果存在）；否则使用本插件自带的最小 Toast。
      try {
        const toastr = window.toastr;
        if (toastr && typeof toastr.info === 'function') {
          const text = subtitle ? `${title}\n${subtitle}` : title;
          if (level === 'error' && typeof toastr.error === 'function') toastr.error(text);
          else toastr.info(text);
          return () => {};
        }
      } catch {}

      const root = ensureRoot();
      if (!root) return () => {};

      const el = document.createElement('div');
      el.className = 'st-agentskills-toast';
      el.dataset.level = level;

      const dot = document.createElement('div');
      dot.className = 'st-agentskills-dot';

      const textWrap = document.createElement('div');
      const t = document.createElement('div');
      t.className = 'st-agentskills-title';
      t.textContent = safeString(title, 'Working…');
      const s = document.createElement('div');
      s.className = 'st-agentskills-subtitle';
      s.textContent = safeString(subtitle, '');

      textWrap.appendChild(t);
      if (subtitle) textWrap.appendChild(s);

      el.appendChild(dot);
      el.appendChild(textWrap);
      root.appendChild(el);

      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        try {
          el.remove();
        } catch {}
      };

      if (timeoutMs > 0) {
        try {
          window.setTimeout(dispose, timeoutMs);
        } catch {}
      }

      return dispose;
    };

    return { show };
  })();

  // -----------------------------
  // SillyTavern API（尽力而为 / 最佳努力）
  // -----------------------------

  const stApi = (() => {
    const api = {
      eventSource: null,
      eventTypes: null,
      addSystemMessage: null,
      triggerGenerate: null,
    };

    // 防御性：尝试多个已知 import 路径；任何失败都吞掉，绝不硬崩。
    const tryImport = async () => {
      const importPaths = [
        '../../../../script.js',
        '../../../script.js',
        '../../script.js',
        '/script.js',
      ];

      for (const p of importPaths) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const mod = await import(p);
          return mod;
        } catch {
          // 忽略：继续尝试下一个路径
        }
      }
      return null;
    };

    const normalize = (mod) => {
      // 事件总线（event emitter）
      api.eventSource = mod?.eventSource || window?.eventSource || null;

      // 事件类型常量（如果不存在则回退为字符串）
      api.eventTypes =
        mod?.event_types ||
        window?.event_types ||
        Object.freeze({
          CHAT_COMPLETION_PROMPT_READY: 'CHAT_COMPLETION_PROMPT_READY',
          MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
        });

      // 插入系统消息：尝试兼容 SillyTavern 的多种常见实现/签名
      api.addSystemMessage = async (content) => {
        const text = safeString(content, '');
        if (!text) return;

        // 1）优先用专用 helper（如果存在）
        const candidates = [
          window?.sendSystemMessage,
          mod?.sendSystemMessage,
          window?.addSystemMessage,
          mod?.addSystemMessage,
        ].filter((fn) => typeof fn === 'function');

        for (const fn of candidates) {
          try {
            // 某些实现可能接受 (text) 或 ({ mes, ... }) 等不同签名
            // eslint-disable-next-line no-await-in-loop
            await fn(text);
            return;
          } catch {
            // 继续尝试下一个候选
          }
        }

        // 2）尝试 addOneMessage 的多种签名
        const addOneMessage = window?.addOneMessage || mod?.addOneMessage;
        if (typeof addOneMessage === 'function') {
          const variants = [
            () =>
              addOneMessage({
                name: 'system',
                is_user: false,
                is_system: true,
                mes: text,
              }),
            () => addOneMessage(text, 'system'),
            () => addOneMessage(text),
          ];
          for (const v of variants) {
            try {
              // eslint-disable-next-line no-await-in-loop
              await v();
              return;
            } catch {
              // 继续尝试下一个变体
            }
          }
        }

        // 3）最后兜底：如果存在 window.chat，则直接 push（不保证所有版本都生效）
        if (Array.isArray(window?.chat)) {
          try {
            window.chat.push({ role: 'system', content: text });
          } catch {}
        }
      };

      api.triggerGenerate = async () => {
        const generate = window?.generate || mod?.generate;
        if (typeof generate !== 'function') return;
        try {
          // ST 的 generate() 签名可能变化；通常无参调用最安全
          await generate();
        } catch (err) {
          safeConsole.warn('generate() failed (ignored)', err);
        }
      };
    };

    const init = async () => {
      try {
        const mod = await tryImport();
        normalize(mod);
        return api;
      } catch (err) {
        safeConsole.warn('Failed to init ST API (non-fatal)', err);
        normalize(null);
        return api;
      }
    };

    return { api, init };
  })();

  // -----------------------------
  // 技能注册表（轮椅级 API）
  // -----------------------------

  const registry = (() => {
    const skills = new Map();

    const normalizeConfig = (skillConfig) => {
      const cfg = isPlainObject(skillConfig) ? skillConfig : {};

      // 防御性默认值：缺字段也绝不抛错（只告警并补齐）
      let name = safeString(cfg.name, '').trim();
      if (!name) {
        name = `unnamed_${Math.floor(nowMs() / 1000)}`;
        safeConsole.warn('register() missing `name`; generated:', name);
      }

      const description = safeString(cfg.description, '').trim() || '(no description)';

      const action =
        typeof cfg.action === 'function'
          ? cfg.action
          : async () => ({
              ok: false,
              error: 'No action() provided for this skill.',
            });

      const enabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : true;

      return { name, description, action, enabled };
    };

    const register = (skillConfig) => {
      try {
        const normalized = normalizeConfig(skillConfig);
        const existed = skills.has(normalized.name);
        skills.set(normalized.name, normalized);
        if (existed) safeConsole.debug('Skill overwritten:', normalized.name);
        else safeConsole.debug('Skill registered:', normalized.name);
        return normalized.name;
      } catch (err) {
        // 轮椅级原则：对外绝不抛异常
        safeConsole.error('register() failed (ignored)', err);
        return null;
      }
    };

    const listEnabled = () => {
      const out = [];
      for (const s of skills.values()) {
        if (s && s.enabled) out.push(s);
      }
      return out;
    };

    const get = (name) => skills.get(name);

    const remove = (name) => {
      try {
        return skills.delete(name);
      } catch {
        return false;
      }
    };

    return { register, listEnabled, get, remove };
  })();

  // -----------------------------
  // 前端持久化：创作者技能（无需改代码）
  // -----------------------------

  const creatorStore = (() => {
    const STORAGE_KEY = 'st-agentskills.creatorSkills.v1';

    const defaultSkill = () => ({
      name: '',
      description: '',
      enabled: true,
      type: 'static', // static | js | http
      staticText: 'ok',
      jsCode: 'return { ok: true, args };',
      http: {
        url: '',
        method: 'POST',
        headersJson: '{"Content-Type":"application/json"}',
        bodyJson: '{"args": {{json args}} }',
        responseType: 'json', // json | text
        timeoutMs: 15000,
      },
    });

    const safeRead = () => {
      try {
        const raw = window.localStorage?.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        safeConsole.warn('读取创作者技能配置失败（忽略）', err);
        return [];
      }
    };

    const safeWrite = (list) => {
      try {
        if (!Array.isArray(list)) return false;
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(list));
        return true;
      } catch (err) {
        safeConsole.warn('保存创作者技能配置失败（忽略）', err);
        return false;
      }
    };

    const sanitizeSkill = (maybe) => {
      const base = defaultSkill();
      const s = isPlainObject(maybe) ? maybe : {};
      const name = safeString(s.name, '').trim();
      const description = safeString(s.description, '').trim();
      const enabled = typeof s.enabled === 'boolean' ? s.enabled : true;
      const type = ['static', 'js', 'http'].includes(s.type) ? s.type : 'static';
      const staticText = safeString(s.staticText, base.staticText);
      const jsCode = safeString(s.jsCode, base.jsCode);
      const http = isPlainObject(s.http) ? s.http : {};
      return {
        name,
        description,
        enabled,
        type,
        staticText,
        jsCode,
        http: {
          url: safeString(http.url, base.http.url),
          method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(http.method || '').toUpperCase())
            ? String(http.method).toUpperCase()
            : base.http.method,
          headersJson: safeString(http.headersJson, base.http.headersJson),
          bodyJson: safeString(http.bodyJson, base.http.bodyJson),
          responseType: http.responseType === 'text' ? 'text' : base.http.responseType,
          timeoutMs: Number.isFinite(Number(http.timeoutMs)) ? Number(http.timeoutMs) : base.http.timeoutMs,
        },
      };
    };

    const list = () => safeRead().map(sanitizeSkill);

    const upsert = (skill) => {
      const next = sanitizeSkill(skill);
      if (!next.name) return { ok: false, error: 'name 不能为空' };
      const all = list();
      const idx = all.findIndex((x) => x.name === next.name);
      if (idx >= 0) all[idx] = next;
      else all.push(next);
      safeWrite(all);
      return { ok: true };
    };

    const remove = (name) => {
      const n = safeString(name, '').trim();
      if (!n) return { ok: false };
      const all = list().filter((x) => x.name !== n);
      safeWrite(all);
      return { ok: true };
    };

    const replaceAll = (skills) => {
      if (!Array.isArray(skills)) return { ok: false, error: '必须是数组' };
      const sanitized = skills.map(sanitizeSkill).filter((s) => s.name);
      safeWrite(sanitized);
      return { ok: true, count: sanitized.length };
    };

    const exportJson = () => {
      try {
        return JSON.stringify(list(), null, 2);
      } catch {
        return '[]';
      }
    };

    return { defaultSkill, list, upsert, remove, replaceAll, exportJson };
  })();

  const creatorSkillRuntime = (() => {
    let registeredNames = new Set();

    // 简单模板：支持 {{key}}、{{json key}}；key 从 ctx.args 里取
    const renderTemplate = (tpl, ctx) => {
      const s = safeString(tpl, '');
      const args = ctx?.args;
      return s.replace(/\{\{\s*(json\s+)?([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, jsonFlag, key) => {
        try {
          const val =
            args && typeof args === 'object'
              ? key.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), args)
              : undefined;
          if (jsonFlag) return JSON.stringify(val ?? null);
          return safeString(val ?? '');
        } catch {
          return '';
        }
      });
    };

    const safeFetch = async (url, options, timeoutMs = 15000) => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller
        ? window.setTimeout(() => {
            try {
              controller.abort();
            } catch {}
          }, Math.max(0, Number(timeoutMs) || 0))
        : null;

      try {
        const res = await fetch(url, { ...(options || {}), signal: controller?.signal });
        return res;
      } finally {
        try {
          if (timer) window.clearTimeout(timer);
        } catch {}
      }
    };

    const buildAction = (creatorSkill) => {
      const s = creatorSkill;

      if (s.type === 'static') {
        return async ({ args }) => {
          const text = renderTemplate(s.staticText, { args });
          return text || '(empty result)';
        };
      }

      if (s.type === 'http') {
        return async ({ args }) => {
          const url = safeString(s.http?.url, '').trim();
          if (!url) return { ok: false, error: 'http.url 不能为空' };

          let headers = {};
          try {
            const parsed = JSON.parse(s.http?.headersJson || '{}');
            if (parsed && typeof parsed === 'object') headers = parsed;
          } catch {
            // 忽略：使用空 headers
          }

          const method = safeString(s.http?.method, 'POST').toUpperCase();
          const bodyText = renderTemplate(s.http?.bodyJson, { args });

          const options = { method, headers };
          if (!['GET', 'HEAD'].includes(method)) options.body = bodyText;

          const res = await safeFetch(url, options, Number(s.http?.timeoutMs) || 15000);
          const ct = safeString(res.headers?.get?.('content-type'), '');
          const preferText = s.http?.responseType === 'text';

          if (!preferText && ct.includes('application/json')) {
            try {
              return await res.json();
            } catch {
              return await res.text();
            }
          }
          return await res.text();
        };
      }

      // s.type === 'js'
      return async ({ name, args, rawArgs }) => {
        const code = safeString(s.jsCode, '').trim();
        if (!code) return { ok: false, error: 'jsCode 不能为空' };

        const helpers = Object.freeze({
          sleep,
          renderTemplate: (tpl) => renderTemplate(tpl, { args }),
          safeFetch,
        });

        try {
          // 约定：jsCode 是“函数体”，可直接写 return ...
          // 运行环境：提供 context 与 helpers
          // 注意：这里不做强沙箱（浏览器同域环境）；定位是“创作者自用/自担风险”。
          // eslint-disable-next-line no-new-func
          const fn = new Function(
            'context',
            'helpers',
            `"use strict"; return (async () => { ${code}\n })();`,
          );
          return await fn({ name, args, rawArgs }, helpers);
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? `${err.name}: ${err.message}` : safeString(err),
          };
        }
      };
    };

    const registerAll = () => {
      const all = creatorStore.list();

      // 先清理旧的（避免删除/导入覆盖后仍残留在运行期注册表里）
      try {
        const nextNames = new Set(all.map((s) => s.name).filter(Boolean));
        for (const oldName of registeredNames) {
          if (!nextNames.has(oldName)) registry.remove(oldName);
        }
        registeredNames = nextNames;
      } catch {
        // 忽略：继续注册即可（最坏情况是残留一个旧技能）
      }

      for (const s of all) {
        if (!s.name) continue;
        registry.register({
          name: s.name,
          description: s.description || '(no description)',
          enabled: !!s.enabled,
          action: buildAction(s),
        });
      }
      return all.length;
    };

    return { registerAll };
  })();

  const creatorUi = (() => {
    const BTN_ID = 'st-agentskills-open-panel';

    let backdropEl = null;
    let modalEl = null;
    let exportBoxEl = null;

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
      exportBoxEl = null;
    };

    const tryClipboardWrite = async (text) => {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      return false;
    };

    const renderSkillList = (container, onEdit) => {
      container.innerHTML = '';

      const skills = creatorStore.list();
      if (!skills.length) {
        container.appendChild(
          el('div', { class: 'st-agentskills-help', text: '还没有任何技能。点击上方“新增/保存”创建一个。' }),
        );
        return;
      }

      for (const s of skills) {
        const pill = el('span', {
          class: 'st-agentskills-pill',
          'data-kind': s.enabled ? 'enabled' : 'disabled',
          text: s.enabled ? '启用' : '禁用',
        });
        const typePill = el('span', { class: 'st-agentskills-pill', text: `type:${s.type}` });

        const meta = el('div', { class: 'st-agentskills-skillmeta' }, [
          el('div', { class: 'st-agentskills-skillname' }, [
            el('span', { text: s.name }),
            el('span', { text: ' ' }),
            pill,
            el('span', { text: ' ' }),
            typePill,
          ]),
          el('div', { class: 'st-agentskills-skilldesc', text: s.description || '(no description)' }),
        ]);

        const toggle = el('button', {
          text: s.enabled ? '禁用' : '启用',
          onclick: () => {
            creatorStore.upsert({ ...s, enabled: !s.enabled });
            creatorSkillRuntime.registerAll();
            renderSkillList(container, onEdit);
          },
        });

        const editBtn = el('button', {
          text: '编辑',
          onclick: () => onEdit(s),
        });

        const delBtn = el('button', {
          text: '删除',
          onclick: () => {
            const ok = window.confirm?.(`确定删除技能 "${s.name}" 吗？`) ?? true;
            if (!ok) return;
            creatorStore.remove(s.name);
            registry.remove(s.name); // 清理运行期注册表，避免残留
            renderSkillList(container, onEdit);
          },
        });

        const controls = el('div', { class: 'st-agentskills-skillcontrols' }, [toggle, editBtn, delBtn]);
        container.appendChild(el('div', { class: 'st-agentskills-skillitem' }, [meta, controls]));
      }
    };

    const open = () => {
      if (modalEl) return;

      backdropEl = el('div', { class: 'st-agentskills-modal-backdrop', onclick: close });
      modalEl = el('div', { class: 'st-agentskills-modal' });

      const title = el('h2', { text: 'ST AgentSkills：轮椅级技能配置' });
      const help = el('div', {
        class: 'st-agentskills-help',
        html:
          [
            '这里创建的技能会保存到浏览器本地（localStorage），无需改代码即可生效。',
            '模型调用格式：<span class="st-agentskills-inline">[CALL: skill_name({..})]</span>',
            '',
            '<span class="st-agentskills-danger">注意：</span>“JS 脚本”类型等同执行自定义代码，仅建议创作者自用/自担风险。',
          ].join('<br/>'),
      });

      const draft = creatorStore.defaultSkill();

      const nameInput = el('input', { value: draft.name, placeholder: '例如：utils.echo' });
      const enabledSelect = el(
        'select',
        {},
        [
          el('option', { value: 'true', text: '启用' }),
          el('option', { value: 'false', text: '禁用' }),
        ],
      );
      enabledSelect.value = 'true';

      const typeSelect = el(
        'select',
        {},
        [
          el('option', { value: 'static', text: '静态/模板（最简单）' }),
          el('option', { value: 'js', text: 'JS 脚本（强大但危险）' }),
          el('option', { value: 'http', text: 'HTTP 请求（调用外部服务）' }),
        ],
      );
      typeSelect.value = draft.type;

      const descBox = el('textarea', { placeholder: '写给模型看的说明：这个技能做什么、参数是什么。' });
      descBox.value = draft.description;

      const staticBox = el('textarea', {
        placeholder: '返回内容。支持 {{key}} / {{json key}} 从参数里取值。例如：Hello, {{name}}',
      });
      staticBox.value = draft.staticText;

      const jsBox = el('textarea', {
        placeholder:
          '写“函数体”，可直接 return ...；可用变量：context(name,args,rawArgs)、helpers(sleep,renderTemplate,safeFetch)\n例如：return { ok:true, args };',
      });
      jsBox.value = draft.jsCode;

      const httpUrl = el('input', { placeholder: 'https://example.com/api', value: draft.http.url });
      const httpMethod = el(
        'select',
        {},
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => el('option', { value: m, text: m })),
      );
      httpMethod.value = draft.http.method;
      const httpHeaders = el('textarea', { placeholder: 'JSON，例如：{"Authorization":"Bearer xxx"}' });
      httpHeaders.value = draft.http.headersJson;
      const httpBody = el('textarea', { placeholder: '请求体模板，例如：{"args": {{json args}} }' });
      httpBody.value = draft.http.bodyJson;
      const httpRespType = el(
        'select',
        {},
        [el('option', { value: 'json', text: '优先 JSON' }), el('option', { value: 'text', text: '纯文本' })],
      );
      httpRespType.value = draft.http.responseType;
      const httpTimeout = el('input', { placeholder: '15000', value: String(draft.http.timeoutMs) });

      const sectionStatic = el('div', {}, [
        el('div', { class: 'st-agentskills-field' }, [el('label', { text: '输出（静态/模板）' }), staticBox]),
      ]);
      const sectionJs = el('div', {}, [
        el('div', { class: 'st-agentskills-field' }, [el('label', { text: 'JS 脚本（函数体）' }), jsBox]),
      ]);
      const sectionHttp = el('div', {}, [
        el('div', { class: 'st-agentskills-row' }, [
          el('div', { class: 'st-agentskills-field' }, [el('label', { text: 'URL' }), httpUrl]),
          el('div', { class: 'st-agentskills-field' }, [el('label', { text: 'Method' }), httpMethod]),
        ]),
        el('div', { class: 'st-agentskills-row' }, [
          el('div', { class: 'st-agentskills-field' }, [el('label', { text: 'Headers(JSON)' }), httpHeaders]),
          el('div', { class: 'st-agentskills-field' }, [el('label', { text: 'Body 模板' }), httpBody]),
        ]),
        el('div', { class: 'st-agentskills-row' }, [
          el('div', { class: 'st-agentskills-field' }, [el('label', { text: '响应类型' }), httpRespType]),
          el('div', { class: 'st-agentskills-field' }, [el('label', { text: '超时(ms)' }), httpTimeout]),
        ]),
      ]);

      const refreshTypeVisibility = () => {
        const t = typeSelect.value;
        sectionStatic.style.display = t === 'static' ? '' : 'none';
        sectionJs.style.display = t === 'js' ? '' : 'none';
        sectionHttp.style.display = t === 'http' ? '' : 'none';
      };
      typeSelect.addEventListener('change', refreshTypeVisibility);
      refreshTypeVisibility();

      let editingName = '';

      const onEdit = (s) => {
        editingName = s.name;
        nameInput.value = s.name;
        enabledSelect.value = s.enabled ? 'true' : 'false';
        typeSelect.value = s.type;
        descBox.value = s.description || '';
        staticBox.value = s.staticText || '';
        jsBox.value = s.jsCode || '';
        httpUrl.value = s.http?.url || '';
        httpMethod.value = s.http?.method || 'POST';
        httpHeaders.value = s.http?.headersJson || '{"Content-Type":"application/json"}';
        httpBody.value = s.http?.bodyJson || '{"args": {{json args}} }';
        httpRespType.value = s.http?.responseType || 'json';
        httpTimeout.value = String(s.http?.timeoutMs ?? 15000);
        refreshTypeVisibility();
      };

      const listWrap = el('div', { class: 'st-agentskills-skilllist' });

      const saveBtn = el('button', {
        text: '新增/保存',
        onclick: () => {
          const next = {
            name: safeString(nameInput.value, '').trim(),
            description: safeString(descBox.value, '').trim(),
            enabled: enabledSelect.value === 'true',
            type: typeSelect.value,
            staticText: safeString(staticBox.value, ''),
            jsCode: safeString(jsBox.value, ''),
            http: {
              url: safeString(httpUrl.value, ''),
              method: safeString(httpMethod.value, 'POST'),
              headersJson: safeString(httpHeaders.value, '{}'),
              bodyJson: safeString(httpBody.value, ''),
              responseType: safeString(httpRespType.value, 'json'),
              timeoutMs: Number(httpTimeout.value) || 15000,
            },
          };

          // 编辑时如果改了 name，删除旧条目，避免留下重复项
          if (editingName && editingName !== next.name) {
            creatorStore.remove(editingName);
            registry.remove(editingName);
          }

          const r = creatorStore.upsert(next);
          if (!r.ok) {
            ui.show({ title: '保存失败', subtitle: r.error || 'unknown', level: 'error', timeoutMs: 2400 });
            return;
          }
          creatorSkillRuntime.registerAll();
          ui.show({ title: '已保存', subtitle: next.name, level: 'info', timeoutMs: 1200 });
          editingName = next.name;
          renderSkillList(listWrap, onEdit);
        },
      });

      const resetBtn = el('button', {
        text: '清空表单',
        onclick: () => {
          editingName = '';
          const d = creatorStore.defaultSkill();
          nameInput.value = d.name;
          enabledSelect.value = 'true';
          typeSelect.value = d.type;
          descBox.value = d.description;
          staticBox.value = d.staticText;
          jsBox.value = d.jsCode;
          httpUrl.value = d.http.url;
          httpMethod.value = d.http.method;
          httpHeaders.value = d.http.headersJson;
          httpBody.value = d.http.bodyJson;
          httpRespType.value = d.http.responseType;
          httpTimeout.value = String(d.http.timeoutMs);
          refreshTypeVisibility();
        },
      });

      const exportBtn = el('button', {
        text: '导出 JSON',
        onclick: async () => {
          const text = creatorStore.exportJson();
          if (exportBoxEl) exportBoxEl.value = text;
          const ok = await tryClipboardWrite(text);
          ui.show({
            title: ok ? '已复制到剪贴板' : '已导出到文本框',
            subtitle: ok ? '可直接粘贴分享给别人' : '可手动复制分享',
            level: 'info',
            timeoutMs: 1800,
          });
        },
      });

      const importBtn = el('button', {
        text: '从 JSON 导入（覆盖）',
        onclick: () => {
          const raw = safeString(exportBoxEl?.value, '').trim();
          if (!raw) {
            ui.show({ title: '导入失败', subtitle: '文本框为空', level: 'error', timeoutMs: 2000 });
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            const r = creatorStore.replaceAll(parsed);
            if (!r.ok) {
              ui.show({ title: '导入失败', subtitle: r.error || 'unknown', level: 'error', timeoutMs: 2400 });
              return;
            }
            // 清空注册表里同名技能的残留（保守起见只做一次全量重注册）
            creatorSkillRuntime.registerAll();
            ui.show({ title: '导入完成', subtitle: `共 ${r.count} 条`, level: 'info', timeoutMs: 1800 });
            renderSkillList(listWrap, onEdit);
          } catch (err) {
            ui.show({
              title: '导入失败',
              subtitle: err instanceof Error ? err.message : safeString(err),
              level: 'error',
              timeoutMs: 2800,
            });
          }
        },
      });

      const closeBtn = el('button', { text: '关闭', onclick: close });

      exportBoxEl = el('textarea', {
        placeholder: '导出会出现在这里；也可以把别人给你的 JSON 粘贴进来，然后点“导入”。',
      });

      const fields = el('div', {}, [
        el('div', { class: 'st-agentskills-row' }, [
          el('div', { class: 'st-agentskills-field' }, [el('label', { text: '技能名（唯一 ID）' }), nameInput]),
          el('div', { class: 'st-agentskills-field' }, [el('label', { text: '启用状态' }), enabledSelect]),
        ]),
        el('div', { class: 'st-agentskills-field' }, [el('label', { text: '类型' }), typeSelect]),
        el('div', { class: 'st-agentskills-field' }, [el('label', { text: '描述（给模型看的）' }), descBox]),
        sectionStatic,
        sectionJs,
        sectionHttp,
      ]);

      const actions = el('div', { class: 'st-agentskills-actions' }, [
        saveBtn,
        resetBtn,
        exportBtn,
        importBtn,
        closeBtn,
      ]);

      const exportField = el('div', { class: 'st-agentskills-field' }, [
        el('label', { text: '导入/导出（JSON）' }),
        exportBoxEl,
      ]);

      modalEl.appendChild(title);
      modalEl.appendChild(help);
      modalEl.appendChild(fields);
      modalEl.appendChild(actions);
      modalEl.appendChild(exportField);
      modalEl.appendChild(el('div', { class: 'st-agentskills-help', text: '已保存技能列表：' }));
      modalEl.appendChild(listWrap);

      document.body.appendChild(backdropEl);
      document.body.appendChild(modalEl);

      renderSkillList(listWrap, onEdit);
    };

    const init = () => {
      try {
        if (document.getElementById(BTN_ID)) return;
        const btn = el('button', { id: BTN_ID, class: 'st-agentskills-btn', text: 'AgentSkills' });
        btn.addEventListener('click', (e) => {
          try {
            e.preventDefault();
            e.stopPropagation();
          } catch {}
          open();
        });
        document.body.appendChild(btn);
      } catch (err) {
        safeConsole.warn('creator UI init failed (ignored)', err);
      }
    };

    return { init };
  })();

  // 全局单例（幂等挂载：重复加载/刷新不应造成异常）
  try {
    if (!window.STAgentSkills || !isPlainObject(window.STAgentSkills)) {
      window.STAgentSkills = {};
    }
    window.STAgentSkills.register = registry.register;
    window.STAgentSkills.version = EXT_VERSION;
  } catch (err) {
    // 即使 window 被限制/不可写，也不能让扩展崩溃
    safeConsole.error('Failed to mount window.STAgentSkills (non-fatal)', err);
  }

  // -----------------------------
  // 提示词注入（System + 深度注入）
  // -----------------------------

  const promptBuilder = (() => {
    const buildSystemPrompt = () => {
      const enabled = registry.listEnabled();
      if (!enabled.length) return '';

      const lines = [];
      lines.push('You can call external skills via a strict text tag.');
      lines.push('When needed, output EXACTLY one call tag in this format:');
      lines.push('[CALL: skill_name({...json args...})]');
      lines.push('');
      lines.push('Available skills:');
      for (const s of enabled) {
        lines.push(`- ${s.name}: ${s.description}`);
      }
      lines.push('');
      lines.push('Rules:');
      lines.push('- Only output the call tag when you need a skill.');
      lines.push('- Use JSON args when possible.');
      lines.push('- After you receive a system message with the result, continue normally.');
      return lines.join('\n');
    };

    // 深度注入兜底：
    // 许多反代/服务端会弱化甚至剥离 System Prompt，因此额外在“最深处”（尽量靠近最后一条用户消息）
    // 注入一段紧凑提醒，以提高稳定性。
    const buildDepthNote = () => {
      const enabled = registry.listEnabled();
      if (!enabled.length) return '';

      const names = enabled.map((s) => s.name).slice(0, 24).join(', ');
      return `Author's Note (tool calling): If you need a skill, output a single tag like [CALL: skill_name({...})]. Skills: ${names}`;
    };

    return { buildSystemPrompt, buildDepthNote };
  })();

  const injectPrompt = (data) => {
    const systemPrompt = promptBuilder.buildSystemPrompt();
    const depthNote = promptBuilder.buildDepthNote();
    if (!systemPrompt && !depthNote) return;

    // 防御性：不同 ST 版本/不同提供方 data 结构可能不同
    const safeAppendToStringField = (obj, key, addition) => {
      if (!addition) return false;
      if (!obj || typeof obj !== 'object') return false;
      if (typeof obj[key] !== 'string') return false;
      obj[key] = `${obj[key]}\n\n${addition}`.trim();
      return true;
    };

    const safePushMessage = (messages, role, content) => {
      if (!content) return false;
      if (!Array.isArray(messages)) return false;
      messages.push({ role, content });
      return true;
    };

    try {
      // 优先路径：结构化 messages 数组
      if (Array.isArray(data?.messages)) {
        if (systemPrompt) safePushMessage(data.messages, 'system', systemPrompt);

        // 深度注入：尽量追加到最后一条 user 消息内容
        if (depthNote) {
          for (let i = data.messages.length - 1; i >= 0; i -= 1) {
            const m = data.messages[i];
            if (m && m.role === 'user' && typeof m.content === 'string') {
              m.content = `${m.content}\n\n${depthNote}`.trim();
              break;
            }
          }
        }
        return;
      }

      // 回退路径：单一 prompt 字符串
      if (safeAppendToStringField(data, 'prompt', systemPrompt)) {
        // 尝试把紧凑提醒也追加到末尾，作为“类深度注入”兜底
        safeAppendToStringField(data, 'prompt', depthNote);
        return;
      }

      // 其他常见字段：兼容部分 fork / provider 的命名
      if (safeAppendToStringField(data, 'chat_completion_prompt', systemPrompt)) {
        safeAppendToStringField(data, 'chat_completion_prompt', depthNote);
      } else if (safeAppendToStringField(data, 'text', systemPrompt)) {
        safeAppendToStringField(data, 'text', depthNote);
      }
    } catch (err) {
      safeConsole.warn('Prompt injection failed (ignored)', err);
    }
  };

  // -----------------------------
  // 解析器（强容错）
  // -----------------------------

  const parser = (() => {
    /**
     * 强容错调用格式：
     * - 允许多余空格/换行
     * - 能穿透 Markdown 包裹（如 **[CALL: ...]** 或 ```[CALL: ...]```）
     * - 参数可选
     *
     * 示例：
     * [CALL: weather({"city":"Tokyo"})]
     * [ CALL : weather ( city=Tokyo, days=3 ) ]
     */
    const CALL_RE =
      /\[\s*CALL\s*:\s*([a-zA-Z0-9_.-]+)\s*(?:\(\s*([\s\S]*?)\s*\))?\s*\]/g;

    const tryParseArgs = (raw) => {
      const text = safeString(raw, '').trim();
      if (!text) return { args: {}, raw: '' };

      // 1）JSON（对象/数组/字符串）
      const looksJson = (s) => {
        const t = s.trim();
        return (
          (t.startsWith('{') && t.endsWith('}')) ||
          (t.startsWith('[') && t.endsWith(']')) ||
          (t.startsWith('"') && t.endsWith('"'))
        );
      };
      if (looksJson(text)) {
        try {
          return { args: JSON.parse(text), raw: text };
        } catch {
          // 继续尝试下一种解析策略
        }
      }

      // 2）key=value：a=1, b="x y", c=true
      // 这里刻意做得更宽松：解析不了的内容会保存在 _raw，避免信息丢失。
      const obj = {};
      const parts = text
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

      let parsedAny = false;
      for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const key = part.slice(0, idx).trim();
        let val = part.slice(idx + 1).trim();
        if (!key) continue;

        parsedAny = true;
        // 尽力做标量类型推断
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        } else if (/^-?\d+(\.\d+)?$/.test(val)) {
          val = Number(val);
        } else if (/^(true|false)$/i.test(val)) {
          val = /^true$/i.test(val);
        } else if (/^(null)$/i.test(val)) {
          val = null;
        }
        obj[key] = val;
      }

      if (parsedAny) return { args: obj, raw: text };
      return { args: { _raw: text }, raw: text };
    };

    const extractFirstCall = (text) => {
      const input = safeString(text, '');
      CALL_RE.lastIndex = 0;
      const match = CALL_RE.exec(input);
      if (!match) return null;
      const skillName = safeString(match[1], '').trim();
      const rawArgs = match[2];
      const parsed = tryParseArgs(rawArgs);
      return {
        skillName,
        args: parsed.args,
        rawArgs: parsed.raw,
        rawTag: match[0],
      };
    };

    return { extractFirstCall };
  })();

  // -----------------------------
  // 执行引擎（坦克层）
  // -----------------------------

  const engine = (() => {
    // 串行化所有调用：避免重入导致 UI 状态和消息流错乱
    let queue = Promise.resolve();

    // 熔断窗口与阈值
    const WINDOW_MS = 30_000;
    const MAX_CALLS_PER_WINDOW = 5;
    const recentCallTimestamps = [];

    const bumpCircuitBreaker = () => {
      const t = nowMs();
      recentCallTimestamps.push(t);
      while (recentCallTimestamps.length && t - recentCallTimestamps[0] > WINDOW_MS) {
        recentCallTimestamps.shift();
      }
      return recentCallTimestamps.length;
    };

    const runSkill = async ({ skillName, args, rawArgs }) => {
      const count = bumpCircuitBreaker();
      if (count > MAX_CALLS_PER_WINDOW) {
        ui.show({
          title: 'Skill loop detected',
          subtitle: `Blocked after ${MAX_CALLS_PER_WINDOW} calls / ${Math.floor(WINDOW_MS / 1000)}s`,
          level: 'error',
          timeoutMs: 4200,
        });

        await stApi.api.addSystemMessage?.(
          `st-agentskills: Circuit breaker triggered. The model called skills too frequently (${count} calls within ${Math.floor(
            WINDOW_MS / 1000,
          )}s). Further calls are blocked to prevent infinite loops.`,
        );
        return;
      }

      const skill = registry.get(skillName);
      if (!skill || !skill.enabled) {
        ui.show({
          title: 'Skill not found',
          subtitle: skill ? `${skillName} is disabled` : skillName,
          level: 'error',
          timeoutMs: 2400,
        });
        await stApi.api.addSystemMessage?.(
          `Skill call failed: "${skillName}" is not registered or not enabled.`,
        );
        return;
      }

      const dispose = ui.show({
        title: 'Skill executing…',
        subtitle: `${skillName}`,
        level: 'info',
        timeoutMs: 0, // manual dispose
      });

      try {
        // 不可信边界：外部 action()（必须被 try/catch 包裹）
        const result = await skill.action({
          name: skillName,
          args,
          rawArgs,
        });

        const payload =
          typeof result === 'string'
            ? result
            : isPlainObject(result) || Array.isArray(result)
              ? safeJsonStringify(result)
              : safeString(result);

        await stApi.api.addSystemMessage?.(
          [
            `Skill result: ${skillName}`,
            '---',
            payload || '(empty result)',
          ].join('\n'),
        );

        // 自动续写：把结果塞回去后，触发 generate() 让模型继续生成
        await stApi.api.triggerGenerate?.();
      } catch (err) {
        // 防御性：skill 失败绝不外溢
        const errorText =
          err instanceof Error
            ? `${err.name}: ${err.message}\n${err.stack || ''}`.trim()
            : safeString(err);

        ui.show({
          title: 'Skill failed',
          subtitle: `${skillName}`,
          level: 'error',
          timeoutMs: 4200,
        });

        await stApi.api.addSystemMessage?.(
          [
            `Skill execution failed: ${skillName}`,
            '---',
            errorText || '(unknown error)',
          ].join('\n'),
        );
      } finally {
        try {
          dispose?.();
        } catch {}
      }
    };

    const enqueue = (call) => {
      queue = queue
        .then(() => runSkill(call))
        .catch((err) => {
          // 兜底：即使引擎自身出错，也不能让队列链断掉
          safeConsole.error('Engine failure (ignored)', err);
        });
    };

    return { enqueue };
  })();

  // -----------------------------
  // 事件绑定（永不崩溃）
  // -----------------------------

  const attach = async () => {
    await stApi.init();

    // 创作者前端配置：启动时自动加载并注册
    try {
      const count = creatorSkillRuntime.registerAll();
      if (count > 0) safeConsole.debug(`已加载创作者技能：${count} 个`);
    } catch (err) {
      safeConsole.warn('加载创作者技能失败（忽略）', err);
    }

    // 创作者面板：即使 ST 事件总线不可用，也尽量可打开查看配置
    try {
      creatorUi.init();
    } catch (err) {
      safeConsole.warn('初始化创作者面板失败（忽略）', err);
    }

    const eventSource = stApi.api.eventSource;
    const types = stApi.api.eventTypes;

    if (!eventSource || typeof eventSource.on !== 'function') {
      safeConsole.warn('eventSource.on not found; only registry is available.');
      return;
    }

    // 1）提示词注入：注册即生效（无需修改预设）
    try {
      eventSource.on(types.CHAT_COMPLETION_PROMPT_READY, (data) => {
        try {
          injectPrompt(data);
        } catch (err) {
          safeConsole.warn('CHAT_COMPLETION_PROMPT_READY handler failed (ignored)', err);
        }
      });
    } catch (err) {
      safeConsole.warn('Failed to attach prompt injection listener (ignored)', err);
    }

    // 2）解析模型输出并触发执行闭环
    try {
      eventSource.on(types.MESSAGE_RECEIVED, (data) => {
        try {
          // data 结构可能不同：尝试常见字段
          const text =
            safeString(data?.mes, '') ||
            safeString(data?.message, '') ||
            safeString(data?.text, '') ||
            safeString(data?.content, '');

          const call = parser.extractFirstCall(text);
          if (!call) return;
          engine.enqueue(call);
        } catch (err) {
          safeConsole.warn('MESSAGE_RECEIVED handler failed (ignored)', err);
        }
      });
    } catch (err) {
      safeConsole.warn('Failed to attach MESSAGE_RECEIVED listener (ignored)', err);
    }

    safeConsole.debug(`Loaded v${EXT_VERSION}`);
  };

  // 启动（对外绝不抛异常）
  try {
    // DOM 未就绪则延后绑定（防御性：扩展可能加载得很早）
    if (document?.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        attach().catch((err) => safeConsole.warn('attach() failed (ignored)', err));
      });
    } else {
      attach().catch((err) => safeConsole.warn('attach() failed (ignored)', err));
    }
  } catch (err) {
    safeConsole.warn('Boot failed (ignored)', err);
  }
})();
