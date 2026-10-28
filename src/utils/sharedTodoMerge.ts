import type { PrivateSpaceTask, SharedTodoContent } from "@/db/dexie";

function sameTask(left: PrivateSpaceTask | undefined, right: PrivateSpaceTask | undefined) {
  return !!left && !!right && left.text === right.text && left.done === right.done
    && Number(left.due || 0) === Number(right.due || 0);
}

export function sameSharedTodoContent(left: SharedTodoContent, right: SharedTodoContent) {
  return left.title === right.title && left.tasks.length === right.tasks.length
    && left.tasks.every((task, index) => task.id === right.tasks[index].id && sameTask(task, right.tasks[index]));
}

/**
 * Three-way merge of a shared list, per task: a side that changed a task
 * (relative to `base`) wins; an edit beats a concurrent delete; tasks added on
 * either side are kept. When both sides changed the same task, local wins
 * because it is what this user is looking at. Remote order is kept and local
 * additions follow the task they were added after.
 */
export function mergeSharedTodo(base: SharedTodoContent, local: SharedTodoContent, remote: SharedTodoContent): SharedTodoContent {
  const baseTasks = new Map(base.tasks.map(task => [task.id, task]));
  const localTasks = new Map(local.tasks.map(task => [task.id, task]));
  const remoteIds = new Set(remote.tasks.map(task => task.id));
  const merged: PrivateSpaceTask[] = [];
  for (const task of remote.tasks) {
    const mine = localTasks.get(task.id);
    const original = baseTasks.get(task.id);
    if (mine) merged.push(original && sameTask(mine, original) ? task : mine);
    // Deleted here: keep only if the other side edited it meanwhile.
    else if (!original || !sameTask(task, original)) merged.push(task);
  }
  local.tasks.forEach((task, index) => {
    if (remoteIds.has(task.id)) return;
    const original = baseTasks.get(task.id);
    // Deleted remotely and untouched here.
    if (original && sameTask(task, original)) return;
    let at = merged.length;
    for (let previous = index - 1; previous >= 0; previous--) {
      const anchor = merged.findIndex(item => item.id === local.tasks[previous].id);
      if (anchor >= 0) { at = anchor + 1; break; }
    }
    merged.splice(at, 0, task);
  });
  return {
    title: local.title !== base.title ? local.title : remote.title,
    tasks: merged.map(task => ({ ...task })),
  };
}
