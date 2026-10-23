<template>
  <!-- In the app, an incoming call first appears as a top banner (like other
       call apps) instead of covering what you are doing; tap to expand. -->
  <div v-if="showBanner" class="call-banner" role="dialog" :aria-label="`${name} 的语音来电`">
    <button class="banner-peer" type="button" aria-label="展开来电界面" @click="expanded = true">
      <ProfileAvatar :pubkey="call.peer" :size="40" />
      <span class="banner-copy"><strong>{{ name }}</strong><span>语音来电…</span></span>
    </button>
    <button class="banner-action decline" type="button" aria-label="拒绝" :disabled="acting" @click="decline">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c5-4 13-4 18 0l-2 3-4-1v-3a10 10 0 0 0-6 0v3l-4 1z"/></svg>
    </button>
    <button class="banner-action accept" type="button" aria-label="接听" :disabled="acting" @click="accept">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>
    </button>
  </div>
  <div v-else class="call-overlay" role="dialog" aria-modal="true" :aria-label="`与 ${name} 的语音通话`" @click.self="dismissEnded">
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
      <template v-else-if="call.phase === 'ended'">
        <button class="call-button close" type="button" @click="dismissEnded">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
          <span>关闭</span>
        </button>
        <button v-if="canCallBack" class="call-button accept" type="button" :disabled="acting" @click="callBack">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>
          <span>{{ call.direction === "outgoing" ? "重拨" : "回拨" }}</span>
        </button>
      </template>
      <template v-else>
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
import { computed, onBeforeUnmount, ref, watch } from "vue";
import ProfileAvatar from "./ProfileAvatar.vue";
import { loadCallEngine, useCallStore } from "@/stores/call";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { useFriendsStore } from "@/stores/friends";

const call = useCallStore();
const profiles = useProfilesStore();
const friends = useFriendsStore();
const acting = ref(false);
// An incoming call starts as a banner; expanded shows the full call screen.
const expanded = ref(false);
watch(() => call.callId, () => { expanded.value = false; });
const showBanner = computed(() => call.phase === "incoming" && !expanded.value);
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
    case "outgoing": return call.remoteRinging ? "对方响铃中…" : "正在呼叫…";
    case "incoming": return "邀请你语音通话";
    case "connecting": return "正在连接…";
    case "active": return call.reconnecting ? "网络中断，正在重新连接…"
      : `${clock(now.value - call.connectedAt)}${call.quality === "poor" ? " · 网络不佳" : ""}`;
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
// The ended screen closes itself shortly; tapping closes it at once.
function dismissEnded() { if (call.phase === "ended") call.reset(); }
// Not after another device handled it, or when the microphone is blocked.
const canCallBack = computed(() => !!call.peer && call.endReason !== "answered_elsewhere" && call.endReason !== "microphone_denied");
async function callBack() {
  const peer = call.peer;
  await once(async engine => {
    call.reset();
    await engine.startCall(peer);
  });
}
</script>

<style scoped>
.call-banner{position:fixed;top:calc(env(safe-area-inset-top) + 8px);left:8px;right:8px;z-index:200000;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:18px;background:#0f172a;color:#f8fafc;box-shadow:0 12px 32px rgba(15,23,42,.35);animation:banner-in .2s ease-out}
@keyframes banner-in{from{transform:translateY(-120%)}to{transform:none}}
.banner-peer{display:flex;flex:1;min-width:0;align-items:center;gap:10px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.banner-copy{display:flex;min-width:0;flex-direction:column}
.banner-copy strong{overflow:hidden;font-size:15px;text-overflow:ellipsis;white-space:nowrap}
.banner-copy span{color:#cbd5e1;font-size:13px}
.banner-action{display:grid;width:44px;height:44px;flex:0 0 44px;place-items:center;padding:0;border:0;border-radius:50%;color:#fff;cursor:pointer}
.banner-action svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.banner-action.decline{background:#dc2626}
.banner-action.accept{background:#16a34a}
.banner-action:disabled{opacity:.5}
.call-overlay{position:fixed;inset:0;z-index:200000;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top) + 72px) 24px calc(env(safe-area-inset-bottom) + 48px);background:linear-gradient(180deg,#1e293b,#0f172a);color:#f8fafc}
.call-peer{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.call-name{max-width:80vw;overflow:hidden;font-size:24px;text-overflow:ellipsis;white-space:nowrap}
.call-status{color:#cbd5e1;font-size:16px;font-variant-numeric:tabular-nums}
.call-actions{display:flex;justify-content:center;gap:56px}
.call-button{display:flex;flex-direction:column;align-items:center;gap:8px;padding:0;border:0;background:transparent;color:#f8fafc;font:inherit;font-size:13px;cursor:pointer}
.call-button svg{width:64px;height:64px;padding:18px;border-radius:50%;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.call-button.accept svg{background:#16a34a}
.call-button.decline svg{background:#dc2626}
.call-button.mute svg,.call-button.close svg{background:rgba(255,255,255,.14)}
.call-button.mute.on svg{background:#f8fafc;color:#0f172a}
.call-button:disabled{opacity:.45}
.call-hint{margin:0;color:#94a3b8;font-size:12px;text-align:center}
</style>
