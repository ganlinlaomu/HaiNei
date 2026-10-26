<template>
  <main class="private-space-page app-page">
    <SecondaryPageHeader title="私人空间" back-label="返回我的" />
    <p v-if="error && filter !== 'saved'" role="alert" class="error-line">{{ error }}</p>
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
      <div ref="tabBar" class="tabs" role="tablist" aria-label="私人空间分类">
        <span class="tab-pill" :class="{ 'no-motion': !tabPillReady }" aria-hidden="true" :style="tabPillStyle"></span>
        <button v-for="tab in tabs" :key="tab.value" :data-space-tab="tab.value" type="button" role="tab"
          :class="{ selected: filter === tab.value }" :aria-selected="filter === tab.value"
          @click="selectFilter(tab.value)">{{ tab.label }}</button>
      </div>
      <div v-if="filter === 'all' || filter === 'archived' || filter === 'trash'" class="subsection">
        <strong>{{ filter === 'all' ? '全部笔记与待办' : filter === 'archived' ? '归档' : '最近删除' }}</strong>
        <button type="button" @click="selectFilter('note')">返回笔记</button>
      </div>
      <div class="toolbar">
        <input v-model="query" type="search" :aria-label="searchLabel" :placeholder="searchLabel" />
        <button v-if="filter === 'note'" type="button" class="primary"
          :disabled="backupBusy || loading || editorTransitionBusy" @click="create('note')">＋ 笔记</button>
        <button v-if="filter === 'todo'" type="button" class="primary"
          :disabled="backupBusy || loading || editorTransitionBusy" @click="create('todo')">＋ 待办</button>
        <button type="button" class="more-action" :disabled="backupBusy" :aria-expanded="moreOpen"
          aria-label="更多私人空间操作" @click="moreOpen = !moreOpen">•••</button>
      </div>
      <div v-if="moreOpen" class="space-more-menu" role="group" aria-label="更多私人空间操作">
        <button type="button" @click="selectFilter('all')">全部笔记与待办</button>
        <button type="button" @click="selectFilter('archived')">归档</button>
        <button type="button" @click="selectFilter('trash')">最近删除</button>
        <button type="button" @click="moreOpen = false; backupOpen = true">笔记与待办备份 / 恢复</button>
      </div>
      <div v-if="filter !== 'saved' && !loading && keys.isUnlocked" class="cloud-sync-status" role="status" aria-live="polite">
        <span>{{ cloudSyncInfo.label }}</span>
        <button v-if="cloudSyncInfo.retryable" type="button" :disabled="retryingCloudSync" @click="retryCloudSync">
          {{ retryingCloudSync ? "重试中…" : "重试同步" }}
        </button>
      </div>
      <TodoPlanner v-if="filter === 'todo' && !loading && !query.trim()" :records="notes" @open="openTodoById" @add="createTodoForDate" @changed="refreshAfterSync" />
      <p v-if="filter === 'todo' && !loading && !query.trim() && filtered.length" class="lists-label">全部待办清单</p>
      <SavedPosts v-if="filter === 'saved'" :query="query" />
      <p v-else-if="loading" class="empty-state">正在读取本地笔记…</p>
      <div v-else-if="!filtered.length" class="empty-state" role="status">{{ emptyMessage }}</div>
      <ul v-else class="items">
        <li v-for="note in filtered" :key="note.id" class="private-space-row"
          :class="{ 'swipe-enabled': canSwipeNote(note) }"
          @touchstart="canSwipeNote(note) && onNoteTouchStart($event, note.id)"
          @touchmove="canSwipeNote(note) && onNoteTouchMove($event, note.id)"
          @touchend="canSwipeNote(note) && onNoteTouchEnd($event, note.id)"
          @touchcancel="canSwipeNote(note) && onNoteTouchCancel(note.id)">
          <div v-if="canSwipeNote(note)" class="swipe-actions hainei-swipe-actions" style="--swipe-action-count:2" role="group"
            :aria-label="'操作：' + label(note)" :aria-hidden="!isSwipeOpen(note.id)">
            <button type="button" class="swipe-action edit hainei-swipe-button" data-action="edit"
              :tabindex="isSwipeOpen(note.id) ? 0 : -1" :disabled="!!rowActionBusyId"
              aria-label="编辑笔记或待办" @click.stop="editFromSwipe(note)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16 1-5L16 2l6 6-11 11-5 1-2-4zM14 4l6 6M4 22h16"/></svg></button>
            <button type="button" class="swipe-action delete hainei-swipe-button" data-action="delete"
              :tabindex="isSwipeOpen(note.id) ? 0 : -1" :disabled="!!rowActionBusyId"
              :aria-label="'删除' + label(note)" @click.stop="deleteFromSwipe(note)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
          </div>
          <div class="item-foreground" :style="canSwipeNote(note) ? swipeStyle(note.id) : undefined">
            <button type="button" class="item"
              :disabled="backupBusy || editorTransitionBusy || !!rowActionBusyId || !!note.archivedAt || !!note.deletedAt"
              @click="openFromList(note)">
              <span class="item-top"><strong :class="{ 'todo-title': note.kind === 'todo' }">{{ label(note) }}</strong><span v-if="note.pinned">📌</span></span>
              <span class="preview">{{ note.kind === 'todo' ? progress(note) : privateSpaceDisplay(note).text || (privateSpaceDisplay(note).attachments.length ? '媒体摘录' : '空白笔记') }}</span>
              <span class="date">{{ note.kind === 'todo' ? '待办' : '笔记' }} · {{ formatted(note.updatedAt) }}</span>
            </button>
            <button v-if="canSwipeNote(note)" type="button" class="row-actions-toggle"
              :disabled="backupBusy || editorTransitionBusy || !!rowActionBusyId"
              :aria-expanded="isSwipeOpen(note.id)" :aria-label="'显示' + label(note) + '操作'"
              @click.stop="toggleNoteActions(note.id)">•••</button>
          </div>
          <button v-if="note.archivedAt || note.deletedAt" type="button" class="restore-button" :disabled="!!rowActionBusyId" @click="restoreNote(note)">恢复</button>
        </li>
      </ul>
    </template>
    <section v-else class="editor">
      <div class="editor-actions">
        <button type="button" @click="closeEditor">‹ 返回列表</button>
        <span class="save-state" aria-live="polite">{{ saveStatus }}</span>
        <button type="button" @click="togglePin">{{ editor.pinned ? '取消置顶' : '置顶' }}</button>
      </div>
      <div v-if="keys.isUnlocked" class="cloud-sync-status" role="status" aria-live="polite">
        <span>{{ cloudSyncInfo.label }}</span>
        <button v-if="cloudSyncInfo.retryable" type="button" :disabled="retryingCloudSync" @click="retryCloudSync">
          {{ retryingCloudSync ? "重试中…" : "重试同步" }}
        </button>
      </div>
      <input v-model="editor.title" class="title-input" aria-label="笔记标题"
        placeholder="标题（可不填）" maxlength="500" @input="queueSave" />
      <template v-if="editor.kind === 'note'">
        <textarea v-model="editor.body" v-auto-grow="editor.body" aria-label="笔记内容" class="body-input"
          placeholder="开始记录…" rows="1" maxlength="100000" @input="queueSave"></textarea>
      </template>
      <template v-else>
        <div class="tasks">
          <div v-for="(task, index) in editor.tasks" :key="task.id" class="task">
            <input type="checkbox" v-model="task.done" :aria-label="'完成第 ' + (index + 1) + ' 项'" @change="queueSave" />
            <textarea v-model="task.text" v-auto-grow="task.text" rows="1" maxlength="2000" aria-label="待办内容"
              :class="{ done: task.done }" placeholder="待办事项" @input="queueSave"></textarea>
            <label class="task-due" :class="{ set: !!task.due }" :title="task.due ? describeDue(task.due).label : '设置时间'">
              <span aria-hidden="true">{{ task.due ? describeDue(task.due).label : '⏰' }}</span>
              <input type="datetime-local" :aria-label="'第 ' + (index + 1) + ' 项的时间'" :value="task.due ? dueInputValue(task.due) : ''"
                @change="setTaskDue(task, ($event.target as HTMLInputElement).value)" />
            </label>
            <button v-if="task.due" type="button" class="task-due-clear" :aria-label="'取消第 ' + (index + 1) + ' 项的时间'"
              @click.prevent="setTaskDue(task, '')">取消时间</button>
            <button type="button" :aria-label="'删除第 ' + (index + 1) + ' 项'"
              @click.prevent="removeTask(index)">×</button>
          </div>
          <div class="add-task">
            <textarea v-model="newTaskText" v-auto-grow="newTaskText" rows="1" maxlength="2000" placeholder="添加待办事项"
              aria-label="新的待办事项" @input="pendingTaskInput" @blur="addTask" @keydown.enter="onNewTaskEnter"></textarea>
            <button type="button" @click="addTask">添加</button>
          </div>
          <p class="task-counter">{{ progress(editor) }}</p>
        </div>
      </template>
      <div v-if="editorImageContent" class="excerpt-media" aria-label="摘录的图片">
        <PostImagePreview :content="editorImageContent" :show-all="true" />
      </div>
      <div v-if="editorVideoCount" class="excerpt-video-note">已保存 {{ editorVideoCount }} 个视频引用 · 请通过原动态查看视频</div>
      <div v-if="activeSource" class="source-card">
        <strong>来源：{{ activeSource.kind === 'post' ? '海内动态' : '普通私信' }}</strong>
        <span>作者：{{ activeSource.author || '未知' }}</span>
        <span v-if="activeSource.date">时间：{{ sourceDateDisplay(activeSource.date) }}</span>
        <button type="button" @click="navigateToSource">查看原{{ activeSource.kind === 'post' ? '动态' : '私信' }} ↗</button>
        <small>来源信息属于加密笔记，原消息不存在时无法跳转。</small>
      </div>
      <footer class="editor-footer">
        <button v-if="!isUnsavedDraft" type="button" @click="archiveNote">归档</button>
        <button v-if="!isUnsavedDraft" type="button" class="delete-button" @click="deleteNote">移到最近删除</button>
      </footer>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { privateSpaceRepository, type PrivateSpaceDraft } from "@/repositories/privateSpaceRepository";
import type { PrivateSpaceRecord } from "@/db/dexie";
import { hasPrivateSpaceDraftContent, makeUnsavedPrivateSpaceDraft } from "@/services/privateSpaceDraft";
import {
  encryptPrivateBackup, decryptPrivateBackup, exportPlainJson, exportPlainMarkdown,
  MAX_BACKUP_FILE_BYTES, type PrivateBackupPayload,
} from "@/services/privateSpaceBackup";
import { privateNoteSource } from "@/services/privateSpaceSource";
import { privateSpaceDisplay } from "@/services/privateSpaceContent";
import { getPrivateSpaceTab, rememberPrivateSpaceTab } from "@/services/privateSpaceNavigation";
import { useSwipeActions } from "@/composables/useSwipeActions";
import { vAutoGrow } from "@/directives/autoGrowTextarea";
import { shouldSubmitTaskOnEnter } from "@/utils/taskInput";
import { describeDue } from "@/utils/todoPlanning";
import { privateSpaceSearchLabel, privateSpaceEmptyMessage, type SpaceFilter } from "@/utils/privateSpacePresentation";
import { selectedTabPill, createTabPillObserver } from "@/utils/tabPillGeometry";
import {
  syncPrivateSpace, notePrivateSpaceMutation, setPrivateSpaceEditing,
  getPrivateSpaceSyncState, subscribePrivateSpaceSync, type PrivateSpaceSyncState,
} from "@/services/privateSpaceSync";
import { privateSyncFeedback } from "@/utils/networkOperationFeedback";

const PostImagePreview = defineAsyncComponent(() => import("@/components/PostImagePreview.vue"));
const SavedPosts = defineAsyncComponent(() => import("@/components/SavedPosts.vue"));
const TodoPlanner = defineAsyncComponent(() => import("@/components/TodoPlanner.vue"));
const keys = useKeyStore();
const ui = useUIStore();
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
const editorAttachments = computed(() => editor.value ? privateSpaceDisplay(editor.value).attachments : []);
const editorImageContent = computed(() => editorAttachments.value
  .filter(attachment => attachment.kind === "image")
  .map(attachment => `![](${attachment.url})`).join("\n"));
const editorVideoCount = computed(() => editorAttachments.value.filter(attachment => attachment.kind === "video").length);
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
async function promptDownload(name: string, content: string, mime: string): Promise<boolean> {
  const file = new File([content], name, { type: mime });
  // Prefer the native iOS share sheet so PWA users can choose Files/iCloud Drive.
  // Safari may deny share after asynchronous crypto work; in that case fall back.
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title: "海内私人空间", files: [file] });
      return true;
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") return false;
    }
  }
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
  return true;
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
    const saved = await promptDownload(backupFileName(".hainei-backup.json"), output, "application/json");
    throwIfStale(isCurrent);
    if (saved) {
      backupPassword.value = ""; backupConfirm.value = "";
      saveStatus.value = "加密备份已交给系统保存";
    }
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
    await promptDownload(backupFileName(format === "json" ? ".json" : ".md"),
      content, format === "json" ? "application/json" : "text/markdown");
  } catch (cause) { backupError(cause); }
  finally { backupBusy.value = false; }
}
const notes = ref<PrivateSpaceRecord[]>([]);
const editor = ref<PrivateSpaceRecord | null>(null);
const isUnsavedDraft = ref(false);
const editorTransitionBusy = ref(false);
const rowActionBusyId = ref("");
const blockedSwipeClickId = ref("");
let unblockSwipeClickTimer: ReturnType<typeof setTimeout> | undefined;
const { close: closeSwipe, closeOthers: closeOtherSwipes, isOpen: isSwipeOpen, open: openSwipe,
  onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, swipeStyle } = useSwipeActions({ actionWidth: 128, openThreshold: 64 });
let swipeStart: { id: string; x: number; y: number } | null = null;
let handlingQuickCreate = false;
const query = ref("");
const filter = ref<SpaceFilter>(route.query.new === "note" ? "note" : route.query.new === "todo" ? "todo" : route.query.tab === "saved" || route.query.tab === "note" || route.query.tab === "todo" ? route.query.tab : getPrivateSpaceTab(keys.pkHex));
const searchLabel = computed(() => privateSpaceSearchLabel(filter.value));
const emptyMessage = computed(() => privateSpaceEmptyMessage(filter.value, query.value));
const moreOpen = ref(false);
const loading = ref(false);
const error = ref("");
const saveStatus = ref("已保存在本机");
const cloudSyncState = ref<PrivateSpaceSyncState | null>(null);
const cloudSyncInfo = computed(() => privateSyncFeedback(
  keys.supportsNip44 ? cloudSyncState.value?.status || "local" : "unavailable",
));
const retryingCloudSync = ref(false);
let stopCloudStatus: (() => void) | undefined;
async function retryCloudSync() {
  if (retryingCloudSync.value || !keys.isUnlocked || !keys.supportsNip44) return;
  const account = keys.pkHex;
  const generation = keys.sessionGeneration;
  retryingCloudSync.value = true;
  try {
    await syncPrivateSpace(keys);
  } finally {
    if (keys.pkHex === account && keys.sessionGeneration === generation)
      retryingCloudSync.value = false;
  }
}
const newTaskText = ref("");
const tabs = [
  { value: "saved", label: "收藏" }, { value: "note", label: "笔记" }, { value: "todo", label: "待办" },
] as const;
const tabBar = ref<HTMLElement | null>(null);
const tabPillStyle = ref<Record<string, string>>({ opacity: "0", width: "0px", transform: "translateX(0px)" });
const tabPillReady = ref(false);
let tabPillHasPosition = false;
let tabPillFrame: number | null = null;
function cancelTabPillFrame() {
  if (tabPillFrame !== null) cancelAnimationFrame(tabPillFrame);
  tabPillFrame = null;
}
function enableTabPillAnimationAfterPaint() {
  cancelTabPillFrame();
  tabPillFrame = requestAnimationFrame(() => {
    tabPillFrame = null;
    if (tabBar.value) tabPillReady.value = true;
  });
}
function refreshTabPill() {
  const bar = tabBar.value;
  if (!bar) return;
  const geometries = [...bar.querySelectorAll<HTMLButtonElement>("[data-space-tab]")].map(element => ({
    key: element.dataset.spaceTab || "", offsetLeft: element.offsetLeft, offsetWidth: element.offsetWidth,
  }));
  const pill = selectedTabPill(geometries, filter.value);
  if (!pill) {
    // Archived/trash are not primary tabs: retain the previous position so
    // returning to a tab never animates in from the left edge.
    tabPillStyle.value = { ...tabPillStyle.value, opacity: "0" };
    return;
  }
  if (!tabPillHasPosition) {
    // First DOM measurement (including remount after editor) must not slide.
    tabPillReady.value = false;
    tabPillHasPosition = true;
    enableTabPillAnimationAfterPaint();
  }
  tabPillStyle.value = {
    opacity: "1", width: `${pill.width}px`,
    transform: `translateX(${pill.translateX}px)`,
  };
}
const tabPillObserver = createTabPillObserver(refreshTabPill);
watch(tabBar, bar => {
  // The entire tablist is v-if removed while editing. Always reconnect to
  // freshly mounted elements, even if the selected filter did not change.
  cancelTabPillFrame();
  tabPillReady.value = false;
  tabPillHasPosition = false;
  tabPillObserver.attach(bar);
}, { flush: "post" });
watch(filter, () => { void nextTick(refreshTabPill); });
function selectFilter(value: SpaceFilter) {
  filter.value = value;
  if (value === "saved" || value === "note" || value === "todo") rememberPrivateSpaceTab(keys.pkHex, value);
  query.value = "";
  moreOpen.value = false;
  closeAllNoteSwipes();
}
let timer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<void> = Promise.resolve();
let loadVersion = 0;
let unsubscribeLock: (() => void) | undefined;

async function consumeQuickCreate(requested: unknown, duringLoad = false) {
  if ((requested !== "note" && requested !== "todo") || handlingQuickCreate
    || !keys.isUnlocked || (!duringLoad && loading.value)) return;
  const version = loadVersion;
  handlingQuickCreate = true;
  try {
    if (!editor.value) await create(requested, duringLoad);
    if (version === loadVersion && route.query.new === requested) {
      void router.replace({
        path: route.path,
        query: Object.fromEntries(Object.entries(route.query).filter(([name]) => name !== "new")),
      });
    }
  } finally {
    handlingQuickCreate = false;
  }
}

function canSwipeNote(note: PrivateSpaceRecord) {
  return !note.deletedAt && !note.archivedAt;
}
function blockPostSwipeClick(id: string) {
  blockedSwipeClickId.value = id;
  if (unblockSwipeClickTimer) clearTimeout(unblockSwipeClickTimer);
  unblockSwipeClickTimer = setTimeout(() => {
    blockedSwipeClickId.value = "";
    unblockSwipeClickTimer = undefined;
  }, 350);
}
function onNoteTouchStart(event: TouchEvent, id: string) {
  if (backupBusy.value || loading.value || editorTransitionBusy.value || rowActionBusyId.value) return;
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  swipeStart = { id, x: touch.clientX, y: touch.clientY };
  onTouchStart(event, id);
}
function onNoteTouchMove(event: TouchEvent, id: string) {
  if (swipeStart?.id !== id || event.touches.length !== 1) return;
  onTouchMove(event, id);
}
function onNoteTouchEnd(event: TouchEvent, id: string) {
  if (swipeStart?.id !== id) return;
  const touch = event.changedTouches[0];
  if (touch) {
    const dx = touch.clientX - swipeStart.x;
    const dy = touch.clientY - swipeStart.y;
    if (Math.abs(dx) >= 8 && Math.abs(dx) > Math.abs(dy) * 1.2) blockPostSwipeClick(id);
  }
  onTouchEnd(id);
  swipeStart = null;
}
function onNoteTouchCancel(id: string) {
  if (swipeStart?.id !== id) return;
  onTouchCancel(id);
  swipeStart = null;
}
function closeAllNoteSwipes() {
  closeOtherSwipes();
  swipeStart = null;
}
function toggleNoteActions(id: string) {
  if (blockedSwipeClickId.value === id) return;
  if (isSwipeOpen(id)) closeSwipe(id);
  else openSwipe(id);
}
function dueInputValue(ms: number) {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function setTaskDue(task: { due?: number }, value: string) {
  if (value) task.due = new Date(value).getTime();
  else delete task.due;
  queueSave();
}
function openTodoById(id: string) {
  const note = notes.value.find(item => item.id === id);
  if (note) openFromList(note);
}
function openFromList(note: PrivateSpaceRecord) {
  if (blockedSwipeClickId.value === note.id) return;
  if (isSwipeOpen(note.id)) { closeSwipe(note.id); return; }
  void open(note);
}
async function editFromSwipe(note: PrivateSpaceRecord) {
  if (backupBusy.value || editorTransitionBusy.value || rowActionBusyId.value) return;
  closeAllNoteSwipes();
  await open(note);
}

/** Each toast captures its own item/revision; a later deletion does not replace it. */
function offerDispositionUndo(
  saved: PrivateSpaceRecord, field: "deletedAt" | "archivedAt", prior = 0,
) {
  const account = saved.accountPubkey.toLowerCase();
  const generation = keys.sessionGeneration;
  const at = saved[field];
  if (!at) return;
  let used = false;
  ui.addToast(field === "deletedAt" ? "已删除 · 可撤销" : "已归档 · 可撤销", 5_000, "info", {
    label: "撤销",
    run: () => {
      if (used || !keys.isUnlocked || keys.pkHex.toLowerCase() !== account ||
          keys.sessionGeneration !== generation) return;
      used = true;
      void (async () => {
        try {
          const restored = await privateSpaceRepository.undoDisposition(
            account, saved.id, field, saved.revision, at, prior,
          );
          if (!restored) {
            if (keys.isUnlocked && keys.pkHex.toLowerCase() === account &&
                keys.sessionGeneration === generation)
              ui.addToast("这一项已被修改，未撤销", 2_600, "info");
            return;
          }
          // The write is account-scoped even if a logout raced the transaction.
          // On the next unlock, dirty revisions will be reconciled to cloud.
          if (!keys.isUnlocked || keys.pkHex.toLowerCase() !== account ||
              keys.sessionGeneration !== generation) return;
          updateInList(restored);
          notePrivateSpaceMutation(keys);
        } catch {
          if (keys.isUnlocked && keys.pkHex.toLowerCase() === account)
            ui.addToast("撤销失败，请到最近删除或归档中恢复", 2_600, "error");
        }
      })();
    },
  });
}

async function deleteFromSwipe(note: PrivateSpaceRecord) {
  if (backupBusy.value || loading.value || editorTransitionBusy.value || rowActionBusyId.value || !canSwipeNote(note)) return;
  rowActionBusyId.value = note.id;
  try {
    const { account, isCurrent } = sessionSnapshot();
    if (account !== note.accountPubkey || !isCurrent()) return;
    const current = await privateSpaceRepository.get(account, note.id);
    if (!isCurrent() || !current || !canSwipeNote(current)) return;
    const deleted = await privateSpaceRepository.moveToTrash(account, note.id);
    if (!isCurrent()) return;
    updateInList(deleted);
    closeSwipe(note.id);
    notePrivateSpaceMutation(keys);
    offerDispositionUndo(deleted, "deletedAt", current.deletedAt || 0);
    error.value = "";
  } catch (cause) {
    if (keys.isUnlocked && keys.pkHex === note.accountPubkey) handleError(cause);
  } finally { rowActionBusyId.value = ""; }
}
watch([query, filter], closeAllNoteSwipes);
const filtered = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return notes.value
    .filter(note => filter.value === "trash" ? !!note.deletedAt
      : filter.value === "archived" ? !!note.archivedAt && !note.deletedAt
        : !note.deletedAt && !note.archivedAt && (filter.value === "all" || note.kind === filter.value))
    .filter(note => !term || [note.title, privateSpaceDisplay(note).text, ...note.tasks.map(task => task.text)]
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
  filter.value = route.query.new === "note" ? "note" : route.query.new === "todo" ? "todo"
    : route.query.tab === "saved" || route.query.tab === "note" || route.query.tab === "todo" ? route.query.tab : getPrivateSpaceTab(account);
  closeAllNoteSwipes();
  blockedSwipeClickId.value = "";
  notes.value = [];
  editor.value = null;
  isUnsavedDraft.value = false;
  newTaskText.value = "";
  query.value = "";
  moreOpen.value = false;
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
      void syncPrivateSpace(keys);
      await consumeQuickCreate(route.query.new, true);
      // Feed cards link straight to their note or to-do list.
      const target = typeof route.query.open === "string" ? records.find(note => note.id === route.query.open && !note.deletedAt) : undefined;
      if (target && version === loadVersion) {
        filter.value = target.kind;
        await open(target);
      }
    }
  } catch (cause) {
    if (version === loadVersion) handleError(cause);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

watch(() => route.query.new, requested => {
  if (requested === "note" || requested === "todo") selectFilter(requested);
  void consumeQuickCreate(requested);
});

watch(() => editor.value?.accountPubkey || "", (account, previousAccount) => {
  if (previousAccount) setPrivateSpaceEditing(previousAccount, false);
  if (account) setPrivateSpaceEditing(account, true);
}, { flush: "sync" });

// isUnlocked turns true before keys.loadAccountStores unlocks the local
// vault; reading earlier fails with local_vault_locked (seen on a cold start
// straight into 私人空间, e.g. offline). Wait until the account is ready.
watch(() => [keys.pkHex, keys.isUnlocked, keys.accountStoresReadyFor] as const, ([account, unlocked, readyFor]) => {
  cloudSyncState.value = unlocked && account ? getPrivateSpaceSyncState(account.toLowerCase()) : null;
  if (unlocked && account && readyFor !== account) {
    loading.value = true; // keep the loading state instead of a false "暂无"
    return;
  }
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
    ...(current.source ? { source: current.source } : {}),
    ...(current.attachments !== undefined ? { attachments: current.attachments } : {}),
  };
  // A never-edited draft must not create an IndexedDB row or enter PR2 cloud sync.
  if (isUnsavedDraft.value && !hasPrivateSpaceDraftContent(draft)) {
    saveStatus.value = "空白草稿未保存";
    return writes;
  }
  // Local IndexedDB writes do not need a network-style progress animation.
  saveStatus.value = "";
  const operation = writes.catch(() => undefined).then(async () => {
    if (loadVersion !== version || keys.pkHex !== account || !keys.isUnlocked) {
      throw new Error("account_changed");
    }
    const newDraft = isUnsavedDraft.value && editor.value?.id === id;
    const record = newDraft
      ? await privateSpaceRepository.createWithContent(account, id, draft)
      : await privateSpaceRepository.save(account, id, draft);
    if (loadVersion === version && keys.pkHex === account) {
      if (newDraft) isUnsavedDraft.value = false;
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
/** Promote an unfinished inline task on blur, navigation, app background or account lock. */
function commitPendingTaskInput() {
  const value = newTaskText.value.trim();
  if (!editor.value || editor.value.kind !== "todo" || !value) return false;
  if (editor.value.tasks.length >= 1000) {
    error.value = "最多只能添加 1000 项待办，当前输入未保存";
    return false;
  }
  editor.value.tasks.push({ id: crypto.randomUUID(), text: value, done: false });
  newTaskText.value = "";
  return true;
}
function pendingTaskInput() {
  if (newTaskText.value.trim()) saveStatus.value = "待办输入尚未保存";
}
function addTask() {
  if (commitPendingTaskInput()) queueSave();
}
function onNewTaskEnter(event: KeyboardEvent) {
  if (!shouldSubmitTaskOnEnter(event)) return;
  event.preventDefault();
  addTask();
}
async function flush() {
  const committed = commitPendingTaskInput();
  // A full todo list must block navigation rather than silently discard typed input.
  if (!committed && editor.value?.kind === "todo" && newTaskText.value.trim())
    throw new Error("待办已达到 1000 项，请先处理输入内容再离开");
  if (committed) queueSave();
  if (timer) return saveNow();
  return writes;
}
async function create(kind: "note" | "todo", duringLoad = false) {
  // Synchronous gate closes the double-tap race across the first await.
  if (backupBusy.value || editorTransitionBusy.value || editor.value
      || (loading.value && !duringLoad)) return;
  editorTransitionBusy.value = true;
  const account = keys.pkHex;
  const version = loadVersion;
  try {
    await flush();
    if (!account || !keys.isUnlocked || keys.pkHex !== account || version !== loadVersion) return;
    // No repository.create() and no notePrivateSpaceMutation() until content exists.
    isUnsavedDraft.value = true;
    editor.value = makeUnsavedPrivateSpaceDraft(account, kind);
    newTaskText.value = "";
    saveStatus.value = "空白草稿未保存";
    error.value = "";
  } catch (cause) { handleError(cause); }
  finally { editorTransitionBusy.value = false; }
}
/** A planner date creates an unsaved list with one editable dated task.
 * Blank text is never written to IndexedDB or cloud sync. */
async function createTodoForDate(due: number) {
  if (!Number.isSafeInteger(due) || !keys.isUnlocked) return;
  await create("todo");
  if (editor.value?.kind !== "todo" || !isUnsavedDraft.value) return;
  editor.value.tasks.push({ id: crypto.randomUUID(), text: "", done: false, due });
}

async function open(note: PrivateSpaceRecord) {
  if (backupBusy.value || editorTransitionBusy.value || editor.value) return;
  editorTransitionBusy.value = true;
  try {
    await flush();
    if (!keys.isUnlocked || keys.pkHex !== note.accountPubkey) return;
    isUnsavedDraft.value = false;
    // Legacy PR3-A notes are projected into readable text in memory only.
    // Do not auto-write or create a cloud conflict merely by viewing one.
    const display = privateSpaceDisplay(note);
    editor.value = {
      ...note, body: display.text, tasks: note.tasks.map(task => ({ ...task })),
      ...(display.source ? { source: display.source } : {}),
      ...(display.attachments.length ? { attachments: display.attachments } : {}),
    };
    newTaskText.value = "";
    saveStatus.value = "已保存在本机";
    error.value = "";
  } catch (cause) { handleError(cause); }
  finally { editorTransitionBusy.value = false; }
}
async function closeEditor() {
  if (editorTransitionBusy.value) return;
  editorTransitionBusy.value = true;
  try {
    await flush();
    editor.value = null;
    isUnsavedDraft.value = false;
    newTaskText.value = "";
    await refreshAfterSync();
    void syncPrivateSpace(keys);
  }
  catch (cause) { handleError(cause); }
  finally { editorTransitionBusy.value = false; }
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
    const archived = await privateSpaceRepository.update(note.accountPubkey, note.id, { archivedAt: Date.now() });
    updateInList(archived);
    notePrivateSpaceMutation(keys);
    offerDispositionUndo(archived, "archivedAt", note.archivedAt || 0);
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
    const deleted = await privateSpaceRepository.moveToTrash(note.accountPubkey, note.id);
    updateInList(deleted);
    notePrivateSpaceMutation(keys);
    offerDispositionUndo(deleted, "deletedAt", note.deletedAt || 0);
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
  if (document.visibilityState === "hidden" && (timer || (editor.value?.kind === "todo" && newTaskText.value.trim())))
    void flush().catch(handleError);
}
onMounted(() => {
  // watch(tabBar) handles initial binding and every editor/list transition.
  window.addEventListener("resize", refreshTabPill, { passive: true });
  void document.fonts?.ready.then(refreshTabPill);
  cloudSyncState.value = getPrivateSpaceSyncState(keys.pkHex.toLowerCase());
  stopCloudStatus = subscribePrivateSpaceSync(state => {
    if (state.account === keys.pkHex.toLowerCase() && keys.isUnlocked) cloudSyncState.value = state;
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
  stopCloudStatus?.();
  tabPillObserver.disconnect();
  cancelTabPillFrame();
  window.removeEventListener("resize", refreshTabPill);
  window.removeEventListener("hainei-private-space-synced", onCloudUpdate);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (timer) clearTimeout(timer);
  if (unblockSwipeClickTimer) clearTimeout(unblockSwipeClickTimer);
  closeAllNoteSwipes();
});
</script>

<style scoped>
.cloud-sync-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 16px 10px;color:var(--fg-64748b);font-size:12px;line-height:1.5}
.cloud-sync-status button{min-height:34px;padding:5px 10px;border:1px solid var(--bd-e2e8f0);border-radius:8px;background:transparent;color:var(--fg-2563eb);font:inherit;cursor:pointer}
.cloud-sync-status button:disabled{opacity:.6}
.private-space-page{min-height:100%;background:var(--bg-fff);color:var(--fg-172033);padding-bottom:calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px)}
.error-line{margin:8px 16px;padding:10px;border-radius:8px;background:var(--bg-fef2f2);color:var(--fg-b91c1c);font-size:13px}
.toolbar{display:flex;min-width:0;box-sizing:border-box;gap:8px;align-items:center;padding:14px 14px 10px}
/* Keep iOS focus from auto-zooming; fix dimensions across focus/search states. */
.toolbar input{appearance:none;-webkit-appearance:none;box-sizing:border-box;min-width:0;width:0;max-width:100%;height:44px;flex:1 1 0;border:1px solid var(--bd-e2e8f0);border-radius:11px;padding:0 10px;font:inherit;font-size:16px;line-height:normal;color:inherit;background:var(--bg-fff)}
.toolbar button{flex-shrink:0}
button{font:inherit;cursor:pointer}
.primary{padding:10px;border:0;border-radius:11px;background:#172033;color:#fff;white-space:nowrap;font-size:13px}
.tabs{--tab-padding-y:12px;--tab-padding-x:14px;--tab-height:42px;position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:var(--tab-padding-y) var(--tab-padding-x);border-bottom:1px solid var(--bd-f1f3f5)}
.tabs::before{content:"";position:absolute;top:var(--tab-padding-y);left:var(--tab-padding-x);right:var(--tab-padding-x);height:var(--tab-height);border-radius:9px;background:var(--bg-f1f5f9);pointer-events:none;z-index:0}
.tabs .tab-pill{position:absolute;top:var(--tab-padding-y);left:0;height:var(--tab-height);border-radius:9px;background:var(--bg-dfe8f4);pointer-events:none;z-index:1;transition:transform 200ms ease,opacity 180ms ease}
.tabs .tab-pill.no-motion{transition:none}
@media (prefers-reduced-motion:reduce){.tabs .tab-pill{transition:opacity 150ms ease}}
.tabs button{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;width:100%;height:var(--tab-height);min-height:var(--tab-height);box-sizing:border-box;border:0;border-radius:9px;background:transparent;padding:0 8px;color:var(--fg-64748b);font-size:13px;line-height:1}
.tabs button.selected{color:var(--fg-0f172a);background:transparent;font-weight:650}
.subsection{display:flex;align-items:center;justify-content:space-between;padding:11px 16px;color:var(--fg-334155);font-size:13px}
.subsection button{border:0;background:transparent;color:var(--fg-2563eb);padding:6px}
.space-more-menu{display:grid;gap:2px;margin:0 14px 12px;padding:6px;border:1px solid var(--bd-e2e8f0);border-radius:11px;background:var(--bg-fff)}
.space-more-menu button{border:0;background:transparent;padding:12px 9px;text-align:left;color:var(--fg-334155);font-size:13px;border-radius:7px}
.space-more-menu button:active{background:var(--bg-f1f5f9)}
.items{list-style:none;margin:0;padding:0 14px}
.items li{border-bottom:1px solid var(--bd-edf0f2)}
.private-space-row{position:relative;overflow:hidden;background:var(--bg-fff)}
.private-space-row.swipe-enabled{touch-action:pan-y}
.swipe-actions{position:absolute;top:0;right:0;bottom:0;width:140px;display:flex}
.swipe-action{flex:1;min-width:0;border:0;font-size:13px;font-weight:650;color:#fff}
.swipe-action.edit{background:#536471}
.swipe-action.delete{flex:0 0 52px;width:52px;height:52px;align-self:center;margin:0 9px;border-radius:50%;background:#dc2626;display:grid;place-items:center}
.swipe-action.delete svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.item-foreground{position:relative;z-index:1;display:flex;align-items:stretch;width:100%;background:var(--bg-fff);transition:transform .2s ease;will-change:transform}
.item-foreground .item{flex:1;min-width:0}
.row-actions-toggle{width:40px;flex:0 0 40px;border:0;background:var(--bg-fff);color:var(--fg-64748b);font-size:16px;letter-spacing:1px}
.swipe-action:focus-visible,.row-actions-toggle:focus-visible{outline:2px solid #2563eb;outline-offset:-2px}
@media (prefers-reduced-motion:reduce){.item-foreground{transition:none}}
.restore-button{border:0;background:var(--bg-f1f5f9);color:var(--fg-334155);border-radius:7px;padding:7px 12px;margin:0 0 12px 4px;font-size:12px}
.item{width:100%;display:flex;flex-direction:column;gap:6px;border:0;background:var(--bg-fff);text-align:left;padding:17px 4px}
.item-top{display:flex;justify-content:space-between;gap:8px}
.item-top strong{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-top strong.todo-title{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}
.preview{font-size:13px;color:var(--fg-64748b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.date{font-size:11px;color:var(--fg-94a3b8)}
.empty-state{text-align:center;padding:65px 20px;color:var(--fg-94a3b8);font-size:13px}
.editor{padding:14px}
.editor-actions{display:flex;align-items:center;justify-content:space-between;gap:4px}
.editor-actions button,.editor-footer button{border:0;background:transparent;color:var(--fg-475569);padding:10px 3px;font-size:13px}
.save-state{font-size:11px;color:var(--fg-64748b);white-space:nowrap}
.title-input{width:100%;margin-top:20px;padding:8px 2px;font-weight:650;font-size:21px;border:0;outline:none}
.body-input{display:block;box-sizing:border-box;width:100%;resize:none;overflow-y:hidden;overflow-wrap:anywhere;border:0;outline:none;margin-top:16px;padding:0;background:transparent;font:inherit;line-height:1.65;color:inherit}
.tasks{margin-top:24px}.lists-label{margin:18px 16px 6px;color:var(--fg-8b98a5);font-size:13px}.task-due{position:relative;display:inline-flex;overflow:hidden;flex:0 0 auto;align-items:center;min-height:32px;padding:0 6px;border-radius:10px;color:var(--fg-8b98a5);font-size:12px;white-space:nowrap;cursor:pointer}.task-due.set{background:var(--bg-eff3f4);color:var(--fg-0f1419)}.task-due input{position:absolute;inset:0;width:100%;min-width:0;max-width:100%;height:100%;margin:0;padding:0;border:0;opacity:0;-webkit-appearance:none;appearance:none;cursor:pointer}
.task{display:flex;align-items:center;gap:10px;min-height:48px;border-bottom:1px solid var(--bd-f1f3f5)}
.task input[type="checkbox"]{width:19px;height:19px;accent-color:var(--fg-334155);flex:0 0 auto}
.task textarea,.add-task textarea{display:block;box-sizing:border-box;min-width:0;width:0;flex:1;min-height:44px;border:0;background:transparent;color:inherit;font:inherit;font-size:16px;line-height:24px;outline:none;padding:10px 0;resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
.task .done{text-decoration:line-through;color:var(--fg-94a3b8)}
.task button,.add-task button{flex-shrink:0;border:0;background:transparent;color:var(--fg-64748b);padding:8px}.task>button{position:relative;z-index:1;min-width:36px;min-height:36px}.task>.task-due-clear{min-width:0;padding:0 6px;font-size:12px;white-space:nowrap}
.add-task{display:flex;align-items:center;gap:8px;margin-top:12px}
.task-counter{font-size:12px;color:var(--fg-94a3b8)}
.editor-footer{display:flex;justify-content:space-between;border-top:1px solid var(--bd-edf0f2);margin-top:25px;padding-top:12px}
.editor-footer .delete-button{color:var(--fg-be123c)}
.more-action{min-width:38px;min-height:40px;padding:5px;border:1px solid var(--bd-e2e8f0);border-radius:9px;background:var(--bg-fff);color:var(--fg-475569)}
.backup-panel{margin:8px 14px;padding:14px;border:1px solid var(--bd-e2e8f0);border-radius:13px;background:var(--bg-f8fafc);display:flex;flex-direction:column;gap:10px;font-size:13px}
.backup-panel-header{display:flex;align-items:center;justify-content:space-between}
.backup-panel p{margin:0;color:var(--fg-64748b);line-height:1.5}
.backup-panel button{min-height:40px;padding:8px 12px;border:1px solid var(--bd-dbe2e9);border-radius:9px;background:var(--bg-fff);color:var(--fg-334155);text-align:left}
.backup-panel button:disabled{opacity:.5}
.backup-panel .backup-primary{background:#172033;color:#fff}
.backup-label{display:grid;gap:5px;color:var(--fg-334155)}
.backup-label input{width:100%;box-sizing:border-box;min-height:42px;border:1px solid var(--bd-cbd5e1);border-radius:9px;padding:8px 10px;font:inherit;font-size:16px}
.backup-file-input{display:none}
.backup-divider{height:1px;background:var(--bg-e2e8f0);margin:6px 0}
.restore-preview{display:grid;gap:9px;padding:10px;border:1px solid var(--bd-cbd5e1);border-radius:9px;background:var(--bg-fff)}
.source-card{display:grid;gap:5px;margin-top:16px;padding:12px;border:1px solid var(--bd-e2e8f0);border-radius:12px;background:var(--bg-f8fafc);font-size:12px;color:var(--fg-475569)}
.source-card strong{color:var(--fg-172033)}
.source-card button{justify-self:start;min-height:34px;padding:4px 8px;border:0;background:transparent;color:var(--fg-2563eb);font:inherit;font-weight:600}
.source-card small{color:var(--fg-94a3b8)}
.excerpt-media{margin:14px 0;border-radius:12px;overflow:hidden}
.excerpt-video-note{font-size:12px;color:var(--fg-64748b);padding:10px 12px;border-radius:9px;background:var(--bg-f8fafc)}
</style>
