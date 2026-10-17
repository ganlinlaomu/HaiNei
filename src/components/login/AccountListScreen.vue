<template>
  <section class="hn-screen">
    <div class="hn-body">
      <header class="mini-brand">
        <svg class="moon" viewBox="0 0 32 32" aria-hidden="true">
          <defs>
            <mask id="hn-mini-moon">
              <circle cx="16" cy="16" r="11" fill="#fff" />
              <circle cx="21" cy="12" r="9.5" fill="#000" />
            </mask>
          </defs>
          <rect width="32" height="32" fill="currentColor" mask="url(#hn-mini-moon)" />
        </svg>
        <span>海内</span>
      </header>

      <h2 class="list-title">这台手机上的账号</h2>
      <ul class="account-list" role="radiogroup" aria-label="这台手机上的账号">
        <li v-for="account in accounts" :key="account.pubkey" class="account-item">
          <div class="hn-card account-row" :class="{ selected: account.pubkey === selected }">
            <button
              class="account-select"
              type="button"
              role="radio"
              :aria-checked="account.pubkey === selected"
              :disabled="loading"
              @click="select(account.pubkey)"
            >
              <span class="hn-avatar" :style="{ width: '48px', height: '48px', '--hn-avatar-color': accountColor(account.pubkey) }" aria-hidden="true">
                <img v-if="account.avatarThumb" :src="account.avatarThumb" alt="" />
                <template v-else>{{ accountInitial(account) }}</template>
              </span>
              <span class="account-text">
                <strong>{{ accountDisplayName(account) }}</strong>
                <small>上次使用：{{ formatLastUsed(account.lastUsedAt) }}</small>
              </span>
            </button>
            <button
              class="hn-icon-button more"
              type="button"
              aria-label="更多操作"
              :aria-expanded="menuFor === account.pubkey"
              :disabled="loading"
              @click="toggleMenu(account.pubkey)"
            >
              <svg class="hn-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18.5" cy="12" r="1.2" /></svg>
            </button>
          </div>
          <div v-if="menuFor === account.pubkey" class="hn-card account-menu">
            <button class="menu-action" type="button" :disabled="loading" @click="emit('forget', account.pubkey)">
              <strong>忘记此账号</strong>
              <small>移除这台手机上的登录凭证，保留聊天记录</small>
            </button>
            <button class="menu-action danger" type="button" :disabled="loading" @click="emit('delete', account.pubkey)">
              <strong>删除本机资料</strong>
              <small>清除这个账号在本机的全部资料，无法恢复</small>
            </button>
          </div>
        </li>
      </ul>
    </div>
    <div class="hn-actions">
      <slot name="notice" />
      <button class="hn-btn hn-btn-primary" type="button" :disabled="loading || !selectedAccount" @click="enter">
        {{ loading ? "正在进入…" : enterLabel }}
      </button>
      <button class="hn-btn hn-btn-secondary" type="button" :disabled="loading" @click="emit('add')">添加其他账号</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  accountColor,
  accountDisplayName,
  accountInitial,
  formatLastUsed,
  type DeviceAccount,
} from "@/services/accountRegistry";

const props = defineProps<{
  accounts: DeviceAccount[];
  biometricName: string;
  hasBiometric: (pubkey: string) => boolean;
  loading?: boolean;
}>();
const emit = defineEmits<{ enter: [pubkey: string]; add: []; forget: [pubkey: string]; delete: [pubkey: string] }>();

const selected = ref(props.accounts[0]?.pubkey || "");
const menuFor = ref("");
const selectedAccount = computed(() => props.accounts.find(account => account.pubkey === selected.value));

watch(() => props.accounts, accounts => {
  if (!accounts.some(account => account.pubkey === selected.value)) selected.value = accounts[0]?.pubkey || "";
  if (!accounts.some(account => account.pubkey === menuFor.value)) menuFor.value = "";
});

const enterLabel = computed(() => {
  const account = selectedAccount.value;
  if (!account) return "进入";
  const name = accountDisplayName(account);
  if (account.authType === "private-key" && (account.credentialMode === "passkey" || props.hasBiometric(account.pubkey))) {
    return `用 ${props.biometricName} 进入 · ${name}`;
  }
  if (account.authType === "private-key" && account.credentialMode === "password") return `用本地密码进入 · ${name}`;
  return `进入 · ${name}`;
});

function select(pubkey: string) {
  selected.value = pubkey;
  if (menuFor.value && menuFor.value !== pubkey) menuFor.value = "";
}

function toggleMenu(pubkey: string) {
  menuFor.value = menuFor.value === pubkey ? "" : pubkey;
}

function enter() {
  if (selectedAccount.value) emit("enter", selectedAccount.value.pubkey);
}
</script>

<style scoped>
.mini-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 28px 0 36px;
  color: var(--hn-primary);
}

.moon { width: 28px; height: 28px; color: #D9B65C; }

.mini-brand span {
  font-family: var(--hn-font-brand);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.16em;
}

.list-title {
  margin: 0 0 12px;
  color: var(--hn-text-2);
  font-size: 14px;
  font-weight: 600;
}

.account-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.account-row {
  display: flex;
  align-items: center;
  border: 2px solid transparent;
}

.account-row.selected { border-color: var(--hn-primary); }

.account-select {
  display: flex;
  min-width: 0;
  min-height: 72px;
  flex: 1;
  align-items: center;
  gap: 14px;
  padding: 10px 0 10px 14px;
  border: 0;
  background: transparent;
  color: var(--hn-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.account-select:focus-visible { outline: 2px solid var(--hn-primary); outline-offset: -2px; border-radius: 16px; }
.account-select:disabled { cursor: not-allowed; }
.hn-avatar { font-size: 20px; }

.account-text {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.account-text strong {
  overflow: hidden;
  font-size: 17px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-text small { color: var(--hn-text-3); font-size: 13px; }
.more { margin-right: 6px; color: var(--hn-text-2); }

.account-menu {
  display: grid;
  overflow: hidden;
  margin-top: 6px;
}

.menu-action {
  display: grid;
  min-height: 60px;
  gap: 2px;
  padding: 10px 16px;
  border: 0;
  background: transparent;
  color: var(--hn-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu-action + .menu-action { border-top: 1px solid var(--hn-border); }
.menu-action strong { font-size: 15px; font-weight: 600; }
.menu-action small { color: var(--hn-text-3); font-size: 12px; }
.menu-action.danger { background: var(--hn-danger-bg); }
.menu-action.danger strong,
.menu-action.danger small { color: var(--hn-danger); }
.menu-action:disabled { cursor: not-allowed; opacity: 0.6; }
</style>
