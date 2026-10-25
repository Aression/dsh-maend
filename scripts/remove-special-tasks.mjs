/**
 * Remove special tasks (__MXU_*) from an instance's task list.
 *
 *   node scripts/remove-special-tasks.mjs --instance <id|name> [--dry] [--task __MXU_KILLPROC__]
 *
 * Without `--task` every special task is removed (mute / unmute / kill / webhook / ...).
 * Useful to drop the unconditional "结束后关闭游戏" entry: MXU chains are fail-forward, so
 * that task closes the game even when the run failed. The plugin's own close hook is
 * success-gated and runs outside the chain.
 */

const BASE = process.env.MAEND_BASE || 'http://127.0.0.1:12701';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const DRY = flag('--dry');
const wanted = value('--instance');
const onlyTask = value('--task');

const config = await (await fetch(`${BASE}/api/config`)).json();
const instances = config.instances ?? [];
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

const before = instance.tasks ?? [];
const isTarget = (task) => {
  const name = String(task.taskName ?? '');
  if (!name.startsWith('__MXU_')) return false;
  if (onlyTask) return name === onlyTask;
  return true;
};
const removed = before.filter(isTarget);
if (removed.length === 0) {
  console.log(`nothing to remove on ${instance.id} (${instance.name})`);
  process.exit(0);
}

instance.tasks = before.filter((task) => !isTarget(task));
console.log(`instance ${instance.id} (${instance.name}): ${before.length} -> ${instance.tasks.length} tasks`);
for (const task of removed) console.log(`  - ${task.customName || task.taskName} (${task.id})`);

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

const after = await (await fetch(`${BASE}/api/config`)).json();
const saved = after.instances.find((item) => item.id === instance.id);
const left = (saved.tasks ?? []).filter((task) => String(task.taskName).startsWith('__MXU_'));
console.log(`readback: tasks=${saved.tasks.length}, specials left=${left.length}`);
