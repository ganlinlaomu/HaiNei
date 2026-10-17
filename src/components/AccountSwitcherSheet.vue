<template>
  <div v-if="open" class="switcher-overlay" role="presentation" @click.self="close">
    <section ref="dialog" class="switcher-sheet" role="dialog" aria-modal="true" aria-labelledby="account-switcher-title" tabindex="-1">
      <header class="switcher-header">
        <h2 id="account-switcher-title">切换账号</h2>
        <button class="close-button" type="button" aria-label="关闭" :disabled="busy" @click="close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <ul class="switcher-list">
        <li v-for="account in accounts" :key="account.pubkey">
          <button
            class="switcher-row"
            :class="{ current: account.pubkey === currentPubkey }"
            type="button"
            :disabled="busy"
            :aria-current="account.pubkey === currentPubkey ? 'true' : undefined"
            @click="emit('select', account.pubkey)"
          >
            <span class="switcher-avatar" :style="{ background: accountColor(account.pubkey) }" aria-hidden="true">
              <img v-if="account.avatarThumb" :src="account.avatarThumb" alt="" />
              <template v-else>{{ accountInitial(account) }}</template>
            </span>
            <span class="switcher-text">
              <strong>{{ accountDisplayName(account) }}</strong>
              <small>{{ account.pubkey === currentPubkey ? "当前账号" : `上次使用：${formatLastUsed(account.lastUsedAt)}` }}</small>
            </span>
            <svg v-if="account.pubkey === currentPubkey" class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
            <span v-else-if="busyPubkey === account.pubkey" class="switcher-busy">切换中…</span>
          </button>
        </li>
      </ul>
      <p v-if="!otherAccounts" class="switcher-empty">这台手机上还没有其他账号。</p>
      <button class="switcher-add" type="button" :disabled="busy" @click="emit('add')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        添加其他账号
      </button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useDialogFocus } from "@/composables/useDialogFocus";
import {
  accountColor,
  accountDisplayName,
  accountInitial,
  formatLastUsed,
  type DeviceAccount,
} from "@/services/accountRegistry";

const props = defineProps<{
  open: boolean;
  accounts: DeviceAccount[];
  currentPubkey: string;
  busyPubkey?: string;
}>();
const emit = defineEmits<{ close: []; select: [pubkey: string]; add: [] }>();
const dialog = ref<HTMLElement | null>(null);
const busy = computed(() => !!props.busyPubkey);
const otherAccounts = computed(() => props.accounts.filter(account => account.pubkey !== props.currentPubkey).length);

function close() {
  if (!busy.value) emit("close");
}

useDialogFocus(dialog, () => props.open, close);
</script>

<style scoped>
.switcher-overlay{position:fixed;inset:0;z-index:13000;display:flex;align-items:flex-end;justify-content:center;background:rgba(18,22,32,.42)}
.switcher-sheet{width:min(100%,480px);max-height:min(82dvh,640px);overflow-y:auto;box-sizing:border-box;padding:18px 20px calc(20px + env(safe-area-inset-bottom));border-radius:24px 24px 0 0;background:var(--hn-bg);color:var(--hn-text);font-family:var(--hn-font-sans);outline:none}
.switcher-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.switcher-header h2{margin:0;font-size:19px;font-weight:700}
.close-button{display:grid;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:var(--hn-secondary-bg);color:var(--hn-text-2);place-items:center;cursor:pointer}
.close-button svg,.switcher-add svg,.check{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.switcher-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.switcher-row{display:flex;width:100%;min-height:68px;align-items:center;gap:12px;padding:10px 14px;border:2px solid transparent;border-radius:18px;background:var(--hn-card);color:var(--hn-text);font:inherit;text-align:left;cursor:pointer}
.switcher-row.current{border-color:var(--hn-primary)}
.switcher-row:disabled{cursor:not-allowed;opacity:.65}
.switcher-avatar{display:grid;overflow:hidden;width:44px;height:44px;flex:0 0 44px;border-radius:50%;color:#fff;font-size:18px;font-weight:600;place-items:center}
.switcher-avatar img{width:100%;height:100%;object-fit:cover}
.switcher-text{display:grid;min-width:0;flex:1;gap:2px}
.switcher-text strong{overflow:hidden;font-size:16px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.switcher-text small{color:var(--hn-text-3);font-size:13px}
.check{color:var(--hn-primary);stroke-width:2.4}
.switcher-busy{color:var(--hn-text-3);font-size:13px}
.switcher-empty{margin:12px 0 0;color:var(--hn-text-3);font-size:13px;text-align:center}
.switcher-add{display:flex;width:100%;min-height:54px;align-items:center;justify-content:center;gap:8px;margin-top:14px;border:0;border-radius:16px;background:var(--hn-secondary-bg);color:var(--hn-text);font:inherit;font-size:16px;font-weight:600;cursor:pointer}
.switcher-add:disabled{opacity:.5;cursor:not-allowed}
@media(min-width:700px){.switcher-overlay{align-items:center}.switcher-sheet{border-radius:22px}}
</style>
