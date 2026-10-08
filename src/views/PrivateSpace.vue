<template>
  <main class="private-space-page app-page">
    <SecondaryPageHeader title="私人空间" back-label="返回我的" />
    <div class="privacy-line">🔒 仅当前账号可见 · 本机加密保存 · 云同步将在后续版本开放</div>
    <p v-if="error" role="alert" class="error-line">{{ error }}</p>
    <template v-if="!editor">
      <div class="toolbar">
        <input v-model="query" type="search" aria-label="搜索私人笔记" placeholder="搜索笔记和待办" />
        <button type="button" class="primary" @click="create('note')">＋ 笔记</button>
        <button type="button" class="primary secondary" @click="create('todo')">＋ 待办</button>
      </div>
      <div class="tabs" role="group" aria-label="笔记分类">
        <button v-for="tab in tabs" :key="tab.value" type="button" :class="{ selected: filter === tab.value }"
          :aria-pressed="filter === tab.value" @click="filter = tab.value">{{ tab.label }}</button>
      </div>
      <p v-if="loading" class="empty-state">正在读取本地笔记…</p>
      <div v-else-if="!filtered.length" class="empty-state">这里还没有内容。可以新建一条笔记或待办。</div>
      <ul v-else class="items">
        <li v-for="note in filtered" :key="note.id">
          <button type="button" class="item" @click="open(note)">
            <span class="item-top"><strong>{{ label(note) }}</strong><span v-if="note.pinned">📌</span></span>
            <span class="preview">{{ note.kind === 'todo' ? progress(note) : note.body || '空白笔记' }}</span>
            <span class="date">{{ note.kind === 'todo' ? '待办' : '笔记' }} · {{ formatted(note.updatedAt) }}</span>
          </button>
        </li>
      </ul>
    </template>
    <section v-else class="editor">
      <div class="editor-actions">
        <button type="button" @click="closeEditor">‹ 返回列表</button>
        <span class="save-state" aria-live="polite">{{ saveStatus }}</span>
        <button type="button" @click="togglePin">{{ editor.pinned ? '取消置顶' : '置顶' }}</button>
      </div>
      <input v-model="editor.title" class="title-input" aria-label="笔记标题"
        placeholder="标题（可不填）" maxlength="500" @input="queueSave" />
      <template v-if="editor.kind === 'note'">
        <textarea v-model="editor.body" aria-label="笔记内容" class="body-input"
          placeholder="开始记录…" rows="10" maxlength="100000" @input="queueSave"></textarea>
      </template>
      <template v-else>
        <div class="tasks">
          <label v-for="(task, index) in editor.tasks" :key="task.id" class="task">
            <input type="checkbox" v-model="task.done" @change="queueSave" />
            <input type="text" v-model="task.text" maxlength="2000" aria-label="待办内容"
              :class="{ done: task.done }" placeholder="待办事项" @input="queueSave" />
            <button type="button" :aria-label="'删除第 ' + (index + 1) + ' 项'"
              @click.prevent="removeTask(index)">×</button>
          </label>
          <div class="add-task">
            <input v-model="newTaskText" type="text" maxlength="2000" placeholder="添加待办事项"
              aria-label="新的待办事项" @keydown.enter.prevent="addTask" />
            <button type="button" @click="addTask">添加</button>
          </div>
          <p class="task-counter">{{ progress(editor) }}</p>
        </div>
      </template>
      <footer class="editor-footer">
        <button type="button" @click="archiveNote">归档</button>
        <button type="button" class="delete-button" @click="deleteNote">移到最近删除</button>
      </footer>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import { useKeyStore } from "@/stores/keys";
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { privateSpaceRepository, type PrivateSpaceDraft } from "@/repositories/privateSpaceRepository";
import type { PrivateSpaceRecord } from "@/db/dexie";

const keys = useKeyStore();
const notes = ref<PrivateSpaceRecord[]>([]);
const editor = ref<PrivateSpaceRecord | null>(null);
const query = ref("");
const filter = ref<"all" | "note" | "todo">("all");
const loading = ref(false);
const error = ref("");
const saveStatus = ref("已保存在本机");
const newTaskText = ref("");
const tabs = [
  { value: "all", label: "全部" }, { value: "note", label: "笔记" }, { value: "todo", label: "待办" },
] as const;
let timer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<void> = Promise.resolve();
let loadVersion = 0;
let unsubscribeLock: (() => void) | undefined;

const filtered = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return notes.value
    .filter(note => !note.deletedAt && !note.archivedAt && (filter.value === "all" || note.kind === filter.value))
    .filter(note => !term || [note.title, note.body, ...note.tasks.map(task => task.text)]
      .some(value => value.toLocaleLowerCase().includes(term)));
});

function label(note: PrivateSpaceRecord) {
  return note.title.trim() || note.body.trim().split("\n")[0]?.slice(0, 60)
    || note.tasks.find(task => task.text.trim())?.text.trim() || "无标题";
}
function progress(note: PrivateSpaceRecord) {
  return note.tasks.filter(task => task.done).length + " / " + note.tasks.length + " 已完成";
}
function formatted(time: number) {
  return new Date(time).toLocaleDateString();
}
function handleError(cause: unknown) {
  error.value = cause instanceof Error ? "保存失败：" + cause.message : "本地保存失败，请重试";
  saveStatus.value = "保存失败";
}
function updateInList(record: PrivateSpaceRecord) {
  notes.value = [record, ...notes.value.filter(note => note.id !== record.id)]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}
async function loadForAccount(account: string) {
  const version = ++loadVersion;
  notes.value = [];
  editor.value = null;
  query.value = "";
  if (timer) clearTimeout(timer);
  timer = undefined;
  error.value = "";
  loading.value = !!account && keys.isUnlocked;
  if (!loading.value) return;
  try {
    const records = await privateSpaceRepository.list(account);
    if (version === loadVersion && keys.pkHex === account) notes.value = records;
  } catch (cause) {
    if (version === loadVersion) handleError(cause);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

watch(() => [keys.pkHex, keys.isUnlocked] as const, ([account, unlocked]) => {
  void loadForAccount(unlocked ? account : "");
}, { immediate: true });

function saveNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const current = editor.value;
  if (!current) return writes;
  const account = current.accountPubkey;
  const id = current.id;
  const version = loadVersion;
  const draft: PrivateSpaceDraft = {
    kind: current.kind, title: current.title, body: current.body,
    tasks: current.tasks.map(task => ({ ...task })), pinned: current.pinned,
  };
  saveStatus.value = "保存中…";
  const operation = writes.catch(() => undefined).then(async () => {
    if (loadVersion !== version || keys.pkHex !== account || !keys.isUnlocked) {
      throw new Error("account_changed");
    }
    const record = await privateSpaceRepository.save(account, id, draft);
    if (loadVersion === version && keys.pkHex === account) {
      updateInList(record);
      if (editor.value?.id === id && !timer) saveStatus.value = "已保存在本机";
    }
  });
  writes = operation;
  return operation;
}
function queueSave() {
  error.value = "";
  saveStatus.value = "尚未保存";
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void saveNow().catch(handleError); }, 350);
}
async function flush() {
  if (timer) return saveNow();
  return writes;
}
async function create(kind: "note" | "todo") {
  try {
    await flush();
    const account = keys.pkHex;
    if (!account || !keys.isUnlocked) return;
    const created = await privateSpaceRepository.create(account, kind);
    updateInList(created);
    editor.value = { ...created, tasks: [] };
    newTaskText.value = "";
    saveStatus.value = "已保存在本机";
    error.value = "";
  } catch (cause) { handleError(cause); }
}
async function open(note: PrivateSpaceRecord) {
  try {
    await flush();
    editor.value = { ...note, tasks: note.tasks.map(task => ({ ...task })) };
    newTaskText.value = "";
    saveStatus.value = "已保存在本机";
    error.value = "";
  } catch (cause) { handleError(cause); }
}
async function closeEditor() {
  try { await flush(); editor.value = null; }
  catch (cause) { handleError(cause); }
}
function addTask() {
  const value = newTaskText.value.trim();
  if (!editor.value || !value || editor.value.tasks.length >= 1000) return;
  editor.value.tasks.push({ id: crypto.randomUUID(), text: value, done: false });
  newTaskText.value = "";
  queueSave();
}
function removeTask(index: number) {
  editor.value?.tasks.splice(index, 1);
  queueSave();
}
function togglePin() {
  if (!editor.value) return;
  editor.value.pinned = !editor.value.pinned;
  queueSave();
}
async function archiveNote() {
  if (!editor.value) return;
  try {
    await flush();
    const note = editor.value;
    updateInList(await privateSpaceRepository.update(note.accountPubkey, note.id, { archivedAt: Date.now() }));
    editor.value = null;
  } catch (cause) { handleError(cause); }
}
async function deleteNote() {
  if (!editor.value) return;
  if (!window.confirm("移到最近删除？后续版本会提供恢复界面。")) return;
  try {
    await flush();
    const note = editor.value;
    updateInList(await privateSpaceRepository.moveToTrash(note.accountPubkey, note.id));
    editor.value = null;
  } catch (cause) { handleError(cause); }
}
function onVisibilityChange() {
  if (document.visibilityState === "hidden" && timer) void saveNow().catch(handleError);
}
onMounted(() => {
  unsubscribeLock = onBeforeAccountLock(async account => {
    if (editor.value?.accountPubkey === account) await flush();
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeRouteLeave(async () => {
  try { await flush(); } catch (cause) {
    handleError(cause);
    return false;
  }
});
onBeforeUnmount(() => {
  unsubscribeLock?.();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (timer) clearTimeout(timer);
});
</script>

<style scoped>
.private-space-page{min-height:100%;background:#fff;color:#172033;padding-bottom:calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px)}
.privacy-line{padding:12px 16px 6px;font-size:12px;color:#64748b}
.error-line{margin:8px 16px;padding:10px;border-radius:8px;background:#fef2f2;color:#b91c1c;font-size:13px}
.toolbar{display:flex;gap:8px;align-items:center;padding:14px 14px 10px}
.toolbar input{min-width:0;flex:1;border:1px solid #e2e8f0;border-radius:11px;padding:10px;font:inherit;font-size:14px}
button{font:inherit;cursor:pointer}
.primary{padding:10px;border:0;border-radius:11px;background:#172033;color:white;white-space:nowrap;font-size:13px}
.primary.secondary{background:#e9edf3;color:#172033}
.tabs{display:flex;gap:8px;padding:0 14px 12px;border-bottom:1px solid #f1f3f5}
.tabs button{flex:1;border:0;border-radius:9px;background:#f1f5f9;padding:10px 4px;color:#64748b;font-size:13px}
.tabs button.selected{color:#0f172a;background:#dfe8f4;font-weight:650}
.items{list-style:none;margin:0;padding:0 14px}
.items li{border-bottom:1px solid #edf0f2}
.item{width:100%;display:flex;flex-direction:column;gap:6px;border:0;background:#fff;text-align:left;padding:17px 4px}
.item-top{display:flex;justify-content:space-between;gap:8px}
.item-top strong{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.preview{font-size:13px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.date{font-size:11px;color:#94a3b8}
.empty-state{text-align:center;padding:65px 20px;color:#94a3b8;font-size:13px}
.editor{padding:14px}
.editor-actions{display:flex;align-items:center;justify-content:space-between;gap:4px}
.editor-actions button,.editor-footer button{border:0;background:transparent;color:#475569;padding:10px 3px;font-size:13px}
.save-state{font-size:11px;color:#64748b;white-space:nowrap}
.title-input{width:100%;margin-top:20px;padding:8px 2px;font-weight:650;font-size:21px;border:0;outline:none}
.body-input{width:100%;min-height:35vh;resize:vertical;border:0;outline:none;margin-top:16px;font:inherit;line-height:1.65;color:inherit}
.tasks{margin-top:24px}
.task{display:flex;align-items:center;gap:10px;min-height:48px;border-bottom:1px solid #f1f3f5}
.task input[type="checkbox"]{width:19px;height:19px;accent-color:#334155;flex:0 0 auto}
.task input[type="text"],.add-task input{min-width:0;flex:1;border:0;background:transparent;font:inherit;outline:none;padding:10px 0}
.task .done{text-decoration:line-through;color:#94a3b8}
.task button,.add-task button{border:0;background:transparent;color:#64748b;padding:8px}
.add-task{display:flex;gap:8px;margin-top:12px}
.task-counter{font-size:12px;color:#94a3b8}
.editor-footer{display:flex;justify-content:space-between;border-top:1px solid #edf0f2;margin-top:25px;padding-top:12px}
.editor-footer .delete-button{color:#be123c}
</style>
