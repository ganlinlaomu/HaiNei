<template>
  <main class="private-space-page app-page">
    <SecondaryPageHeader title="私人空间" back-label="返回我的" />
    <div class="privacy-line">🔒 本地与云端均加密 · 仅当前账号可访问</div>
    <div class="cloud-status" aria-live="polite">
      <span>{{ cloudStatusLabel }}</span>
      <button v-if="syncStatus.status === 'error' || syncStatus.status === 'offline'"
        type="button" @click="retrySync">重新同步</button>
    </div>
    <p v-if="error" role="alert" class="error-line">{{ error }}</p>
    <section v-if="backupOpen && !editor" class="backup-panel" aria-label="私人空间备份">
      <div class="backup-panel-header"><strong>备份与恢复</strong><button type="button" @click="closeBackupPanel">关闭</button></div>
      <p>加密备份包含当前账号的笔记、待办、归档和最近删除。密码只用于当前操作，不会上传或保存。</p>
      <label class="backup-label">备份密码（至少 12 个字符）
        <input v-model="backupPassword" type="password" autocomplete="new-password" placeholder="设置独立备份密码" :disabled="backupBusy" />
      </label>
      <label class="backup-label">再次输入备份密码
        <input v-model="backupConfirm" type="password" autocomplete="new-password" placeholder="确认备份密码" :disabled="backupBusy" />
      </label>
      <button class="backup-primary" type="button" :disabled="backupBusy" @click="downloadEncryptedBackup">
        {{ backupBusy ? '处理中…' : '导出加密备份（推荐）' }}
      </button>
      <div class="backup-divider"></div>
      <label class="backup-label">解密备份的密码
        <input v-model="restorePassword" type="password" autocomplete="off" placeholder="输入备份密码" :disabled="backupBusy" />
      </label>
      <input ref="restoreFileInput" class="backup-file-input" type="file" accept=".json,application/json"
        aria-label="选择海内私人空间加密备份" @change="selectEncryptedBackup" />
      <button type="button" :disabled="backupBusy" @click="restoreFileInput?.click()">选择加密备份文件</button>
      <p v-if="restoreFileName" class="backup-help">已选择：{{ restoreFileName }}</p>
      <button type="button" :disabled="backupBusy || !restoreFileContent || !restorePassword" @click="previewEncryptedBackup">
        {{ backupBusy ? '处理中…' : '解密并预览备份' }}
      </button>
      <section v-if="restorePreview" class="restore-preview" aria-live="polite">
        <strong>预览：{{ restorePreview.items.length }} 条笔记 / 待办</strong>
        <p>只恢复当前设备缺失的笔记；同 ID 的现有笔记会跳过，不覆盖正文、编辑或删除状态。不会导入其他账号。</p>
        <button class="backup-primary" type="button" :disabled="backupBusy" @click="confirmRestoreBackup">确认合并恢复</button>
        <button type="button" :disabled="backupBusy" @click="clearRestorePreview">取消恢复</button>
      </section>
      <div class="backup-divider"></div>
      <p><strong>明文导出</strong>（JSON / Markdown）</p>
      <p class="backup-help">明文文件不加密，任何获得文件的人都能读取。不会包含 Nostr 私钥。</p>
      <button type="button" :disabled="backupBusy" @click="downloadPlainBackup('json')">导出 JSON 明文</button>
      <button type="button" :disabled="backupBusy" @click="downloadPlainBackup('md')">导出 Markdown 明文</button>
    </section>
    <template v-if="!editor">
      <div class="toolbar">
        <input v-model="query" type="search" aria-label="搜索私人笔记" placeholder="搜索笔记和待办" />
        <button type="button" class="primary" :disabled="backupBusy" @click="create('note')">＋ 笔记</button>
        <button type="button" class="primary secondary" :disabled="backupBusy" @click="create('todo')">＋ 待办</button>
        <button type="button" class="more-action" :disabled="backupBusy" :aria-expanded="backupOpen" aria-label="备份与恢复"
          @click="backupOpen ? closeBackupPanel() : backupOpen = true">•••</button>
      </div>
      <div class="tabs" role="group" aria-label="笔记分类">
        <button v-for="tab in tabs" :key="tab.value" type="button" :class="{ selected: filter === tab.value }"
          :aria-pressed="filter === tab.value" @click="filter = tab.value">{{ tab.label }}</button>
      </div>
      <p v-if="loading" class="empty-state">正在读取本地笔记…</p>
      <div v-else-if="!filtered.length" class="empty-state">这里还没有内容。可以新建一条笔记或待办。</div>
      <ul v-else class="items">
        <li v-for="note in filtered" :key="note.id">
          <button type="button" class="item" :disabled="backupBusy || !!note.archivedAt || !!note.deletedAt" @click="open(note)">
            <span class="item-top"><strong>{{ label(note) }}</strong><span v-if="note.pinned">📌</span></span>
            <span class="preview">{{ note.kind === 'todo' ? progress(note) : note.body || '空白笔记' }}</span>
            <span class="date">{{ note.kind === 'todo' ? '待办' : '笔记' }} · {{ formatted(note.updatedAt) }}</span>
          </button>
          <button v-if="note.archivedAt || note.deletedAt" type="button" class="restore-button" @click="restoreNote(note)">恢复</button>
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
      <div v-if="activeSource" class="source-card">
        <strong>来源：{{ activeSource.kind === 'post' ? '海内动态' : '普通私信' }}</strong>
        <span>作者：{{ activeSource.author || '未知' }}</span>
        <span v-if="activeSource.date">时间：{{ sourceDateDisplay(activeSource.date) }}</span>
        <button type="button" @click="navigateToSource">查看原{{ activeSource.kind === 'post' ? '动态' : '私信' }} ↗</button>
        <small>来源信息属于加密笔记，原消息不存在时无法跳转。</small>
      </div>
      <footer class="editor-footer">
        <button type="button" @click="archiveNote">归档</button>
        <button type="button" class="delete-button" @click="deleteNote">移到最近删除</button>
      </footer>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import { useKeyStore } from "@/stores/keys";
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { privateSpaceRepository, type PrivateSpaceDraft } from "@/repositories/privateSpaceRepository";
import type { PrivateSpaceRecord } from "@/db/dexie";
import {
  encryptPrivateBackup, decryptPrivateBackup, exportPlainJson, exportPlainMarkdown,
  MAX_BACKUP_FILE_BYTES, type PrivateBackupPayload,
} from "@/services/privateSpaceBackup";
import { privateNoteSource } from "@/services/privateSpaceSource";
import {
  syncPrivateSpace, notePrivateSpaceMutation, getPrivateSpaceSyncState,
  subscribePrivateSpaceSync, setPrivateSpaceEditing, type PrivateSpaceSyncState,
} from "@/services/privateSpaceSync";

const keys = useKeyStore();
const route = useRoute();
const router = useRouter();
const backupOpen = ref(false);
const backupBusy = ref(false);
const backupPassword = ref("");
const backupConfirm = ref("");
const restorePassword = ref("");
const restoreFileInput = ref<HTMLInputElement | null>(null);
const restoreFileName = ref("");
const restoreFileContent = ref("");
const restorePreview = ref<PrivateBackupPayload | null>(null);
const activeSource = computed(() => editor.value ? privateNoteSource(editor.value) : null);
function sourceDateDisplay(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}
function navigateToSource() {
  const source = activeSource.value;
  if (!source || !editor.value || editor.value.accountPubkey !== keys.pkHex) return;
  if (source.kind === "post") void router.push({ path: "/", query: { mid: source.messageId } });
  else if (source.peerPubkey) void router.push({
    path: "/messages/" + source.peerPubkey, query: { focus: source.messageId },
  });
}
function clearRestorePreview() { restorePreview.value = null; }
function clearBackupSecrets() {
  backupOpen.value = false;
  backupPassword.value = ""; backupConfirm.value = "";
  restorePassword.value = "";
  restoreFileName.value = ""; restoreFileContent.value = "";
  clearRestorePreview();
  if (restoreFileInput.value) restoreFileInput.value.value = "";
}
function closeBackupPanel() {
  if (backupBusy.value) return;
  clearBackupSecrets();
}
function sessionSnapshot() {
  if (!keys.pkHex || !keys.isUnlocked) throw new Error("private_space_locked");
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  return { account, generation, isCurrent: () => keys.isUnlocked
    && keys.pkHex.toLowerCase() === account && keys.sessionGeneration === generation };
}
function throwIfStale(check: () => boolean) { if (!check()) throw new Error("account_changed"); }
function promptDownload(name: string, content: string, mime: string) {
  const file = new Blob([content], { type: mime });
  const url = URL.createObjectURL(file);
  try {
    const link = document.createElement("a");
    link.href = url; link.download = name;
    link.style.display = "none";
    document.body.append(link);
    link.click(); link.remove();
  } finally {
    // Delay revocation for iOS Safari / PWA to finish initiating the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
function backupFileName(suffix: string) {
  return "hainei-private-" + new Date().toISOString().slice(0, 10) + suffix;
}
function backupError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  const descriptions: Record<string, string> = {
    backup_password_length: "备份密码至少需要 12 个字符（最多 256 字节）",
    backup_password_or_integrity_failure: "密码不正确或备份文件已损坏",
    backup_account_or_version_mismatch: "该备份不属于当前账号，或文件版本不支持",
    backup_file_too_large: "备份文件太大",
    backup_too_large: "备份内容超出大小限制",
    account_changed: "账号状态发生变化，已取消操作",
    local_vault_locked: "私人空间未解锁",
  };
  error.value = descriptions[code] || ("备份操作失败：" + (code || "请重试"));
}
async function downloadEncryptedBackup() {
  if (backupBusy.value) return;
  error.value = "";
  if (backupPassword.value !== backupConfirm.value) {
    error.value = "两次输入的备份密码不一致"; return;
  }
  const password = backupPassword.value;
  backupBusy.value = true;
  try {
    await flush();
    const { account, isCurrent } = sessionSnapshot();
    const records = await privateSpaceRepository.list(account);
    throwIfStale(isCurrent);
    const output = await encryptPrivateBackup(account, records, password);
    throwIfStale(isCurrent);
    promptDownload(backupFileName(".hainei-backup.json"), output, "application/json");
    backupPassword.value = ""; backupConfirm.value = "";
    saveStatus.value = "已生成加密备份";
  } catch (cause) { backupError(cause); }
  finally { backupBusy.value = false; }
}
async function selectEncryptedBackup(event: Event) {
  clearRestorePreview();
  restoreFileContent.value = ""; restoreFileName.value = "";
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > MAX_BACKUP_FILE_BYTES) { error.value = "备份文件太大"; return; }
  const { isCurrent } = sessionSnapshot();
  const content = await file.text().catch(() => "");
  if (!isCurrent()) return;
  if (!content) { error.value = "无法读取备份文件"; return; }
  restoreFileName.value = file.name;
  restoreFileContent.value = content;
}
async function previewEncryptedBackup() {
  if (backupBusy.value || !restoreFileContent.value) return;
  backupBusy.value = true;
  error.value = ""; clearRestorePreview();
  try {
    await flush();
    const { account, isCurrent } = sessionSnapshot();
    const preview = await decryptPrivateBackup(restoreFileContent.value, account, restorePassword.value);
    throwIfStale(isCurrent);
    restorePreview.value = preview;
    restorePassword.value = "";
    restoreFileContent.value = "";
    if (restoreFileInput.value) restoreFileInput.value.value = "";
  } catch (cause) { backupError(cause); }
  finally { backupBusy.value = false; }
}
async function confirmRestoreBackup() {
  if (backupBusy.value || !restorePreview.value || editor.value) return;
  backupBusy.value = true;
  error.value = "";
  try {
    const { account, isCurrent } = sessionSnapshot();
    const preview = restorePreview.value;
    if (preview.accountPubkey !== account) throw new Error("backup_account_or_version_mismatch");
    setPrivateSpaceEditing(account, true);
    try {
      const outcome = await privateSpaceRepository.restoreBackup(account, preview.items, isCurrent);
      throwIfStale(isCurrent);
      if (outcome.added) notePrivateSpaceMutation(keys);
      notes.value = await privateSpaceRepository.list(account);
      throwIfStale(isCurrent);
      saveStatus.value = "已恢复 " + outcome.added + " 条 · 跳过 " + outcome.skipped + " 条";
      clearRestorePreview();
      restoreFileName.value = "";
      backupOpen.value = false;
    } finally {
      setPrivateSpaceEditing(account, false);
    }
  } catch (cause) { backupError(cause); }
  finally { backupBusy.value = false; }
}
async function downloadPlainBackup(format: "json" | "md") {
  if (backupBusy.value) return;
  if (!window.confirm("将生成未加密文件，其他人可直接读取全部笔记与待办。仍要导出吗？")) return;
  if (!window.confirm("再次确认：请勿将明文文件存放在公开位置。确定继续？")) return;
  backupBusy.value = true;
  error.value = "";
  try {
    await flush();
    const { account, isCurrent } = sessionSnapshot();
    const records = await privateSpaceRepository.list(account);
    throwIfStale(isCurrent);
    const content = format === "json" ? exportPlainJson(account, records) : exportPlainMarkdown(account, records);
    throwIfStale(isCurrent);
    promptDownload(backupFileName(format === "json" ? ".json" : ".md"),
      content, format === "json" ? "application/json" : "text/markdown");
  } catch (cause) { backupError(cause); }
  finally { backupBusy.value = false; }
}
const notes = ref<PrivateSpaceRecord[]>([]);
const editor = ref<PrivateSpaceRecord | null>(null);
const query = ref("");
const filter = ref<"all" | "note" | "todo" | "archived" | "trash">("all");
const loading = ref(false);
const error = ref("");
const saveStatus = ref("已保存在本机");
const newTaskText = ref("");
const syncStatus = ref<PrivateSpaceSyncState>(getPrivateSpaceSyncState(keys.pkHex.toLowerCase()));
const cloudStatusLabel = computed(() => {
  if (syncStatus.value.status === "synced") return syncStatus.value.conflicts
    ? "云端已同步 · 已保留 " + syncStatus.value.conflicts + " 条冲突副本"
    : "已加密同步至云端";
  if (syncStatus.value.status === "syncing") return "正在加密同步…";
  if (syncStatus.value.status === "error") return "云同步失败 · 内容已保存在本机：" + (syncStatus.value.error || "请重试");
  if (syncStatus.value.status === "offline") return "当前离线 · 内容仅保存在本机";
  if (syncStatus.value.status === "unavailable") return "当前登录方式不支持加密同步";
  return "已保存在本机 · 等待云同步";
});
function retrySync() { void syncPrivateSpace(keys); }
const tabs = [
  { value: "all", label: "全部" }, { value: "note", label: "笔记" }, { value: "todo", label: "待办" },
  { value: "archived", label: "归档" }, { value: "trash", label: "最近删除" },
] as const;
let timer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<void> = Promise.resolve();
let loadVersion = 0;
let unsubscribeLock: (() => void) | undefined;
let unsubscribeSync: (() => void) | undefined;

const filtered = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return notes.value
    .filter(note => filter.value === "trash" ? !!note.deletedAt
      : filter.value === "archived" ? !!note.archivedAt && !note.deletedAt
        : !note.deletedAt && !note.archivedAt && (filter.value === "all" || note.kind === filter.value))
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
  clearBackupSecrets();
  loading.value = !!account && keys.isUnlocked;
  if (!loading.value) return;
  try {
    const records = await privateSpaceRepository.list(account);
    if (version === loadVersion && keys.pkHex === account) {
      notes.value = records;
      syncStatus.value = getPrivateSpaceSyncState(account);
      void syncPrivateSpace(keys);
      const requested = route.query.new;
      if (requested === "note" || requested === "todo") {
        await create(requested);
        if (version === loadVersion && keys.pkHex === account) {
          void router.replace({ path: route.path, query: Object.fromEntries(
            Object.entries(route.query).filter(([name]) => name !== "new"),
          ) });
        }
      }
    }
  } catch (cause) {
    if (version === loadVersion) handleError(cause);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

watch(() => route.query.new, async requested => {
  if ((requested !== "note" && requested !== "todo") || !keys.isUnlocked || loading.value) return;
  await create(requested);
  void router.replace({ path: route.path, query: Object.fromEntries(
    Object.entries(route.query).filter(([name]) => name !== "new"),
  ) });
});

watch(() => editor.value?.accountPubkey || "", (account, previousAccount) => {
  if (previousAccount) setPrivateSpaceEditing(previousAccount, false);
  if (account) setPrivateSpaceEditing(account, true);
}, { flush: "sync" });

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
      notePrivateSpaceMutation(keys);
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
  if (backupBusy.value) return;
  try {
    await flush();
    const account = keys.pkHex;
    if (!account || !keys.isUnlocked) return;
    const created = await privateSpaceRepository.create(account, kind);
    updateInList(created);
    notePrivateSpaceMutation(keys);
    editor.value = { ...created, tasks: [] };
    newTaskText.value = "";
    saveStatus.value = "已保存在本机";
    error.value = "";
  } catch (cause) { handleError(cause); }
}
async function open(note: PrivateSpaceRecord) {
  if (backupBusy.value) return;
  try {
    await flush();
    editor.value = { ...note, tasks: note.tasks.map(task => ({ ...task })) };
    newTaskText.value = "";
    saveStatus.value = "已保存在本机";
    error.value = "";
  } catch (cause) { handleError(cause); }
}
async function closeEditor() {
  try {
    await flush();
    editor.value = null;
    await refreshAfterSync();
    void syncPrivateSpace(keys);
  }
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
    notePrivateSpaceMutation(keys);
    editor.value = null;
  } catch (cause) { handleError(cause); }
}
async function restoreNote(note: PrivateSpaceRecord) {
  try {
    updateInList(await privateSpaceRepository.update(note.accountPubkey, note.id, {
      deletedAt: 0, archivedAt: 0,
    }));
    notePrivateSpaceMutation(keys);
    error.value = "";
  } catch (cause) { handleError(cause); }
}
async function deleteNote() {
  if (!editor.value) return;
  if (!window.confirm("移到最近删除？可以从最近删除中恢复。")) return;
  try {
    await flush();
    const note = editor.value;
    updateInList(await privateSpaceRepository.moveToTrash(note.accountPubkey, note.id));
    notePrivateSpaceMutation(keys);
    editor.value = null;
  } catch (cause) { handleError(cause); }
}
async function refreshAfterSync() {
  const account = keys.pkHex;
  const version = loadVersion;
  if (!account || !keys.isUnlocked || editor.value || timer) return;
  try {
    const records = await privateSpaceRepository.list(account);
    if (account === keys.pkHex && version === loadVersion && !editor.value && !timer) notes.value = records;
  } catch { /* A locked session will reload after the next successful unlock. */ }
}
function onCloudUpdate(event: Event) {
  const detail = (event as CustomEvent<{ account: string }>).detail;
  if (detail?.account === keys.pkHex.toLowerCase()) void refreshAfterSync();
}
function onVisibilityChange() {
  if (document.visibilityState === "hidden" && timer) void saveNow().catch(handleError);
}
onMounted(() => {
  unsubscribeSync = subscribePrivateSpaceSync(state => {
    if (state.account === keys.pkHex.toLowerCase()) syncStatus.value = state;
  });
  window.addEventListener("hainei-private-space-synced", onCloudUpdate);
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
  // Decrypted previews and plaintext exports are never persisted in app storage.
  restorePreview.value = null;
  restoreFileContent.value = ""; restorePassword.value = "";
  backupPassword.value = ""; backupConfirm.value = "";
  if (editor.value) setPrivateSpaceEditing(editor.value.accountPubkey, false);
  unsubscribeLock?.();
  unsubscribeSync?.();
  window.removeEventListener("hainei-private-space-synced", onCloudUpdate);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (timer) clearTimeout(timer);
});
</script>

<style scoped>
.private-space-page{min-height:100%;background:#fff;color:#172033;padding-bottom:calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px)}
.privacy-line{padding:12px 16px 6px;font-size:12px;color:#64748b}
.cloud-status{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 16px 8px;font-size:12px;color:#64748b}
.cloud-status button{border:0;border-radius:7px;background:#eff6ff;color:#1d4ed8;padding:7px 9px;white-space:nowrap}
.error-line{margin:8px 16px;padding:10px;border-radius:8px;background:#fef2f2;color:#b91c1c;font-size:13px}
.toolbar{display:flex;gap:8px;align-items:center;padding:14px 14px 10px}
.toolbar input{min-width:0;flex:1;border:1px solid #e2e8f0;border-radius:11px;padding:10px;font:inherit;font-size:14px}
button{font:inherit;cursor:pointer}
.primary{padding:10px;border:0;border-radius:11px;background:#172033;color:white;white-space:nowrap;font-size:13px}
.primary.secondary{background:#e9edf3;color:#172033}
.tabs{display:flex;gap:4px;padding:0 14px 12px;border-bottom:1px solid #f1f3f5}
.tabs button{flex:1;min-width:0;border:0;border-radius:9px;background:#f1f5f9;padding:10px 2px;color:#64748b;font-size:12px}
.tabs button.selected{color:#0f172a;background:#dfe8f4;font-weight:650}
.items{list-style:none;margin:0;padding:0 14px}
.items li{border-bottom:1px solid #edf0f2}
.restore-button{border:0;background:#f1f5f9;color:#334155;border-radius:7px;padding:7px 12px;margin:0 0 12px 4px;font-size:12px}
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
.more-action{min-width:38px;min-height:40px;padding:5px;border:1px solid #e2e8f0;border-radius:9px;background:white;color:#475569}
.backup-panel{margin:8px 14px;padding:14px;border:1px solid #e2e8f0;border-radius:13px;background:#f8fafc;display:flex;flex-direction:column;gap:10px;font-size:13px}
.backup-panel-header{display:flex;align-items:center;justify-content:space-between}
.backup-panel p{margin:0;color:#64748b;line-height:1.5}
.backup-panel button{min-height:40px;padding:8px 12px;border:1px solid #dbe2e9;border-radius:9px;background:white;color:#334155;text-align:left}
.backup-panel button:disabled{opacity:.5}
.backup-panel .backup-primary{background:#172033;color:white}
.backup-label{display:grid;gap:5px;color:#334155}
.backup-label input{width:100%;box-sizing:border-box;min-height:42px;border:1px solid #cbd5e1;border-radius:9px;padding:8px 10px;font:inherit;font-size:16px}
.backup-file-input{display:none}
.backup-divider{height:1px;background:#e2e8f0;margin:6px 0}
.restore-preview{display:grid;gap:9px;padding:10px;border:1px solid #cbd5e1;border-radius:9px;background:#fff}
.source-card{display:grid;gap:5px;margin-top:16px;padding:12px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;font-size:12px;color:#475569}
.source-card strong{color:#172033}
.source-card button{justify-self:start;min-height:34px;padding:4px 8px;border:0;background:transparent;color:#2563eb;font:inherit;font-weight:600}
.source-card small{color:#94a3b8}
</style>
