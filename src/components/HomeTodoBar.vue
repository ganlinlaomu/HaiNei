<template>
  <section v-if="visibleTasks.length || recentlyDone.length" class="todo-bar" aria-label="待办">
    <button class="todo-head" type="button" :aria-expanded="expanded" @click="toggleExpanded">
      <span class="todo-icon" aria-hidden="true">☑</span>
      <span class="todo-summary"><strong>待办 {{ tasks.length }} 项</strong><span v-if="overdueCount" class="due-chip">{{ overdueCount }} 项逾期</span></span>
      <span class="chevron">{{ expanded ? "收起 ▴" : "展开 ▾" }}</span>
    </button>
    <button v-if="!expanded && first" class="todo-peek" type="button" @click="openTask(first)">
      <span v-if="first.pinned" aria-label="已置顶">📌 </span>{{ first.text }}<span v-if="first.due" class="peek-list" :class="{ overdue: dueOf(first).overdue }"> · {{ dueOf(first).label }}</span><span v-else-if="first.listTitle" class="peek-list"> · {{ first.listTitle }}</span>
    </button>

    <template v-if="expanded">
      <ul class="todo-list">
        <li v-for="task in shownTasks" :key="task.taskId" :class="{ done: isDone(task) }">
          <input type="checkbox" :checked="isDone(task)" :disabled="saving === task.taskId"
            :aria-label="`${isDone(task) ? '取消完成' : '完成'}：${task.text}`" @change="toggle(task)" />
          <button class="todo-item" type="button" @click="openTask(task)">
            <span class="todo-text">{{ task.text }}</span>
            <span v-if="task.pinned || task.listTitle || task.due" class="todo-meta"><span v-if="task.pinned">📌</span><span v-if="task.due" :class="{ overdue: dueOf(task).overdue }">{{ dueOf(task).label }}{{ dueOf(task).overdue ? ' · 已逾期' : '' }}</span><span v-if="task.listTitle">{{ task.due ? ' · ' : '' }}{{ task.listTitle }}</span></span>
          </button>
        </li>
      </ul>
      <div class="todo-foot">
        <button type="button" class="link" @click="ui.openPostEditor('todo')">＋ 新待办</button>
        <button type="button" class="link" @click="openAll">{{ hiddenCount ? `还有 ${hiddenCount} 项 · 全部待办 ›` : "全部待办 ›" }}</button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { deviceStorage } from "@/services/deviceStorage";
import type { OpenTodoTask } from "@/services/privateFeed";
import { describeDue } from "@/utils/todoPlanning";

const MAX_SHOWN = 5;
// A ticked task stays (struck through) briefly so the tap has visible effect
// and can be undone before it leaves the list.
const DONE_LINGER_MS = 2_500;
const EXPANDED_KEY = "hainei_todo_bar_expanded";

const props = defineProps<{ tasks: OpenTodoTask[] }>();
const keys = useKeyStore();
const ui = useUIStore();
const router = useRouter();

const expanded = ref(readExpanded());
const saving = ref("");
const recentlyDone = ref<OpenTodoTask[]>([]);
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>();

function readExpanded() {
  try { return deviceStorage.getItem(EXPANDED_KEY) === "1"; } catch { return false; }
}

const visibleTasks = computed(() => props.tasks.filter(task => !recentlyDone.value.some(done => done.taskId === task.taskId)));
const first = computed(() => visibleTasks.value[0]);
const shownTasks = computed(() => [...visibleTasks.value.slice(0, MAX_SHOWN), ...recentlyDone.value]);
const hiddenCount = computed(() => Math.max(0, visibleTasks.value.length - MAX_SHOWN));
const dueOf = (task: OpenTodoTask) => describeDue(task.due!);
const overdueCount = computed(() => visibleTasks.value.filter(task => task.due && task.due < Date.now()).length);
const isDone = (task: OpenTodoTask) => recentlyDone.value.some(done => done.taskId === task.taskId);

function toggleExpanded() {
  expanded.value = !expanded.value;
  try { deviceStorage.setItem(EXPANDED_KEY, expanded.value ? "1" : "0"); } catch { /* per-session only */ }
}

function openTask(task: OpenTodoTask) {
  void router.push({ path: "/settings/private-space", query: { tab: "todo", open: task.recordId } });
}

function openAll() {
  void router.push({ path: "/settings/private-space", query: { tab: "todo" } });
}

async function setDone(task: OpenTodoTask, done: boolean) {
  const account = keys.pkHex;
  const [{ privateSpaceRepository }, { notePrivateSpaceMutation }] = await Promise.all([
    import("@/repositories/privateSpaceRepository"), import("@/services/privateSpaceSync"),
  ]);
  // Re-read so a change made elsewhere is not overwritten.
  const current = await privateSpaceRepository.get(account, task.recordId);
  if (!current || keys.pkHex !== account) return;
  const tasks = current.tasks.map(item => item.id === task.taskId ? { ...item, done } : item);
  await privateSpaceRepository.update(account, current.id, { tasks });
  notePrivateSpaceMutation(keys);
}

async function toggle(task: OpenTodoTask) {
  if (saving.value) return;
  const undo = isDone(task);
  saving.value = task.taskId;
  try {
    await setDone(task, !undo);
    clearTimeout(doneTimers.get(task.taskId));
    doneTimers.delete(task.taskId);
    if (undo) {
      recentlyDone.value = recentlyDone.value.filter(done => done.taskId !== task.taskId);
    } else {
      recentlyDone.value = [...recentlyDone.value, task];
      doneTimers.set(task.taskId, setTimeout(() => {
        doneTimers.delete(task.taskId);
        recentlyDone.value = recentlyDone.value.filter(done => done.taskId !== task.taskId);
      }, DONE_LINGER_MS));
    }
  } catch {
    ui.addToast("无法更新待办，请确认账号已解锁", 2_200, "error");
  } finally {
    saving.value = "";
  }
}

onBeforeUnmount(() => {
  for (const timer of doneTimers.values()) clearTimeout(timer);
});
</script>

<style scoped>
.todo-bar{background:var(--bg-fff);border-bottom:1px solid var(--bd-edf1f5)}
.todo-head{display:flex;width:100%;align-items:center;gap:8px;padding:10px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.todo-icon{display:grid;width:22px;height:22px;place-items:center;border-radius:6px;background:var(--bg-f1f5f9);font-size:13px}
.todo-summary{flex:1;color:var(--fg-202938);font-size:14px}
.todo-summary strong{color:var(--fg-0f1419)}
.chevron{color:var(--fg-8b98a5);font-size:12px}
.todo-peek{display:block;width:100%;margin-top:-6px;padding:0 16px 10px 46px;overflow:hidden;border:0;background:transparent;color:var(--fg-64748b);font:inherit;font-size:13px;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.peek-list{color:var(--fg-8b98a5)}
.overdue{color:#e5484d!important}
.due-chip{margin-left:6px;padding:1px 7px;border-radius:999px;background:rgba(229,72,77,.12);color:#e5484d;font-size:12px}
.todo-list{margin:0;padding:0 16px;list-style:none}
.todo-list li{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-top:1px solid var(--bd-edf1f5)}
.todo-list input{width:18px;height:18px;flex:0 0 18px;margin:2px 0 0;accent-color:#1d9bf0}
.todo-item{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.todo-text{color:var(--fg-202938);font-size:15px;line-height:1.45;overflow-wrap:anywhere}
.todo-meta{display:flex;gap:4px;color:var(--fg-8b98a5);font-size:12px}
.done .todo-text{color:var(--fg-8b98a5);text-decoration:line-through}
.todo-foot{display:flex;justify-content:space-between;gap:12px;padding:6px 16px 10px}
.link{min-height:32px;padding:0;border:0;background:transparent;color:var(--fg-2563eb);font:inherit;font-size:13px;cursor:pointer}
</style>
