/**
 * Insert MXU "special tasks" (mute / unmute, optionally the unconditional kill) into
 * an instance's task list, so MaaEnd's own UI shows them and can reorder them.
 *
 *   node scripts/add-special-tasks.mjs --instance <id|name> [--dry] [--kill]
 *
 * Default layout:
 *   ...__MXU_PRETASK__* -> __MXU_POWER__(mute) -> existing tasks -> __MXU_POWER__(unmute)
 *
 * `--kill` additionally inserts __MXU_KILLPROC__ before the trailing unmute. That task
 * closes the game unconditionally — MXU chains are fail-forward, so it also closes the
 * game after a failed run. The plugin's own hook (see README) is the safer option.
 */

const BASE = process.env.MAEND_BASE || 'http://127.0.0.1:12701';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const DRY = flag('--dry');
const WANT_KILL = flag('--kill');
const wanted = value('--instance');

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const newId = () => Array.from({ length: 7 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

const powerEntry = (powerAction, customName) => ({
  id: newId(),
  taskName: '__MXU_POWER__',
  customName,
  enabled: true,
  optionValues: { __MXU_POWER_OPTION__: { type: 'select', caseName: powerAction } },
  expanded: true,
});

const killGameEntry = (processName) => ({
  id: newId(),
  taskName: '__MXU_KILLPROC__',
  customName: '结束后关闭游戏',
  enabled: true,
  optionValues: {
    __MXU_KILLPROC_SELF_OPTION__: { type: 'switch', value: false },
    __MXU_KILLPROC_NAME_OPTION__: { type: 'input', values: { process_name: processName } },
  },
  expanded: true,
});

const json = async (path, init) => {
  const response = await fetch(`${BASE}/api${path}`, init);
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${response.status} ${await response.text()}`);
  return response.json();
};

const config = await json('/config');
const instances = config.instances ?? [];
if (instances.length === 0) throw new Error('MXU has no instances yet — create one in MaaEnd first');

const instance = wanted
  ? instances.find((item) => item.id === wanted || item.name === wanted)
  : instances.length === 1
    ? instances[0]
    : null;
if (!instance) {
  throw new Error(
    `instance not specified. available: ${instances.map((item) => `${item.id}/${item.name}`).join(', ')}\n` +
      'pass --instance <id|name>',
  );
}

const tasks = [...(instance.tasks ?? [])];
const specials = tasks.filter((task) => String(task.taskName).startsWith('__MXU_'));
const hasPower = (action) =>
  specials.some((task) => task.enabled && task.taskName === '__MXU_POWER__' && task.optionValues?.__MXU_POWER_OPTION__?.caseName === action);
const hasKill = specials.some((task) => task.enabled && task.taskName === '__MXU_KILLPROC__');

console.log(`instance ${instance.id} (${instance.name}): tasks=${tasks.length}, specials=${specials.length}`);

const plan = [];
if (!hasPower('mute')) plan.push({ where: 'head', task: powerEntry('mute', '启动后静音') });
if (WANT_KILL && !hasKill) plan.push({ where: 'tail-before-unmute', task: killGameEntry('Endfield.exe') });
if (!hasPower('unmute')) plan.push({ where: 'tail', task: powerEntry('unmute', '结束后取消静音') });

if (plan.length === 0) {
  console.log('nothing to do: the requested special tasks are already present');
  process.exit(0);
}

// pretask block = leading __MXU_PRETASK__* entries; mute belongs right after it
let headEnd = 0;
while (headEnd < tasks.length && String(tasks[headEnd].taskName).startsWith('__MXU_PRETASK__')) headEnd += 1;

for (const op of plan) {
  if (op.where === 'head') tasks.splice(headEnd, 0, op.task);
  else if (op.where === 'tail-before-unmute') tasks.push(op.task);
  else tasks.push(op.task);
}

// keep the trailing unmute last
const unmuteTask = tasks.find((task) => task.optionValues?.__MXU_POWER_OPTION__?.caseName === 'unmute');
if (unmuteTask) {
  const index = tasks.indexOf(unmuteTask);
  if (index !== tasks.length - 1) {
    tasks.splice(index, 1);
    tasks.push(unmuteTask);
  }
}

instance.tasks = tasks;
console.log('\nresulting order:');
tasks.forEach((task, index) => {
  const name = task.customName || task.taskName;
  console.log(`  ${String(index).padStart(2, '0')} ${name}${task.enabled === false ? ' (disabled)' : ''}`);
});

if (DRY) {
  console.log('\n[dry-run] nothing written; re-run without --dry to apply');
  process.exit(0);
}

const put = await fetch(`${BASE}/api/config`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(config),
});
console.log(`\nPUT /api/config -> ${put.status} ${await put.text()}`);
if (!put.ok) throw new Error('config write rejected');

const after = await json('/config');
const saved = after.instances.find((item) => item.id === instance.id);
const savedSpecials = (saved.tasks ?? []).filter((task) => String(task.taskName).startsWith('__MXU_'));
console.log(`readback: tasks=${saved.tasks.length}, specials=${savedSpecials.length}`);
for (const task of savedSpecials) console.log(`  ${task.customName || task.taskName} enabled=${task.enabled} id=${task.id}`);
