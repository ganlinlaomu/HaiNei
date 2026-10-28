<template>
  <section class="share-panel" aria-label="共享待办">
    <div class="share-header">
      <strong>{{ share ? '共享中' : '共享给好友' }}</strong>
      <button type="button" :disabled="busy" @click="emit('close')">关闭</button>
    </div>
    <p v-if="!keys.supportsNip44" class="share-help">当前登录方式不支持加密共享。</p>
    <template v-else-if="!share">
      <p class="share-help">好友可以看到并编辑这个清单的标题和事项，内容端到端加密。置顶、归档只影响你自己。</p>
      <p v-if="!friendOptions.length" class="share-help">还没有可以共享的好友。</p>
      <label v-for="friend in friendOptions" :key="friend.pubkey" class="share-friend">
        <input v-model="selected" type="checkbox" :value="friend.pubkey" :disabled="busy" />
        <span>{{ friend.name }}</span>
      </label>
      <button class="share-primary" type="button" :disabled="busy || !selected.length" @click="run(shareWithSelected)">
        {{ busy ? '处理中…' : selected.length ? '共享给 ' + selected.length + ' 位好友' : '选择好友' }}
      </button>
    </template>
    <template v-else>
      <ul class="share-members">
        <li v-for="member in share.members" :key="member">
          <span>{{ nameOf(member) }}<small v-if="member === share.owner">（创建者）</small></span>
          <button v-if="isOwner && member !== share.owner" type="button" :disabled="busy"
            :aria-label="'移除 ' + nameOf(member)" @click="run(() => removeMember(member))">移除</button>
        </li>
      </ul>
      <template v-if="isOwner">
        <template v-if="inviteOptions.length">
          <p class="share-help">邀请更多好友</p>
          <label v-for="friend in inviteOptions" :key="friend.pubkey" class="share-friend">
            <input v-model="selected" type="checkbox" :value="friend.pubkey" :disabled="busy" />
            <span>{{ friend.name }}</span>
          </label>
          <button type="button" :disabled="busy || !selected.length" @click="run(addMembers)">添加</button>
        </template>
        <button type="button" class="share-danger" :disabled="busy" @click="stopSharing">停止共享</button>
      </template>
      <button v-else type="button" class="share-danger" :disabled="busy" @click="stopSharing">退出共享</button>
    </template>
    <p v-if="error" role="alert" class="share-error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { PrivateSpaceRecord } from "@/db/dexie";
import { useKeyStore } from "@/stores/keys";
import { useFriendsStore } from "@/stores/friends";
import { SHARED_TODO_MAX_MEMBERS } from "@/services/sharedTodoSync";

const props = defineProps<{ record: PrivateSpaceRecord; prepare: () => Promise<void> }>();
const emit = defineEmits<{ close: []; updated: [record: PrivateSpaceRecord] }>();
const keys = useKeyStore();
const friends = useFriendsStore();
const busy = ref(false);
const error = ref("");
const selected = ref<string[]>([]);

const share = computed(() => props.record.share);
const isOwner = computed(() => share.value?.owner === keys.pkHex.toLowerCase());
const friendOptions = computed(() => friends.sortedList);
const inviteOptions = computed(() => friendOptions.value.filter(friend => !share.value?.members.includes(friend.pubkey)));

function nameOf(pubkey: string) {
  if (pubkey === keys.pkHex.toLowerCase()) return "我";
  return friends.list.find(friend => friend.pubkey === pubkey)?.name || pubkey.slice(0, 8) + "…";
}
function describe(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  const messages: Record<string, string> = {
    shared_todo_member_limit: `每个共享清单最多 ${SHARED_TODO_MAX_MEMBERS} 人，或对方的共享清单已达上限`,
    shared_todo_too_large: "清单内容过长，无法共享",
    shared_todo_not_found: "这个共享清单已不存在",
    not_found: "共享服务暂不可用，请稍后再试",
    private_space_share_unavailable: "这个清单当前无法共享",
    local_vault_locked: "私人空间未解锁",
  };
  if (messages[code]) return messages[code];
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "设备离线，联网后再试";
  return "操作失败，请稍后重试";
}
async function run(action: () => Promise<PrivateSpaceRecord | undefined>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const account = keys.pkHex;
  try {
    await props.prepare();
    const record = await action();
    if (keys.pkHex !== account) return;
    selected.value = [];
    if (record) emit("updated", record);
  } catch (cause) {
    if (keys.pkHex === account) error.value = describe(cause);
  } finally {
    busy.value = false;
  }
}
async function service() {
  return import("@/services/sharedTodoSync");
}
async function shareWithSelected() {
  return (await service()).shareTodoList(keys, props.record.id, selected.value);
}
async function addMembers() {
  return (await service()).updateTodoMembers(keys, props.record.id, selected.value, []);
}
async function removeMember(member: string) {
  if (!window.confirm(`把 ${nameOf(member)} 移出这个共享清单？对方将不再收到之后的修改。`)) return undefined;
  return (await service()).updateTodoMembers(keys, props.record.id, [], [member]);
}
function stopSharing() {
  const message = isOwner.value
    ? "停止共享？所有成员都将看不到这个清单，你保留一份私人副本。"
    : "退出这个共享清单？清单会移到最近删除，你将不再看到之后的修改。";
  if (!window.confirm(message)) return;
  void run(async () => (await service()).leaveTodoList(keys, props.record.id));
}
</script>

<style scoped>
.share-panel{margin:8px 0 12px;padding:12px;border:1px solid var(--bd-e2e8f0);border-radius:12px;background:var(--bg-f8fafc);display:flex;flex-direction:column;gap:8px;font-size:13px}
.share-header{display:flex;align-items:center;justify-content:space-between}
.share-header button{border:0;background:transparent;color:var(--fg-475569);padding:6px 2px;font:inherit}
.share-help{margin:0;color:var(--fg-64748b);line-height:1.5}
.share-friend{display:flex;align-items:center;gap:10px;min-height:40px;color:var(--fg-334155)}
.share-friend input{width:18px;height:18px}
.share-members{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.share-members li{display:flex;align-items:center;justify-content:space-between;min-height:40px;color:var(--fg-334155)}
.share-members small{color:var(--fg-94a3b8);margin-left:4px}
.share-panel > button,.share-members button{min-height:40px;padding:8px 12px;border:1px solid var(--bd-dbe2e9);border-radius:9px;background:var(--bg-fff);color:var(--fg-334155);font:inherit;text-align:left}
.share-members button{min-height:34px;padding:4px 10px}
.share-panel button:disabled{opacity:.5}
.share-panel .share-primary{background:#172033;color:#fff}
.share-panel .share-danger{color:#dc2626}
.share-error{margin:0;color:#dc2626}
</style>
