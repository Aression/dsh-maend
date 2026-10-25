/**
 * dsh-maend — host half.
 *
 * Exposes MaaEnd (MXU) automation to the DSH agent as tools, and a small
 * authenticated JSON API consumed by the client dashboard (client.js):
 *
 *   GET  /api/dsh-maend/status      dashboard snapshot
 *   POST /api/dsh-maend/action      { op, ...args }
 *   GET  /api/dsh-maend/screenshot  proxied live frame (image/png)
 *
 * The MXU side is plain loopback HTTP (no auth, see analysis/feasibility.md).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildChain,
  createClient,
  describeRunState,
  killGameTask,
  listInstances,
  muteTask,
  sleepTask,
  unmuteTask,
  waitForIdle,
  watchRunEvents,
  MaendError,
} from './lib/maend.js';
import { parametersSchema } from './lib/schema.js';
import { resolveInstall } from './lib/install.js';

export const name = 'dsh-maend';
export const inject = ['tools', 'connection'];

const HOOKS_FILE = path.join(os.homedir(), '.dsh', 'maend-hooks.json');

const DEFAULT_HOOKS = {
  muteOnStart: true,
  unmuteOnFinish: true,
  killGameOnFinish: true,
  webhookUrl: '',
  processName: 'Endfield.exe',
};

function loadHooks() {
  try {
    const text = fs.readFileSync(HOOKS_FILE, 'utf8');
    return { ...DEFAULT_HOOKS, ...JSON.parse(text) };
  } catch {
    return { ...DEFAULT_HOOKS };
  }
}

function saveHooks(hooks) {
  fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });
  fs.writeFileSync(HOOKS_FILE, JSON.stringify(hooks, null, 2), 'utf8');
}

const json = (value, init) => Response.json(value, { headers: { 'cache-control': 'no-store' }, ...init });
const fail = (error, status = 500) => json({ ok: false, error: String(error?.message ?? error) }, { status });

/** Human-readable task label; MXU stores a customName for user-added tasks. */
const SPECIAL_TASK_LABELS = {
  __MXU_POWER__: '系统操作',
  __MXU_KILLPROC__: '结束进程',
  __MXU_WEBHOOK__: 'Webhook',
  __MXU_NOTIFY__: '通知',
  __MXU_SLEEP__: '等待',
  __MXU_WAITUNTIL__: '等到指定时间',
  __MXU_LAUNCH__: '启动程序',
};

function describeTaskLabel(task) {
  const name = String(task?.taskName ?? '');
  if (task?.customName) return String(task.customName);
  if (name.startsWith('__MXU_PRETASK__')) return `启动游戏 · ${name.slice('__MXU_PRETASK__'.length)}`;
  if (SPECIAL_TASK_LABELS[name]) return SPECIAL_TASK_LABELS[name];
  return name;
}

function summarizeLogs(logsDoc, instanceId, limit) {
  const entries = (instanceId ? logsDoc?.[instanceId] : Object.values(logsDoc ?? {}).flat()) ?? [];
  return entries.slice(-limit).map((entry) => ({
    id: entry.id,
    timestamp: entry.timestamp,
    type: entry.type,
    message: entry.message,
  }));
}

function textBlocks(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** Registry-ready definition without importing @deepseek-ai/dsh-tools. */
function tool(definition) {
  const { parameters, ...rest } = definition;
  return {
    ...rest,
    parameters: parametersSchema(parameters),
    output: {
      schema: {},
      render: (_args, value) => textBlocks(value ?? null),
    },
  };
}

/** Instances may be addressed by id or by display name. */
function pickInstance(instances, key, fallback) {
  const wanted = key ?? fallback;
  if (!wanted) return instances[0];
  return (
    instances.find((item) => item.id === wanted) ??
    instances.find((item) => item.name === wanted) ??
    instances.find((item) => String(item.name).includes(String(wanted))) ??
    undefined
  );
}

export function apply(ctx, config = {}) {
  const client = createClient({ baseUrl: config.baseUrl ?? undefined });
  const state = {
    selectedInstance: config.instance ?? null,
    hooks: loadHooks(),
    lastRun: null,
  };

  /** Cached `{ dir, exe, source }` for the local MaaEnd install (see lib/install.js). */
  let installCache = null;
  async function findInstall() {
    if (installCache) return installCache;
    let mxuBasePath = null;
    try {
      mxuBasePath = (await client.getInterfaceEnvelope())?.basePath ?? null;
    } catch {
      mxuBasePath = null;
    }
    installCache = resolveInstall({ configDir: config.installDir, mxuBasePath });
    return installCache;
  }

  async function requireInstall(purpose) {
    const install = await findInstall();
    if (!install) {
      throw new MaendError(
        `找不到 MaaEnd 安装目录（需要包含 ${'MaaEnd.exe'}）。` +
          `请设置环境变量 MAAEND_HOME，或在插件配置里填 installDir。当前用途：${purpose}`,
      );
    }
    return install;
  }

  /* ---------------------------------------------------------------- */
  /* shared operations (tools + dashboard use the same code paths)     */
  /* ---------------------------------------------------------------- */

  async function readSnapshot({ logLimit = 40 } = {}) {
    const baseUrl = client.baseUrl;
    let reachable = false;
    let stateError = null;
    let stateDoc = null;
    try {
      stateDoc = await client.getState();
      reachable = true;
    } catch (error) {
      stateError = String(error?.message ?? error);
    }
    let configDoc = null;
    let iface = null;
    if (reachable) {
      try {
        configDoc = await client.getConfig();
      } catch {
        configDoc = null;
      }
      try {
        iface = await client.getInterface();
      } catch {
        iface = null;
      }
    }
    const instances = listInstances(configDoc).map((instance) => {
      const info = describeRunState(stateDoc, instance.id);
      return {
        id: instance.id,
        name: instance.name,
        controllerName: instance.controllerName,
        resourceName: instance.resourceName,
        connected: info.connected ?? false,
        running: info.running ?? false,
        overall: info.overall ?? null,
        currentTaskIndex: info.currentTaskIndex ?? null,
        taskCount: instance.tasks.length,
        tasks: instance.tasks.map((task) => ({
          id: task.id,
          taskName: task.taskName,
          label: describeTaskLabel(task),
          enabled: Boolean(task.enabled),
          special: String(task.taskName ?? '').startsWith('__MXU_'),
        })),
        schedules: instance.schedulePolicies.map((policy) => ({
          id: policy.id,
          name: policy.name,
          enabled: Boolean(policy.enabled),
          times: policy.times ?? [],
          weekdays: policy.weekdays ?? [],
        })),
      };
    });
    if (!state.selectedInstance || !instances.some((item) => item.id === state.selectedInstance)) {
      state.selectedInstance = instances[0]?.id ?? null;
    }
    let logs = [];
    if (reachable && logLimit > 0) {
      try {
        logs = summarizeLogs(await client.getLogs(), state.selectedInstance, logLimit);
      } catch {
        logs = [];
      }
    }
    let elevated = null;
    if (reachable) {
      try {
        elevated = Boolean((await client.isElevated())?.elevated);
      } catch {
        elevated = null;
      }
    }
    const install = await findInstall().catch(() => null);
    return {
      ok: reachable,
      reachable,
      error: stateError,
      baseUrl,
      elevated,
      hooks: { ...state.hooks },
      install: install ? { dir: install.dir, exe: install.exe, source: install.source } : null,
      selectedInstance: state.selectedInstance,
      instances,
      logs,
      lastRun: state.lastRun,
      interfaceVersion: iface?.version ?? null,
    };
  }

  function evaluateStatuses(statuses) {
    const entries = Object.entries(statuses ?? {});
    const failed = entries.filter(([, status]) => status !== 'succeeded').map(([taskId, status]) => ({ taskId, status }));
    return { total: entries.length, failed, failedCount: failed.length };
  }

  /**
   * Wait for the chain to settle, then (only when every started task reported
   * `Tasker.Task.Succeeded`) close the game. Success is decided from the WS
   * callbacks, never from task_run_state.statuses (which carries stale entries
   * from earlier runs and would fire the hook after a failed/aborted chain).
   */
  async function finalizeRun({ instanceId, taskIds, killGameOnFinish, processName }) {
    const ids = (taskIds ?? []).map(String);
    let watched;
    try {
      watched = await watchRunEvents({ taskIds: ids, baseUrl: client.baseUrl });
    } catch (error) {
      watched = { complete: false, reason: String(error?.message ?? error), results: {} };
    }
    const waited = await waitForIdle(client, instanceId, { timeoutMs: 60 * 1000 }).catch((error) => ({
      ok: false,
      reason: String(error?.message ?? error),
      elapsedMs: 0,
    }));
    const evaluation = {
      total: ids.length,
      succeeded: ids.filter((id) => watched.results[id] === 'succeeded').length,
      failed: ids.filter((id) => watched.results[id] !== 'succeeded').map((id) => ({ taskId: id, status: watched.results[id] ?? 'missing' })),
      results: watched.results,
      complete: watched.complete,
      reason: watched.reason,
    };
    const allSucceeded = watched.complete && ids.length > 0 && evaluation.failed.length === 0;
    let kill = null;
    if (!killGameOnFinish) kill = { skipped: true, reason: 'killGameOnFinish 未开启' };
    else if (!allSucceeded) kill = { skipped: true, reason: '任务链未全部成功，跳过关游戏', evaluation };
    else {
      try {
        kill = await executeChain({ instanceId, extraTasks: [killGameTask(processName || 'Endfield.exe')] });
      } catch (error) {
        kill = { error: String(error?.message ?? error) };
      }
    }
    const summary = { waited: { ok: waited.ok, reason: waited.reason, elapsedMs: waited.elapsedMs }, evaluation, kill };
    state.lastRun = { ...(state.lastRun ?? {}), ...summary, finishedAt: new Date().toISOString() };
    return summary;
  }

  /**
   * MXU's tasker is bound to the game window: once the game restarts (new window
   * handle) the instance reports connected=false and tasks/start fails with
   * "Tasker not properly initialized". Reconnect first — that is what the MXU UI
   * does right before it starts a chain.
   */
  async function ensureConnected(instance, iface) {
    if (!String(instance.controllerName ?? '').includes('Win32')) return { connected: null, skipped: 'non-win32 controller' };
    const steps = [];
    let info = describeRunState(await client.getState(), instance.id);
    if (!info.connected) {
      const windows = await client.getWindows('UnityWndClass', 'Endfield');
      const win = (windows ?? [])[0];
      if (!win) {
        throw new MaendError('找不到 Endfield 游戏窗口：请先启动游戏（可在 MaaEnd 里跑一次「启动游戏」预任务，或手动打开）');
      }
      await client.connect(instance.id, { handle: win.handle });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      steps.push({ step: 'connect', handle: win.handle, windowTitle: win.window_name ?? null });
      info = describeRunState(await client.getState(), instance.id);
    }
    if (!info.resourceLoaded) {
      // MaaEnd restarted: the instance has no resource, tasks/start fails with "Resource not loaded".
      const envelope = await client.getInterfaceEnvelope().catch(() => null);
      const basePath = envelope?.basePath ?? (await requireInstall('解析资源目录')).dir;
      const resourceDef = (iface?.resource ?? []).find((item) => item.name === instance.resourceName);
      const declared = resourceDef?.path ?? './resource';
      const relative = Array.isArray(declared) ? declared[0] ?? './resource' : declared;
      const absolute = path.isAbsolute(relative) ? relative : path.resolve(basePath, relative);
      await client.loadResource(instance.id, [absolute]);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      steps.push({ step: 'resource/load', path: absolute });
      info = describeRunState(await client.getState(), instance.id);
    }
    // A previous run can leave its MaaFramework agent behind; the next spawn then
    // fails with "Agent start failed: MaaFramework internal error: status 0".
    if (!info.running) {
      try {
        await client.stopAgent(instance.id);
        await new Promise((resolve) => setTimeout(resolve, 400));
        steps.push({ step: 'agent/stop' });
      } catch {
        /* best effort */
      }
    }
    return { connected: info.connected, resourceLoaded: info.resourceLoaded, steps };
  }

  async function startRun({ instanceId, taskNames, hooks, wait = false, includePretask = false }) {
    const configDoc = await client.getConfig();
    const instances = listInstances(configDoc);
    const instance = pickInstance(instances, instanceId, state.selectedInstance);
    if (!instance) throw new MaendError(`找不到实例: ${instanceId ?? state.selectedInstance ?? '(none)'}`);
    const iface = await client.getInterface();
    const connection = await ensureConnected(instance, iface);
    const mergedHooks = { ...state.hooks, ...(hooks ?? {}) };
    const built = buildChain({
      instance,
      iface,
      taskNames,
      hooks: mergedHooks,
      controllerName: instance.controllerName,
      resourceName: instance.resourceName,
      includePretask,
    });
    if (built.chain.length === 0) throw new MaendError('任务链为空：没有启用的任务或选择的任务都不存在');
    const controllerDef = (iface.controller ?? []).find((item) => item.name === instance.controllerName);
    const response = await client.startTasks(instance.id, built.chain, {
      cwd: config.cwd ?? (await findInstall())?.dir ?? '',
      controllerInfo: { name: instance.controllerName, type: controllerDef?.type ?? 'Win32' },
      controllerName: instance.controllerName,
      resourceName: instance.resourceName,
      language: configDoc?.settings?.language ?? 'zh-CN',
      interfaceSnapshot: iface,
    });
    const taskIds = response?.taskIds ?? [];
    state.selectedInstance = instance.id;
    state.lastRun = { instanceId: instance.id, startedAt: new Date().toISOString(), taskIds, count: built.chain.length };
    const followUp = {
      killGameOnFinish: Boolean(mergedHooks.killGameOnFinish),
      processName: mergedHooks.processName,
    };
    let waited = null;
    if (wait) waited = await finalizeRun({ instanceId: instance.id, taskIds, ...followUp });
    else {
      // keep the promise alive so the game still gets closed after a successful run
      void finalizeRun({ instanceId: instance.id, taskIds, ...followUp }).catch(() => {});
    }
    return {
      ok: true,
      instance: { id: instance.id, name: instance.name },
      connection,
      taskIds,
      chain: built.chain.map((item) => ({ entry: item.entry, taskName: item.task_name })),
      warnings: built.warnings,
      killAfterRun: built.killAfterRun,
      waited,
    };
  }

  async function toggleTask({ instanceId, taskId, enabled }) {
    const before = await client.getConfig();
    const instance = pickInstance(listInstances(before), instanceId, state.selectedInstance);
    if (!instance) throw new MaendError(`找不到实例: ${instanceId ?? state.selectedInstance ?? '(none)'}`);
    const configInstance = (before.instances ?? []).find((item) => item.id === instance.id);
    if (!configInstance) throw new MaendError(`配置里找不到实例: ${instance.id}`);
    const target = (configInstance.tasks ?? []).find((item) => item.id === taskId);
    if (!target) throw new MaendError(`找不到任务: ${taskId}`);
    target.enabled = Boolean(enabled);
    await client.putConfig(before);
    const after = await client.getConfig();
    const persisted = (after.instances ?? []).find((item) => item.id === instance.id)?.tasks?.find((item) => item.id === taskId);
    return { ok: Boolean(persisted?.enabled === Boolean(enabled)), instanceId: instance.id, taskId, enabled: Boolean(persisted?.enabled) };
  }

  async function setHooks(patch) {
    const next = { ...state.hooks };
    for (const key of ['muteOnStart', 'unmuteOnFinish', 'killGameOnFinish', 'webhookUrl', 'processName']) {
      if (key in (patch ?? {}) && patch[key] !== undefined) next[key] = patch[key];
    }
    state.hooks = next;
    saveHooks(next);
    return { ...next };
  }

  async function executeChain({ instanceId, extraTasks }) {
    const configDoc = await client.getConfig();
    const instance = pickInstance(listInstances(configDoc), instanceId, state.selectedInstance);
    if (!instance) throw new MaendError('没有任何 MXU 实例');
    const iface = await client.getInterface();
    const controllerDef = (iface.controller ?? []).find((item) => item.name === instance.controllerName);
    const response = await client.startTasks(instance.id, extraTasks, {
      cwd: config.cwd ?? (await findInstall())?.dir ?? '',
      controllerInfo: { name: instance.controllerName, type: controllerDef?.type ?? 'Win32' },
    });
    return { instanceId: instance.id, taskIds: response?.taskIds ?? [] };
  }

  async function screenshotDataUrl(instanceId) {
    const { buffer, contentType } = await client.screenshot(instanceId ?? state.selectedInstance);
    return { dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`, bytes: buffer.length };
  }

  async function launchClient({ instanceName, quitAfterRun = false, autostart = true }) {
    const install = await requireInstall('启动 MaaEnd.exe');
    const args = [];
    if (autostart) args.push('--autostart');
    if (instanceName) args.push('--instance', instanceName);
    if (quitAfterRun) args.push('--quit-after-run');
    const child = spawn(install.exe, args, { cwd: install.dir, detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, pid: child.pid ?? null, exe: install.exe, args, installSource: install.source };
  }

  /* ---------------------------------------------------------------- */
  /* tools                                                             */
  /* ---------------------------------------------------------------- */

  const statusTool = tool({
    name: 'maend_status',
    description: '读取 MaaEnd (MXU) 当前状态：实例列表、运行状态、任务、定时策略、hooks 与最近日志。只读。',
    parameters: {
      logs: { type: 'number', description: '返回最近多少条日志（默认 20，0 表示不返回）' },
    },
    async execute(args) {
      const snapshot = await readSnapshot({ logLimit: args?.logs ?? 20 });
      return snapshot;
    },
  });

  const runTool = tool({
    name: 'maend_run',
    description:
      '启动 MaaEnd 自动任务链。默认跑该实例所有已启用任务，并按 hooks 自动在这些任务前后插入「系统静音」与「结束后关闭游戏」。taskNames 为空表示全部启用任务。wait=true 会阻塞到任务链空闲（最长 30 分钟）。',
    parameters: {
      instance: { type: 'string', description: '实例 id 或 name（默认当前选中实例）' },
      taskNames: { type: 'array', items: { type: 'string' }, description: '只跑这些任务（taskName），省略=全部已启用任务' },
      muteOnStart: { type: 'boolean', description: '启动前静音（默认取 hooks）' },
      unmuteOnFinish: { type: 'boolean', description: '结束后取消静音（默认取 hooks）' },
      killGameOnFinish: { type: 'boolean', description: '结束后关闭游戏进程（默认取 hooks）' },
      webhookUrl: { type: 'string', description: '任务链末尾的 webhook（默认取 hooks，空=不发）' },
      wait: { type: 'boolean', description: '是否等待任务链结束' },
    },
    timeoutMs: 40 * 60 * 1000,
    async execute(args) {
      const overrides = {};
      for (const key of ['muteOnStart', 'unmuteOnFinish', 'killGameOnFinish', 'webhookUrl']) {
        if (args?.[key] !== undefined) overrides[key] = args[key];
      }
      return startRun({ instanceId: args?.instance, taskNames: args?.taskNames, hooks: overrides, wait: Boolean(args?.wait) });
    },
  });

  const stopTool = tool({
    name: 'maend_stop',
    description: '停止 MaaEnd 当前正在运行的任务链（POST tasks/stop）。',
    parameters: { instance: { type: 'string', description: '实例 id（默认当前选中实例）' } },
    async execute(args) {
      const result = await client.stopTasks(args?.instance ?? state.selectedInstance);
      return { ok: true, result };
    },
  });

  const logsTool = tool({
    name: 'maend_logs',
    description: '读取 MaaEnd 日志（默认当前实例最近 50 条）。',
    parameters: {
      instance: { type: 'string', description: '实例 id（默认当前选中实例）' },
      limit: { type: 'number', description: '条数（默认 50，最多 500）' },
    },
    async execute(args) {
      const limit = Math.min(Math.max(args?.limit ?? 50, 1), 500);
      const doc = await client.getLogs();
      return { instanceId: args?.instance ?? state.selectedInstance, entries: summarizeLogs(doc, args?.instance ?? state.selectedInstance, limit) };
    },
  });

  const screenshotTool = tool({
    name: 'maend_screenshot',
    description: '抓取 MaaEnd 当前游戏画面（PNG），保存到临时目录并返回路径与尺寸。',
    parameters: { instance: { type: 'string', description: '实例 id（默认当前选中实例）' } },
    timeoutMs: 60 * 1000,
    async execute(args) {
      const { buffer } = await client.screenshot(args?.instance ?? state.selectedInstance);
      const dir = path.join(os.tmpdir(), 'dsh-maend');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `screenshot-${Date.now()}.png`);
      fs.writeFileSync(file, buffer);
      return { ok: true, path: file, bytes: buffer.length };
    },
  });

  const powerTool = tool({
    name: 'maend_power',
    description:
      '调用 MXU 内置系统操作。允许: mute / unmute / screenoff（直接执行）；shutdown / restart / sleep / hibernate 必须先传 confirm=true。',
    parameters: {
      action: { type: 'string', required: true, enum: ['mute', 'unmute', 'screenoff', 'shutdown', 'restart', 'sleep', 'hibernate'] },
      confirm: { type: 'boolean', description: '危险动作（关机/重启/休眠）必须为 true' },
    },
    async execute(args) {
      const dangerous = ['shutdown', 'restart', 'sleep', 'hibernate'].includes(args.action);
      if (dangerous && args.confirm !== true) {
        return { ok: false, blocked: true, reason: `${args.action} 属于危险系统动作，需要 confirm=true` };
      }
      const result = await executeChain({
        extraTasks: [
          {
            entry: 'MXU_POWER',
            pipeline_override: JSON.stringify([
              { MXU_POWER: { action: 'Custom', custom_action: 'MXU_POWER_ACTION', target: [0, 0, 1, 1], custom_action_param: { power_action: args.action } } },
            ]),
            selected_task_id: null,
            task_name: 'MXU_POWER',
            options: {},
          },
        ],
      });
      return { ok: true, action: args.action, ...result };
    },
  });

  const killGameTool = tool({
    name: 'maend_kill_game',
    description: '通过 MXU_KILLPROC 关闭游戏进程。默认只允许 Endfield.exe；其它进程名需要 confirm=true。',
    parameters: {
      processName: { type: 'string', description: '进程名（默认 Endfield.exe）' },
      confirm: { type: 'boolean', description: '非 Endfield.exe 时必须为 true' },
    },
    async execute(args) {
      const name = args?.processName ?? 'Endfield.exe';
      if (name !== 'Endfield.exe' && args?.confirm !== true) {
        return { ok: false, blocked: true, reason: `只允许 Endfield.exe；其它进程需要 confirm=true（收到 ${name}）` };
      }
      const result = await executeChain({
        extraTasks: [
          {
            entry: 'MXU_KILLPROC',
            pipeline_override: JSON.stringify([
              { MXU_KILLPROC: { action: 'Custom', custom_action: 'MXU_KILLPROC_ACTION', target: [0, 0, 1, 1], custom_action_param: { kill_self: false, process_name: name } } },
            ]),
            selected_task_id: null,
            task_name: 'MXU_KILLPROC',
            options: {},
          },
        ],
      });
      return { ok: true, processName: name, ...result };
    },
  });

  const hooksTool = tool({
    name: 'maend_hooks',
    description: '读取或修改插件 hooks：启动静音 / 结束取消静音 / 结束关游戏 / webhook / 进程名。',
    parameters: {
      muteOnStart: { type: 'boolean' },
      unmuteOnFinish: { type: 'boolean' },
      killGameOnFinish: { type: 'boolean' },
      webhookUrl: { type: 'string' },
      processName: { type: 'string' },
    },
    async execute(args) {
      if (!args || Object.keys(args).length === 0) return { ...state.hooks };
      return setHooks(args);
    },
  });

  const taskToggleTool = tool({
    name: 'maend_task_toggle',
    description: '开关某个实例里的任务（写回 MXU 配置并回读校验）。先用 maend_status 拿 taskId。',
    parameters: {
      instance: { type: 'string', description: '实例 id（默认当前选中实例）' },
      taskId: { type: 'string', required: true, description: '任务 id（maend_status 里的 tasks[].id）' },
      enabled: { type: 'boolean', required: true },
    },
    async execute(args) {
      return toggleTask({ instanceId: args?.instance, taskId: args.taskId, enabled: Boolean(args.enabled) });
    },
  });

  const launchTool = tool({
    name: 'maend_launch',
    description:
      '启动 MaaEnd.exe 客户端本身（带 --autostart / --instance <实例名> / --quit-after-run），用于 MXU 未运行时拉起。注意 --quit-after-run 只退出 MaaEnd，不会关闭游戏。',
    parameters: {
      instanceName: { type: 'string', description: '实例名（MXU 配置里的 name，例如 全套日常）' },
      quitAfterRun: { type: 'boolean', description: '跑完后退出 MaaEnd 客户端' },
    },
    async execute(args) {
      return launchClient({ instanceName: args?.instanceName, quitAfterRun: Boolean(args?.quitAfterRun) });
    },
  });

  for (const definition of [statusTool, runTool, stopTool, logsTool, screenshotTool, powerTool, killGameTool, hooksTool, taskToggleTool, launchTool]) {
    ctx.tools.register(definition);
  }

  /* ---------------------------------------------------------------- */
  /* dashboard HTTP routes (authenticated by the harness connection)    */
  /* ---------------------------------------------------------------- */

  const registerRoute = (route) => {
    if (typeof ctx.connection?.fetch?.register !== 'function') return undefined;
    return ctx.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      fetch: route.fetch,
    });
  };

  const disposers = [
    registerRoute({
      path: '/api/dsh-maend/status',
      methods: ['GET'],
      fetch: async (request) => {
        const url = new URL(request.url);
        const logLimit = Number(url.searchParams.get('logs') ?? 40);
        try {
          return json(await readSnapshot({ logLimit: Number.isFinite(logLimit) ? logLimit : 40 }));
        } catch (error) {
          return fail(error);
        }
      },
    }),
    registerRoute({
      path: '/api/dsh-maend/action',
      methods: ['POST'],
      fetch: async (request) => {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: 'body is not JSON' }, { status: 400 });
        }
        try {
          const result = await dispatchAction(body ?? {});
          return json(result);
        } catch (error) {
          return fail(error);
        }
      },
    }),
    registerRoute({
      path: '/api/dsh-maend/screenshot',
      methods: ['GET'],
      fetch: async (request) => {
        const url = new URL(request.url);
        const instanceId = url.searchParams.get('instance') ?? state.selectedInstance;
        try {
          const { buffer, contentType } = await client.screenshot(instanceId);
          return new Response(buffer, { headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
        } catch (error) {
          return fail(error, 502);
        }
      },
    }),
  ];

  async function dispatchAction(body) {
    const op = String(body.op ?? '');
    switch (op) {
      case 'select': {
        state.selectedInstance = body.instanceId ?? null;
        return { ok: true, result: { selectedInstance: state.selectedInstance } };
      }
      case 'run':
        return {
          ok: true,
          result: await startRun({
            instanceId: body.instanceId,
            taskNames: body.taskNames,
            hooks: body.hooks,
            wait: Boolean(body.wait),
          }),
        };
      case 'stop': {
        const result = await client.stopTasks(body.instanceId ?? state.selectedInstance);
        return { ok: true, result };
      }
      case 'toggleTask':
        return { ok: true, result: await toggleTask({ instanceId: body.instanceId, taskId: body.taskId, enabled: body.enabled }) };
      case 'setHooks':
        return { ok: true, result: await setHooks(body) };
      case 'mute':
      case 'unmute': {
        const task = op === 'mute' ? muteTask() : unmuteTask();
        return { ok: true, result: await executeChain({ instanceId: body.instanceId, extraTasks: [task] }) };
      }
      case 'killGame': {
        const processName = body.processName ?? state.hooks.processName ?? 'Endfield.exe';
        if (processName !== 'Endfield.exe') throw new MaendError('只允许 Endfield.exe');
        return {
          ok: true,
          result: await executeChain({
            instanceId: body.instanceId,
            extraTasks: [
              {
                entry: 'MXU_KILLPROC',
                pipeline_override: JSON.stringify([
                  { MXU_KILLPROC: { action: 'Custom', custom_action: 'MXU_KILLPROC_ACTION', target: [0, 0, 1, 1], custom_action_param: { kill_self: false, process_name: processName } } },
                ]),
                selected_task_id: null,
                task_name: 'MXU_KILLPROC',
                options: {},
              },
            ],
          }),
        };
      }
      case 'screenshot':
        return { ok: true, result: await screenshotDataUrl(body.instanceId) };
      case 'sleep': {
        const seconds = Math.min(Math.max(Number(body.seconds ?? 5), 1), 3600);
        return { ok: true, result: await executeChain({ instanceId: body.instanceId, extraTasks: [sleepTask(seconds)] }) };
      }
      default:
        return { ok: false, error: `unknown op: ${op || '(empty)'}` };
    }
  }

  for (const dispose of disposers) {
    if (typeof dispose === 'function') ctx.effect(() => dispose, 'dsh-maend routes');
  }

  ctx.logger?.info?.(`dsh-maend ready (base ${client.baseUrl})`);
  return () => {
    /* ctx.dispose handles registered effects/tools */
  };
}
