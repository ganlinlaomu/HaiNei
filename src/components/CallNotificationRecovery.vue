<template>
  <aside v-if="callRecovery.open && call.phase === 'idle'" class="recovery" role="status" aria-live="polite">
    <strong>{{ label }}</strong>
    <div>
      <button v-if="keys.isUnlocked && callRecovery.status === 'unavailable'" type="button" @click="retry">重试</button>
      <button v-if="keys.isUnlocked && callRecovery.peer && callRecovery.status === 'ended' && friendships.isAccepted(callRecovery.peer)" type="button" data-live-audio-action data-ringtone-arm @pointerdown="preload" :disabled="busy" @click="callBack">回拨</button>
      <button v-if="keys.isUnlocked && callRecovery.status !== 'loading'" type="button" @click="history">通话记录</button>
      <button type="button" @click="close">关闭</button>
    </div>
  </aside>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { useCallStore, loadCallEngine, loadedCallEngine } from "@/stores/call";
import { accountScopeForBadge } from "@/utils/appBadge";
import { beginCallRecovery, callRecovery, dismissCallRecovery, type CallNotice } from "@/services/callNotificationRecovery";
const keys = useKeyStore(), call = useCallStore(), friendships = useFriendshipsStore(), router = useRouter();
const busy = ref(false), mismatch = ref(false);
let notice: CallNotice | null = null, account = "", generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function close() { generation++; clearTimeout(timer); notice = null; mismatch.value = false; dismissCallRecovery(); }
function clean(value: unknown, length: number) { return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : undefined; }
function open(value: CallNotice = {}) {
  // Never navigate or disturb a call already in progress.
  if (call.phase !== "idle") {
    if (call.phase === "incoming") call.notificationExpanded = true;
    return;
  }
  close(); account = keys.pkHex;
  notice = { eventId: clean(value.eventId, 64), callId: clean(value.callId, 32), accountScope: clean(value.accountScope, 64) };
  beginCallRecovery("", notice);
  void retry();
}
async function retry() {
  if (!notice || !keys.isUnlocked || !keys.pkHex) return;
  const token = ++generation; clearTimeout(timer);
  const current = keys.pkHex;
  if (notice.accountScope && await accountScopeForBadge(current) !== notice.accountScope) {
    if (token === generation) { mismatch.value = true; callRecovery.status = "unavailable"; }
    return;
  }
  if (token !== generation || current !== keys.pkHex || !keys.isUnlocked) return;
  account = current; mismatch.value = false; beginCallRecovery(current, notice);
  timer = setTimeout(() => { if (token === generation && callRecovery.open && callRecovery.status !== "ended" && callRecovery.status !== "elsewhere") callRecovery.status = "unavailable"; }, 12000);
  // Reuse the ordinary foreground recovery path, including encrypted push inbox drain.
  try {
    const { recoverCallNotificationInbox } = await import("@/services/accountMessageSync");
    if (token === generation && keys.pkHex === current && keys.isUnlocked) await recoverCallNotificationInbox();
  } catch { if (token === generation) callRecovery.status = "unavailable"; }
}
const label = computed(() => !keys.isUnlocked ? "请先解锁海内，解锁后继续恢复来电" : mismatch.value ? "这条来电提醒属于其他账号，请切换到对应账号后重新打开提醒"
  : callRecovery.status === "ended" ? "来电已结束" : callRecovery.status === "elsewhere" ? "已在其他设备处理"
  : callRecovery.status === "unavailable" ? "暂时无法恢复来电，请重试或查看通话记录" : "正在恢复来电…");
function receive(event: MessageEvent) { if (event.data?.type === "ENCRYPTED_PUSH_HINT_AVAILABLE" && event.data.callNotification) open(event.data.callNotification); }
navigator.serviceWorker?.addEventListener("message", receive);
watch(() => [keys.pkHex, keys.isUnlocked], () => {
  if (!notice) return;
  if (account && keys.pkHex && account !== keys.pkHex) { close(); return; }
  if (!keys.isUnlocked) { generation++; clearTimeout(timer); beginCallRecovery("", notice); }
  else void retry();
}, { flush: "sync" });
watch(() => [call.phase, call.callId, callRecovery.callId], () => {
  if (!callRecovery.open || !keys.isUnlocked) return;
  if (call.phase === "incoming" && call.callId === callRecovery.callId) { call.notificationExpanded = true; close(); }
  else if (call.phase !== "idle" && call.phase !== "incoming") close();
}, { flush: "post" });
function history() { close(); void router.push('/calls'); }
function preload() { void loadCallEngine().catch(() => {}); }
async function callBack() {
  if (busy.value) return;
  const peer = callRecovery.peer, owner = keys.pkHex; busy.value = true;
  try {
    const engine = loadedCallEngine() || await loadCallEngine();
    if (keys.pkHex === owner && keys.isUnlocked && call.phase === 'idle' && friendships.isAccepted(peer)) { close(); await engine.startCall(peer); }
  } catch { callRecovery.status = "unavailable"; } finally { busy.value = false; }
}
// Read before the auth router redirects to the unlock page; preserve intent in memory.
const query = new URLSearchParams(location.hash.split('?')[1] || '');
if (query.get('incomingCall') === '1') open({ eventId: query.get('eventId') || undefined, accountScope: query.get('scope') || undefined, callId: query.get('callId') || undefined });
// Consume the launch marker once. Keep the recovery intent through unlock in
// memory, rather than reopening an old notification on every PWA refresh.
void router.isReady().then(() => {
  const route = router.currentRoute.value;
  const next = { ...route.query };
  let changed = false;
  if (next.incomingCall === "1") {
    for (const key of ["incomingCall", "eventId", "scope", "callId"]) delete next[key];
    changed = true;
  }
  if (typeof next.redirect === "string") {
    const [path, search = ""] = next.redirect.split("?");
    const params = new URLSearchParams(search);
    if (params.get("incomingCall") === "1") {
      for (const key of ["incomingCall", "eventId", "scope", "callId"]) params.delete(key);
      next.redirect = path + (params.size ? "?" + params.toString() : "");
      changed = true;
    }
  }
  if (changed) return router.replace({ path: route.path, query: next, hash: route.hash });
}).catch(() => {});
onBeforeUnmount(() => { close(); navigator.serviceWorker?.removeEventListener("message", receive); });
</script>
<style scoped>
.recovery{position:fixed;z-index:199999;top:calc(env(safe-area-inset-top) + 12px);left:12px;right:12px;padding:16px;border-radius:16px;background:var(--card,#fff);color:var(--text,#0f172a);box-shadow:0 4px 24px #0003}.recovery div{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.recovery button{min-height:44px;border:0;border-radius:10px;padding:10px 14px;background:var(--bg-f1f5f9,#f1f5f9);color:inherit;font:inherit}
</style>
