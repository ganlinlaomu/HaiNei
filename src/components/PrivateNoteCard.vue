<template>
  <article ref="root" :id="`msg-${item.id}`" class="post-card private-card">
    <header class="post-author">
      <ProfileAvatar :pubkey="item.pubkey" :size="38" />
      <div class="author-copy">
        <strong class="author-name">{{ ownName }}</strong>
        <div class="author-meta">
          <time :datetime="new Date(item.created_at * 1000).toISOString()">{{ formatRelativeTime(item.created_at) }}</time>
          <span class="meta-separator" aria-hidden="true">·</span>
          <span class="private-badge">🔒 仅自己 · {{ isTodo ? "待办" : "笔记" }}</span>
        </div>
      </div>
    </header>

    <button class="card-open" type="button" :aria-label="isTodo ? '打开待办' : '打开笔记'" @click="openInPrivateSpace">
      <strong v-if="record.title.trim()" class="card-title">{{ record.title }}</strong>
      <span v-if="!isTodo && text" class="message-text card-text">{{ text }}</span>
    </button>
    <PostImagePreview v-if="!isTodo && imagesMarkdown" :content="imagesMarkdown" :show-all="true" />
    <p v-if="!isTodo && hasVideo" class="card-extra">含视频，点开查看</p>

    <ul v-if="isTodo" class="task-list" aria-label="待办事项">
      <li v-for="task in visibleTasks" :key="task.id">
        <label :class="{ done: task.done }">
          <input type="checkbox" :checked="task.done" :disabled="savingTask === task.id" @change="toggleTask(task.id)" />
          <span>{{ task.text }}</span>
        </label>
      </li>
    </ul>
    <button v-if="isTodo && hiddenTaskCount" class="text-button card-more" type="button" @click="openInPrivateSpace">还有 {{ hiddenTaskCount }} 项</button>
  </article>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { InboxItem } from "@/stores/messages";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { useProfilesStore } from "@/stores/profiles";
import { formatRelativeTime } from "@/utils/format";
import { privateSpaceDisplay } from "@/services/privateSpaceContent";
import ProfileAvatar from "./ProfileAvatar.vue";

const PostImagePreview = defineAsyncComponent(() => import("./PostImagePreview.vue"));
const MAX_VISIBLE_TASKS = 6;

const props = defineProps<{ item: InboxItem }>();
const emit = defineEmits<{ height: [id: string, height: number] }>();
const keys = useKeyStore();
const ui = useUIStore();
const router = useRouter();
const profiles = useProfilesStore();

const record = computed(() => props.item.privateNote!);
const isTodo = computed(() => record.value.kind === "todo");
const display = computed(() => privateSpaceDisplay(record.value));
const text = computed(() => display.value.text.trim());
const imagesMarkdown = computed(() => display.value.attachments
  .filter(attachment => attachment.kind === "image").map(attachment => `![](${attachment.url})`).join("\n"));
const hasVideo = computed(() => display.value.attachments.some(attachment => attachment.kind === "video"));
const ownName = computed(() => profiles.getProfile(props.item.pubkey)?.nickname?.trim() || "我");
// Open tasks first; finished ones stay visible (struck through) after them.
const orderedTasks = computed(() => {
  const tasks = record.value.tasks.filter(task => task.text.trim());
  return [...tasks.filter(task => !task.done), ...tasks.filter(task => task.done)];
});
const visibleTasks = computed(() => orderedTasks.value.slice(0, MAX_VISIBLE_TASKS));
const hiddenTaskCount = computed(() => Math.max(0, orderedTasks.value.length - MAX_VISIBLE_TASKS));
const savingTask = ref("");

function openInPrivateSpace() {
  void router.push({ path: "/settings/private-space", query: { tab: record.value.kind, open: record.value.id } });
}

async function toggleTask(taskId: string) {
  if (savingTask.value) return;
  const account = keys.pkHex;
  savingTask.value = taskId;
  try {
    const [{ privateSpaceRepository }, { notePrivateSpaceMutation }] = await Promise.all([
      import("@/repositories/privateSpaceRepository"), import("@/services/privateSpaceSync"),
    ]);
    // Re-read so a change made elsewhere is not overwritten by this card's copy.
    const current = await privateSpaceRepository.get(account, record.value.id);
    if (!current || keys.pkHex !== account) return;
    const tasks = current.tasks.map(task => task.id === taskId ? { ...task, done: !task.done } : task);
    await privateSpaceRepository.update(account, current.id, { tasks });
    notePrivateSpaceMutation(keys);
  } catch {
    ui.addToast("无法更新待办，请确认账号已解锁", 2_200, "error");
  } finally {
    savingTask.value = "";
  }
}

const root = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;
onMounted(() => {
  if (!root.value || typeof ResizeObserver === "undefined") return;
  observer = new ResizeObserver(entries => emit("height", props.item.id, entries[0]?.contentRect.height || 0));
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.post-card{background:var(--bg-fff);padding:14px 16px 12px;border:0;border-bottom:1px solid var(--bd-edf1f5)}
.post-author{display:flex;align-items:center;gap:10px}
.author-copy{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:1px}
.author-name{color:var(--fg-0f1419);font-size:15px}
.author-meta{display:flex;min-width:0;align-items:center;gap:4px;color:var(--fg-8b98a5);font-size:12px;line-height:1.25}
.meta-separator{color:var(--fg-b0bac4)}
.private-badge{color:var(--fg-64748b)}
.card-open{display:flex;width:100%;flex-direction:column;align-items:stretch;gap:4px;margin-top:9px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.card-title{color:var(--fg-0f1419);font-size:15px}
.message-text{color:var(--fg-202938);font-size:15px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere}
.card-text{display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}
.card-extra{margin:8px 0 0;color:var(--fg-64748b);font-size:13px}
.task-list{display:flex;flex-direction:column;gap:2px;margin:8px 0 0;padding:0;list-style:none}
.task-list label{display:flex;min-height:36px;align-items:flex-start;gap:10px;padding:6px 0;color:var(--fg-202938);font-size:15px;line-height:1.5;cursor:pointer}
.task-list input{width:18px;height:18px;flex:0 0 18px;margin:2px 0 0;accent-color:#1d9bf0}
.task-list label span{overflow-wrap:anywhere}
.task-list label.done span{color:var(--fg-8b98a5);text-decoration:line-through}
.text-button{display:inline-flex;min-height:32px;align-items:center;padding:0;border:0;background:transparent;color:var(--fg-2563eb);font:inherit;font-size:13px;cursor:pointer}
</style>
