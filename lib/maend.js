/**
 * MaaEnd (MXU) local Web API client + ProjectInterface pipeline_override compiler.
 *
 * The MXU desktop app exposes an unauthenticated loopback HTTP API on
 * http://127.0.0.1:12701/api (settings.webServerEnabled / webServerPort).
 * Everything here is plain fetch based so it can be exercised from node
 * (`node --input-type=module -e "..."`) before the plugin is installed.
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:12701';
export const PORT_CANDIDATES = [12701, 12702, 12703, 12704, 12705, 12706, 12707, 12708, 12709, 12710];

/** MXU built-in "special tasks" (not part of interface.json). */
export const SPECIAL_TASKS = {
  MXU_SLEEP: { entry: 'MXU_SLEEP', action: 'MXU_SLEEP_ACTION', label: '等待' },
  MXU_WAITUNTIL: { entry: 'MXU_WAITUNTIL', action: 'MXU_WAITUNTIL_ACTION', label: '等到指定时间' },
  MXU_LAUNCH: { entry: 'MXU_LAUNCH', action: 'MXU_LAUNCH_ACTION', label: '启动程序' },
  MXU_WEBHOOK: { entry: 'MXU_WEBHOOK', action: 'MXU_WEBHOOK_ACTION', label: 'Webhook' },
  MXU_NOTIFY: { entry: 'MXU_NOTIFY', action: 'MXU_NOTIFY_ACTION', label: '通知' },
  MXU_KILLPROC: { entry: 'MXU_KILLPROC', action: 'MXU_KILLPROC_ACTION', label: '结束进程' },
  MXU_POWER: { entry: 'MXU_POWER', action: 'MXU_POWER_ACTION', label: '系统操作' },
};

/**
 * Special tasks as they are persisted in MXU's own config (`instance.tasks[].taskName`).
 * The UI writes `__MXU_POWER__` / `__MXU_KILLPROC__` / … and keeps their options in
 * `optionValues` under the matching `__MXU_*_OPTION__` key, so a chain built from the
 * config must compile those entries too.
 */
export const SPECIAL_TASK_CONFIG_NAMES = {
  __MXU_SLEEP__: 'MXU_SLEEP',
  __MXU_WAITUNTIL__: 'MXU_WAITUNTIL',
  __MXU_LAUNCH__: 'MXU_LAUNCH',
  __MXU_WEBHOOK__: 'MXU_WEBHOOK',
  __MXU_NOTIFY__: 'MXU_NOTIFY',
  __MXU_KILLPROC__: 'MXU_KILLPROC',
  __MXU_POWER__: 'MXU_POWER',
};

const PRETASK_PREFIX = '__MXU_PRETASK__';

class MaendError extends Error {}

function isTruthyName(name) {
  return ['Yes', 'yes', 'Y', 'y', 'true', 'True', '1'].includes(String(name));
}

function specialTask(kind, param) {
  const def = SPECIAL_TASKS[kind];
  if (!def) throw new MaendError(`unknown special task: ${kind}`);
  const override = [{ [def.entry]: { action: 'Custom', custom_action: def.action, target: [0, 0, 1, 1], custom_action_param: param } }];
  return {
    entry: def.entry,
    pipeline_override: JSON.stringify(override),
    selected_task_id: null,
    task_name: def.label,
    options: {},
  };
}

export const muteTask = () => specialTask('MXU_POWER', { power_action: 'mute' });
export const unmuteTask = () => specialTask('MXU_POWER', { power_action: 'unmute' });
export const killGameTask = (processName = 'Endfield.exe') =>
  specialTask('MXU_KILLPROC', { kill_self: false, process_name: processName });
export const webhookTask = (url) => specialTask('MXU_WEBHOOK', { url });
export const notifyTask = (title, body) => specialTask('MXU_NOTIFY', { title, body });
export const sleepTask = (seconds) => specialTask('MXU_SLEEP', { sleep_time: Math.max(1, Math.round(seconds)) });

/** Compile one `__MXU_*__` task entry from MXU's own config into a start request. */
export function buildSpecialTaskFromConfig(kind, taskConfig) {
  const values = taskConfig?.optionValues ?? {};
  const inputValues = (key) => values[key]?.values ?? {};
  const switchValue = (key, fallback = false) => {
    const raw = values[key]?.value;
    return typeof raw === 'boolean' ? raw : fallback;
  };
  const selectCase = (key, fallback) => values[key]?.caseName ?? fallback;

  let param;
  if (kind === 'MXU_POWER') {
    param = { power_action: selectCase('__MXU_POWER_OPTION__', 'shutdown') };
  } else if (kind === 'MXU_KILLPROC') {
    const killSelf = switchValue('__MXU_KILLPROC_SELF_OPTION__', true);
    const processName = inputValues('__MXU_KILLPROC_NAME_OPTION__').process_name ?? '';
    param = killSelf ? { kill_self: true } : { kill_self: false, process_name: processName };
  } else if (kind === 'MXU_WEBHOOK') {
    param = { url: inputValues('__MXU_WEBHOOK_OPTION__').url ?? '' };
  } else if (kind === 'MXU_NOTIFY') {
    const v = inputValues('__MXU_NOTIFY_OPTION__');
    param = { title: v.title ?? 'MXU', body: v.body ?? '' };
  } else if (kind === 'MXU_SLEEP') {
    const v = inputValues('__MXU_SLEEP_OPTION__');
    param = { sleep_time: Math.max(1, Math.round(Number(v.sleep_time ?? 5) || 5)) };
  } else if (kind === 'MXU_WAITUNTIL') {
    param = { target_time: inputValues('__MXU_WAITUNTIL_OPTION__').target_time ?? '08:00' };
  } else if (kind === 'MXU_LAUNCH') {
    const v = inputValues('__MXU_LAUNCH_OPTION__');
    param = {
      program: v.program ?? '',
      args: v.args ?? '',
      wait_for_exit: switchValue('__MXU_LAUNCH_WAIT_OPTION__'),
      use_cmd: switchValue('__MXU_LAUNCH_CMD_OPTION__'),
      skip_if_running: switchValue('__MXU_LAUNCH_SKIP_OPTION__'),
    };
  } else {
    return null;
  }

  const task = specialTask(kind, param);
  return { ...task, selected_task_id: taskConfig?.id ?? null };
}

/** Which hook behaviours the instance's own task list already performs. */
export function specialPresence(tasks) {
  const presence = { mute: false, unmute: false, kill: false, webhook: false };
  for (const t of tasks ?? []) {
    if (!t || t.enabled === false) continue;
    const kind = SPECIAL_TASK_CONFIG_NAMES[t.taskName];
    if (!kind) continue;
    if (kind === 'MXU_POWER') {
      const action = t.optionValues?.__MXU_POWER_OPTION__?.caseName;
      if (action === 'mute') presence.mute = true;
      else if (action === 'unmute') presence.unmute = true;
    } else if (kind === 'MXU_KILLPROC') {
      presence.kill = true;
    } else if (kind === 'MXU_WEBHOOK') {
      presence.webhook = true;
    }
  }
  return presence;
}

/* ------------------------------------------------------------------ */
/* option compiler (port of MXU frontend Ea / Jn / bg)                 */
/* ------------------------------------------------------------------ */

function optionSupported(def, controllerName, resourceName) {
  if (Array.isArray(def.controller) && def.controller.length > 0 && !def.controller.includes(controllerName)) return false;
  if (Array.isArray(def.resource) && def.resource.length > 0 && !def.resource.includes(resourceName)) return false;
  return true;
}

function optionDefaults(def) {
  if (def.type === 'select') return { type: 'select', caseName: def.default_case ?? def.cases?.[0]?.name };
  if (def.type === 'switch') return { type: 'switch', value: isTruthyName(def.default_case ?? def.cases?.[0]?.name ?? '') };
  if (def.type === 'checkbox') {
    const dc = def.default_case;
    return { type: 'checkbox', caseNames: Array.isArray(dc) ? dc : dc ? [dc] : [] };
  }
  if (def.type === 'input') {
    const values = {};
    for (const input of def.inputs ?? []) values[input.name] = input.default ?? '';
    return { type: 'input', values };
  }
  if (def.type === 'hotkey') {
    const values = {};
    for (const hk of def.hotkeys ?? []) values[hk.name] = hk.default ?? '';
    return { type: 'hotkey', values };
  }
  return undefined;
}

function normalizeValue(raw, def) {
  if (!raw || typeof raw !== 'object') {
    if (typeof raw === 'string' && def.type === 'select') return { type: 'select', caseName: raw };
    if (typeof raw === 'boolean' && def.type === 'switch') return { type: 'switch', value: raw };
    return undefined;
  }
  if (def.type === 'select' && typeof raw.caseName === 'string') return { type: 'select', caseName: raw.caseName };
  if (def.type === 'switch' && typeof raw.value === 'boolean') return { type: 'switch', value: raw.value };
  if (def.type === 'checkbox' && Array.isArray(raw.caseNames)) return { type: 'checkbox', caseNames: raw.caseNames };
  if (def.type === 'input' && raw.values && typeof raw.values === 'object') return { type: 'input', values: raw.values };
  if (def.type === 'hotkey' && raw.values && typeof raw.values === 'object') return { type: 'hotkey', values: raw.values };
  return undefined;
}

function replaceQuoted(source, placeholder, value) {
  return source.split(`"${placeholder}"`).join(String(value));
}

function replaceRaw(source, placeholder, value) {
  return source.split(placeholder).join(String(value));
}

function applyInputOverrides(def, cur, parts) {
  const inputs = def.type === 'hotkey' ? def.hotkeys ?? [] : def.inputs ?? [];
  let text = JSON.stringify(def.pipeline_override);
  for (const input of inputs) {
    const name = input.name;
    const raw = cur.values?.[name] ?? input.default ?? '';
    const placeholder = `{${name}}`;
    if (def.type === 'hotkey') continue; // keycode tables live in the MXU UI; skip (reported as warning)
    const pipelineType = input.pipeline_type || 'string';
    if (pipelineType === 'int') {
      const num = String(raw === '' ? '0' : raw).trim();
      text = replaceQuoted(text, placeholder, num);
      text = replaceRaw(text, placeholder, num);
    } else if (pipelineType === 'bool') {
      const flag = isTruthyName(String(raw).toLowerCase());
      text = replaceQuoted(text, placeholder, flag);
      text = replaceRaw(text, placeholder, flag);
    } else {
      text = replaceQuoted(text, placeholder, JSON.stringify(String(raw)));
      text = replaceRaw(text, placeholder, JSON.stringify(String(raw)).slice(1, -1));
    }
  }
  try {
    parts.push(JSON.parse(text));
  } catch {
    /* malformed definition -> treat as no override */
  }
}

function joinOption(optionName, values, parts, optionDefs, controllerName, resourceName, warnings) {
  const def = optionDefs?.[optionName];
  if (!def) return;
  if (!optionSupported(def, controllerName, resourceName)) return;
  const cur = normalizeValue(values?.[optionName], def) ?? optionDefaults(def);
  if (!cur) return;

  if (cur.type === 'checkbox' && def.type === 'checkbox') {
    const selected = new Set(cur.caseNames ?? []);
    for (const item of def.cases ?? []) {
      if (selected.has(item.name) && item.pipeline_override) parts.push(item.pipeline_override);
    }
    return;
  }

  if ((cur.type === 'select' || cur.type === 'switch') && Array.isArray(def.cases)) {
    let caseName;
    if (cur.type === 'switch') {
      const match = def.cases.find((c) => isTruthyName(c.name) === Boolean(cur.value));
      caseName = match?.name ?? (cur.value ? 'Yes' : 'No');
    } else {
      caseName = cur.caseName;
    }
    const chosen = def.cases.find((c) => c.name === caseName);
    if (chosen?.pipeline_override) parts.push(chosen.pipeline_override);
    for (const sub of chosen?.option ?? []) {
      joinOption(sub, values, parts, optionDefs, controllerName, resourceName, warnings);
    }
    return;
  }

  if ((cur.type === 'input' || cur.type === 'hotkey') && def.pipeline_override) {
    if (cur.type === 'hotkey') {
      warnings?.push(`hotkey 选项 ${optionName} 未编译（需要前端键码表）`);
      return;
    }
    applyInputOverrides(def, cur, parts);
  }
}

/**
 * Compile one instance task into the `POST /tasks/start` shape.
 * Mirrors MXU's frontend compiler so user option values are honoured.
 */
export function buildTask(taskConfig, iface, controllerName, resourceName, globalOptionValues) {
  const taskName = taskConfig.taskName;
  const warnings = [];

  const specialKind = SPECIAL_TASK_CONFIG_NAMES[taskName];
  if (specialKind) {
    return { task: buildSpecialTaskFromConfig(specialKind, taskConfig), warnings: [] };
  }
  if (taskName in SPECIAL_TASKS) {
    return { task: null, warnings: [`特殊任务需以配置形式出现（${taskName} 无 __ 包裹）`] };
  }

  let taskDef;
  if (taskName.startsWith(PRETASK_PREFIX)) {
    const pretaskName = taskName.slice(PRETASK_PREFIX.length);
    taskDef = (iface.pretask ?? []).find((p) => p.name === pretaskName || p.entry === pretaskName);
  } else {
    taskDef = (iface.task ?? []).find((t) => t.name === taskName);
  }
  if (!taskDef) return { task: null, warnings: [`interface 中找不到任务定义: ${taskName}`] };

  const entry = taskDef.entry ?? taskDef.name;
  const parts = [];
  if (taskDef.pipeline_override) parts.push(taskDef.pipeline_override);

  const options = iface.option ?? {};
  const values = taskConfig.optionValues ?? {};

  if (taskDef.option?.length) {
    for (const optionName of taskDef.option) {
      joinOption(optionName, values, parts, options, controllerName, resourceName, warnings);
    }
  }
  const resourceDef = (iface.resource ?? []).find((r) => r.name === resourceName);
  for (const optionName of resourceDef?.option ?? []) {
    joinOption(optionName, values, parts, options, controllerName, resourceName, warnings);
  }
  const controllerDef = (iface.controller ?? []).find((c) => c.name === controllerName);
  for (const optionName of controllerDef?.option ?? []) {
    joinOption(optionName, values, parts, options, controllerName, resourceName, warnings);
  }
  for (const optionName of iface.global_option ?? []) {
    joinOption(optionName, globalOptionValues ?? {}, parts, options, controllerName, resourceName, warnings);
  }

  return {
    task: {
      entry,
      pipeline_override: JSON.stringify(parts),
      selected_task_id: taskConfig.id ?? null,
      task_name: taskName,
      options: flattenOptions(values),
    },
    warnings,
  };
}

/** `options` is diagnostics only (MXU ignores it), but it shows up in MXU logs. */
export function flattenOptions(values) {
  const out = {};
  let count = 0;
  for (const [name, value] of Object.entries(values ?? {})) {
    if (count >= 100) break;
    if (!value || typeof value !== 'object') continue;
    let entries;
    if (value.type === 'select') entries = [[name, String(value.caseName ?? '')]];
    else if (value.type === 'switch') entries = [[name, value.value ? 'true' : 'false']];
    else if (value.type === 'checkbox') {
      entries = (value.caseNames ?? []).length === 0 ? [[name, 'none']] : (value.caseNames ?? []).map((c) => [`${name}.${c}`, 'true']);
    } else if (value.type === 'input' || value.type === 'hotkey') {
      entries = Object.entries(value.values ?? {}).map(([k, v]) => [`${name}.${k}`, String(v)]);
    } else continue;
    for (const [k, v] of entries) {
      if (count >= 100) break;
      out[k] = String(v).slice(0, 512);
      count += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* chain builder                                                       */
/* ------------------------------------------------------------------ */

/**
 * Assemble the task chain for one run.
 * hooks: { muteOnStart, unmuteOnFinish, killGameOnFinish, webhookUrl, notifyTitle, notifyBody }
 */
export function buildChain({ instance, iface, taskNames, hooks = {}, controllerName, resourceName, includePretask = false }) {
  const tasks = [];
  const warnings = [];
  const enabled = (instance.tasks ?? []).filter((t) => {
    if (!t.enabled) return false;
    // Pretasks (game launch / connect) have no HTTP task route in MXU: the UI runs
    // them through a Tauri IPC command. Skipping them here keeps the chain valid.
    if (!includePretask && String(t.taskName ?? '').startsWith(PRETASK_PREFIX)) return false;
    const byController = t.enabledByController;
    if (byController && typeof byController === 'object' && controllerName in byController) return Boolean(byController[controllerName]);
    return true;
  });
  const wanted = Array.isArray(taskNames) && taskNames.length > 0 ? new Set(taskNames) : null;
  for (const taskConfig of enabled) {
    if (wanted && !wanted.has(taskConfig.taskName) && !wanted.has(taskConfig.id)) continue;
    const built = buildTask(taskConfig, iface, controllerName, resourceName, {});
    warnings.push(...built.warnings);
    if (built.task) tasks.push(built.task);
  }

  const chain = [];
  // If the instance's own task list already carries the special tasks (added from the
  // MXU UI or by the plugin), do not inject a duplicate at the same place.
  const presence = specialPresence(instance.tasks ?? []);
  if (hooks.muteOnStart) {
    if (presence.mute) warnings.push('静音已存在于实例任务列表，跳过链首注入');
    else chain.push(muteTask());
  }
  chain.push(...tasks);
  if (hooks.webhookUrl) {
    if (presence.webhook) warnings.push('webhook 已存在于实例任务列表，跳过注入');
    else chain.push(webhookTask(hooks.webhookUrl));
  }
  // Kill-game MUST NOT be part of the chain: MXU is fail-forward, so a chain whose
  // tasks fail instantly (e.g. wrong game state) would still reach the kill step and
  // close the game. The caller runs it as a separate task only after a successful run.
  if (hooks.killGameOnFinish) warnings.push('关游戏不在任务链内：运行成功后再单独执行');
  const killAfterRun = Boolean(hooks.killGameOnFinish) && !presence.kill;
  if (presence.kill) warnings.push('实例任务列表里已有「结束后关闭游戏」，它会随链执行（不受成功校验保护），建议移除');
  if (hooks.muteOnStart && hooks.unmuteOnFinish !== false && !presence.unmute) chain.push(unmuteTask());
  if (presence.unmute) warnings.push('取消静音已在实例任务列表中');

  return { chain, warnings, skipped: enabled.length - tasks.length, killAfterRun };
}

/* ------------------------------------------------------------------ */
/* agent plumbing                                                      */
/* ------------------------------------------------------------------ */

const INTERFACE_LANGUAGE_KEYS = {
  'zh-CN': 'zh_cn',
  'zh-TW': 'zh_tw',
  'en-US': 'en_us',
  'ja-JP': 'ja_jp',
  'ko-KR': 'ko_kr',
};

/** interface.json `agent` → the `agent_configs` array tasks/start expects. */
export function agentConfigsFromInterface(iface) {
  const agent = iface?.agent;
  if (!agent) return [];
  const list = Array.isArray(agent) ? agent : [agent];
  const configs = [];
  for (const item of list) {
    const childExec = item?.child_exec ?? item?.childExec;
    if (!childExec) continue;
    const config = { child_exec: childExec };
    if (Array.isArray(item.child_args) && item.child_args.length > 0) config.child_args = item.child_args;
    configs.push(config);
  }
  return configs;
}

/**
 * MXU sends these env vars to the agent processes (see MaaFramework ProjectInterface
 * convention). Without a spawned agent every MaaEnd custom action fails instantly with
 * `Action is null`, so both agent_configs and pi_envs are required.
 */
export function piEnvsFromInterface({ iface, controllerName, resourceName, language, maaVersion }) {
  const envs = {
    PI_INTERFACE_VERSION: 'v2.10.1',
    PI_CLIENT_NAME: 'MXU',
    PI_CLIENT_VERSION: '2.8.0',
    PI_CLIENT_LANGUAGE: INTERFACE_LANGUAGE_KEYS[language] ?? INTERFACE_LANGUAGE_KEYS['zh-CN'],
  };
  if (maaVersion) envs.PI_CLIENT_MAAFW_VERSION = String(maaVersion).startsWith('v') ? String(maaVersion) : `v${maaVersion}`;
  if (iface?.version) envs.PI_VERSION = iface.version;
  const controller = (iface?.controller ?? []).find((entry) => entry?.name === controllerName);
  if (controller) envs.PI_CONTROLLER = JSON.stringify(controller);
  const resource = (iface?.resource ?? []).find((entry) => entry?.name === resourceName);
  if (resource) envs.PI_RESOURCE = JSON.stringify(resource);
  return envs;
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                         */
/* ------------------------------------------------------------------ */

export function createClient({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 8000 } = {}) {
  let root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let ifaceCache = null;
  let ifaceEnvelopeCache = null;
  let ifaceCachedAt = 0;
  const ifaceTtlMs = 10 * 60 * 1000;

  const api = (path) => `${root}/api${path}`;

  async function request(path, { method = 'GET', body, timeout = timeoutMs, signal } = {}) {
    const init = { method, headers: {}, signal: signal ?? AbortSignal.timeout(timeout) };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(api(path), init);
    } catch (error) {
      throw new MaendError(`连接 MaaEnd 失败 (${root}${path}): ${error?.message ?? error}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new MaendError(`MXU ${method} ${path} → HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    if (!contentType.includes('application/json')) {
      throw new MaendError(`MXU ${path} 返回非 JSON (${contentType || 'no content-type'})，可能命中了前端静态页面`);
    }
    return response.json();
  }

  return {
    get baseUrl() {
      return root;
    },
    setBaseUrl(url) {
      root = String(url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    },
    async ping() {
      return request('/maa/initialized', { timeout: 3000 });
    },
    async discover() {
      const errors = [];
      for (const port of PORT_CANDIDATES) {
        try {
          const candidate = `http://127.0.0.1:${port}`;
          const response = await fetch(`${candidate}/api/maa/initialized`, { signal: AbortSignal.timeout(900) });
          if (response.ok) {
            root = candidate;
            return candidate;
          }
        } catch (error) {
          errors.push(String(error?.message ?? error));
        }
      }
      throw new MaendError(`在 12701-12710 上没找到 MaaEnd Web 服务`);
    },
    async getState() {
      return request('/maa/state');
    },
    async getWindows(classRegex = 'UnityWndClass', windowRegex = 'Endfield') {
      const query = `?class_regex=${encodeURIComponent(classRegex)}&window_regex=${encodeURIComponent(windowRegex)}`;
      const payload = await request(`/maa/windows${query}`, { timeout: 8000 });
      return Array.isArray(payload) ? payload : [];
    },
    /**
     * MXU's tasker dies with the game window: after a restart the instance stays
     * disconnected and tasks/start fails with "Tasker not properly initialized".
     * Reconnecting is what the MXU UI does before starting a chain.
     */
    async connect(instanceId, { handle, type = 'Win32', controllerInfo } = {}) {
      const state = controllerInfo ?? {};
      const body =
        type === 'Win32'
          ? {
              type: 'Win32',
              handle,
              screencap_method: state.screencap_method ?? 32,
              mouse_method: state.mouse_method ?? 1,
              keyboard_method: state.keyboard_method ?? 1,
            }
          : { type, handle };
      return request(`/maa/instances/${encodeURIComponent(instanceId)}/connect`, { method: 'POST', body, timeout: 20000 });
    },
    /** MXU refuses tasks/start with "Resource not loaded" until the resource is loaded. */
    async loadResource(instanceId, paths) {
      return request(`/maa/instances/${encodeURIComponent(instanceId)}/resource/load`, {
        method: 'POST',
        body: { paths },
        timeout: 60000,
      });
    },
    /** Full /interface envelope: basePath is needed to resolve resource paths. */
    async getInterfaceEnvelope({ refresh = false } = {}) {
      if (!refresh && ifaceEnvelopeCache && Date.now() - ifaceCachedAt < ifaceTtlMs) return ifaceEnvelopeCache;
      const payload = await request('/interface', { timeout: 30000 });
      ifaceEnvelopeCache = payload;
      ifaceCachedAt = Date.now();
      return payload;
    },
    async getConfig() {
      return request('/config', { timeout: 15000 });
    },
    async putConfig(config) {
      return request('/config', { method: 'PUT', body: config, timeout: 20000 });
    },
    async getInterface({ refresh = false } = {}) {
      const now = Date.now();
      if (!refresh && ifaceCache && now - ifaceCachedAt < ifaceTtlMs) return ifaceCache;
      const payload = await request('/interface', { timeout: 30000 });
      ifaceCache = payload?.interface ? payload.interface : payload;
      ifaceCachedAt = now;
      return ifaceCache;
    },
    async getLogs() {
      return request('/logs', { timeout: 15000 });
    },
    async isElevated() {
      return request('/system/is-elevated', { timeout: 3000 });
    },
    async screenshot(instanceId, { timeout = 20000 } = {}) {
      const response = await fetch(api(`/maa/instances/${encodeURIComponent(instanceId)}/screenshot`), {
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new MaendError(`截图失败: HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) throw new MaendError(`截图返回了非图片内容 (${contentType})`);
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, contentType };
    },
    async startTasks(instanceId, tasks, { cwd, controllerInfo, controllerName, resourceName, language, interfaceSnapshot } = {}) {
      const iface = interfaceSnapshot ?? (await this.getInterface().catch(() => null));
      const agents = agentConfigsFromInterface(iface);
      const ctrlName = controllerName ?? controllerInfo?.name ?? 'Win32-Front';
      const resName = resourceName ?? '官服';
      let maaVersion = null;
      if (agents.length > 0) {
        maaVersion = await request('/maa/initialized', { timeout: 3000 }).then((r) => r?.version ?? null).catch(() => null);
      }
      const envs =
        agents.length > 0
          ? piEnvsFromInterface({ iface, controllerName: ctrlName, resourceName: resName, language, maaVersion })
          : null;
      return request(`/maa/instances/${encodeURIComponent(instanceId)}/tasks/start`, {
        method: 'POST',
        timeout: 30000,
        body: {
          tasks,
          agent_configs: agents.length > 0 ? agents : null,
          cwd: cwd ?? '',
          tcp_compat_mode: false,
          pi_envs: envs,
          controller_info: controllerInfo ?? { name: ctrlName, type: 'Win32' },
        },
      });
    },
    async runTasks(instanceId, tasks) {
      return request(`/maa/instances/${encodeURIComponent(instanceId)}/tasks/run`, {
        method: 'POST',
        timeout: 30000,
        body: tasks.map(({ entry, pipeline_override, selected_task_id }) => ({ entry, pipeline_override, selected_task_id })),
      });
    },
    async stopTasks(instanceId) {
      return request(`/maa/instances/${encodeURIComponent(instanceId)}/tasks/stop`, { method: 'POST', body: {}, timeout: 15000 });
    },
    /** Stop leftover per-run agents so the next tasks/start can spawn a fresh one. */
    async stopAgent(instanceId) {
      return request(`/maa/instances/${encodeURIComponent(instanceId)}/agent/stop`, { method: 'POST', body: {}, timeout: 15000 });
    },
    async stopAgent(instanceId) {
      return request(`/maa/instances/${encodeURIComponent(instanceId)}/agent/stop`, { method: 'POST', body: {}, timeout: 15000 });
    },
    async heartbeat() {
      return request('/heartbeat', { timeout: 3000 });
    },
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function listInstances(configDoc) {
  return (configDoc?.instances ?? []).map((instance) => ({
    id: instance.id,
    name: instance.name,
    controllerName: instance.controllerName ?? 'Win32-Front',
    resourceName: instance.resourceName ?? '官服',
    tasks: instance.tasks ?? [],
    schedulePolicies: instance.schedulePolicies ?? [],
  }));
}

export function describeRunState(stateDoc, instanceId) {
  const instance = stateDoc?.instances?.[instanceId];
  if (!instance) return { known: false, connected: false, running: false };
  const runState = instance.task_run_state ?? {};
  return {
    known: true,
    connected: Boolean(instance.connected),
    running: Boolean(instance.is_running),
    resourceLoaded: Boolean(instance.resource_loaded),
    overall: runState.overall_status ?? null,
    currentTaskIndex: typeof runState.current_task_index === 'number' ? runState.current_task_index : null,
    pendingTaskIds: runState.pending_task_ids ?? [],
    statuses: runState.statuses ?? {},
    mappings: runState.mappings ?? {},
  };
}

export async function waitForIdle(client, instanceId, { timeoutMs = 45 * 60 * 1000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  let idleStreak = 0;
  let sawRunning = false;
  while (Date.now() - started < timeoutMs) {
    let state;
    try {
      state = await client.getState();
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const info = describeRunState(state, instanceId);
    if (info.running) {
      sawRunning = true;
      idleStreak = 0;
    } else if (sawRunning) {
      idleStreak += 1;
      if (idleStreak >= 2) {
        return { ok: true, reason: 'idle', elapsedMs: Date.now() - started, state: info };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, reason: 'timeout', elapsedMs: Date.now() - started, sawRunning };
}

export { MaendError };

/**
 * Watch MXU's WebSocket for the terminal event of the tasks we just started.
 *
 * `task_run_state.statuses` cannot decide success: MXU keeps stale entries from
 * earlier runs and clears them again on stop, so a failed/aborted chain can look
 * "all succeeded" and would wrongly trigger the auto-close hook. The
 * Tasker.Task.{Succeeded,Failed} callback carries the MaaFramework task id that
 * /tasks/start returned, which is unambiguous.
 */
export function watchRunEvents({ taskIds, baseUrl = DEFAULT_BASE_URL, timeoutMs = 45 * 60 * 1000 }) {
  const targets = new Set((taskIds ?? []).map((id) => String(id)));
  const results = new Map();
  if (targets.size === 0) return Promise.resolve({ complete: false, results: Object.fromEntries(results), reason: 'no-task-ids' });
  const wsUrl = `${String(baseUrl).replace(/^http/, 'ws').replace(/\/+$/, '')}/api/ws`;
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve({
        complete: results.size === targets.size,
        reason,
        results: Object.fromEntries(results),
      });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      finish(`socket-error: ${error?.message ?? error}`);
      return;
    }
    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload?.type !== 'maa-callback') return;
      const message = String(payload.payload?.message ?? '');
      const match = /^Tasker\.Task\.(Succeeded|Failed)$/.exec(message);
      if (!match) return;
      let details;
      try {
        details = JSON.parse(String(payload.payload?.details ?? '{}'));
      } catch {
        return;
      }
      const taskId = String(details?.task_id ?? '');
      if (!targets.has(taskId)) return;
      results.set(taskId, match[1] === 'Succeeded' ? 'succeeded' : 'failed');
      if (results.size === targets.size) finish('complete');
    });
    socket.addEventListener('error', () => finish('socket-error'));
    socket.addEventListener('close', () => finish('closed'));
  });
}

