<template>
  <div class="call-overlay" role="dialog" aria-modal="true" :aria-label="`与 ${name} 的语音通话`">
    <div class="call-peer">
      <ProfileAvatar :pubkey="call.peer" :size="96" />
      <strong class="call-name">{{ name }}</strong>
      <span class="call-status" role="status" aria-live="polite">{{ status }}</span>
    </div>

    <div class="call-actions">
      <template v-if="call.phase === 'incoming'">
        <button class="call-button decline" type="button" aria-label="拒绝" :disabled="acting" @click="decline">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c5-4 13-4 18 0l-2 3-4-1v-3a10 10 0 0 0-6 0v3l-4 1z"/></svg>
          <span>拒绝</span>
        </button>
        <button class="call-button accept" type="button" aria-label="接听" :disabled="acting" @click="accept">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>
          <span>接听</span>
        </button>
      </template>
      <template v-else-if="call.phase !== 'ended'">
        <button class="call-button mute" :class="{ on: call.muted }" type="button" :aria-pressed="call.muted" aria-label="静音" :disabled="call.phase === 'outgoing'" @click="mute">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3"/><path v-if="call.muted" d="M4 4l16 16"/></svg>
          <span>{{ call.muted ? "已静音" : "静音" }}</span>
        </button>
        <button class="call-button decline" type="button" aria-label="挂断" :disabled="acting" @click="hangup">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c5-4 13-4 18 0l-2 3-4-1v-3a10 10 0 0 0-6 0v3l-4 1z"/></svg>
          <span>{{ call.phase === "outgoing" ? "取消" : "挂断" }}</span>
        </button>
      </template>
    </div>
    <p v-if="call.phase === 'active' || call.phase === 'connecting'" class="call-hint">通话时请保持海内在前台，锁屏或切走可能会中断通话</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import ProfileAvatar from "./ProfileAvatar.vue";
import { loadCallEngine, useCallStore } from "@/stores/call";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { useFriendsStore } from "@/stores/friends";

const call = useCallStore();
const profiles = useProfilesStore();
const friends = useFriendsStore();
const acting = ref(false);
const now = ref(Date.now());
const ticker = setInterval(() => { now.value = Date.now(); }, 1_000);
onBeforeUnmount(() => clearInterval(ticker));

const name = computed(() => privateProfileDisplayName(
  profiles.getProfile(call.peer)?.nickname, call.peer, friends.list.find(friend => friend.pubkey === call.peer)?.name,
));

function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const ENDED_TEXT: Record<string, string> = {
  hangup: "通话已结束", remote_hangup: "对方已挂断", declined: "已拒绝", remote_declined: "对方已拒绝",
  busy: "忙线中", remote_busy: "对方正忙", cancelled: "已取消", remote_cancelled: "对方已取消",
  no_answer: "无人接听", answered_elsewhere: "已在其他设备处理", failed: "连接失败，请稍后重试",
  microphone_denied: "无法使用麦克风，请在系统设置中允许海内使用麦克风",
};

const status = computed(() => {
  switch (call.phase) {
    case "outgoing": return "正在呼叫…";
    case "incoming": return "邀请你语音通话";
    case "connecting": return "正在连接…";
    case "active": return clock(now.value - call.connectedAt);
    case "ended": return ENDED_TEXT[call.endReason || "hangup"] || "通话已结束";
    default: return "";
  }
});

async function once(run: (engine: Awaited<ReturnType<typeof loadCallEngine>>) => Promise<void>) {
  if (acting.value) return;
  acting.value = true;
  try { await run(await loadCallEngine()); }
  finally { acting.value = false; }
}

async function accept() { await once(engine => engine.acceptCall()); }
async function decline() { await once(engine => engine.declineCall()); }
async function hangup() { await once(engine => engine.hangup()); }
async function mute() { (await loadCallEngine()).toggleMute(); }
</script>

<style scoped>
.call-overlay{position:fixed;inset:0;z-index:200000;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top) + 72px) 24px calc(env(safe-area-inset-bottom) + 48px);background:linear-gradient(180deg,#1e293b,#0f172a);color:#f8fafc}
.call-peer{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.call-name{max-width:80vw;overflow:hidden;font-size:24px;text-overflow:ellipsis;white-space:nowrap}
.call-status{color:#cbd5e1;font-size:16px;font-variant-numeric:tabular-nums}
.call-actions{display:flex;justify-content:center;gap:56px}
.call-button{display:flex;flex-direction:column;align-items:center;gap:8px;padding:0;border:0;background:transparent;color:#f8fafc;font:inherit;font-size:13px;cursor:pointer}
.call-button svg{width:64px;height:64px;padding:18px;border-radius:50%;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.call-button.accept svg{background:#16a34a}
.call-button.decline svg{background:#dc2626}
.call-button.mute svg{background:rgba(255,255,255,.14)}
.call-button.mute.on svg{background:#f8fafc;color:#0f172a}
.call-button:disabled{opacity:.45}
.call-hint{margin:0;color:#94a3b8;font-size:12px;text-align:center}
</style>
