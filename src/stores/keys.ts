import { clearAccountDeviceData } from "@/services/accountDeviceData";
import { prepareAccountLock } from "@/services/accountLifecycle";
import { flushDeviceWrites } from "@/services/deviceStorage";
import { unlockLocalVault, lockLocalVault, migrateLocalVault } from "@/services/localVault";
import { db, type AccountStateNamespace } from "@/db/dexie";
import { defineStore } from "pinia";
import * as nostr from "nostr-tools";
import { useRouter } from "vue-router";
import { useFriendsStore } from "./friends";
import { useFriendshipsStore } from "./friendships";
import { useMessagesStore } from "./messages";
import { useSettingsStore } from "./settings";
import { useInteractionsStore } from "./interactions";
import { useNotificationsStore } from "./notifications";
import { useProfilesStore } from "./profiles";
import { useFeedPreferencesStore } from "./feedPreferences";
import { useBookmarksStore } from "./bookmarks";
import { useDirectMessagesStore } from "./directMessages";
import { finalizeEvent } from "nostr-tools";
import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  storeEncryptedKey,
  retrieveEncryptedKey,
  removeEncryptedKey,
  hasEncryptedKey
} from "@/utils/crypto";
import { debugLog } from "@/utils/debugLog";
import { clearAccountScopedCaches } from "@/services/nostrCache";
import { clearMemoryImageCache } from "@/utils/imageCache";
import { cancelOutgoingWorkForAccount } from "@/nostr/messaging/service";
import { ACCOUNT_STATE_NAMESPACES, fetchAndMaterializeAccountState, syncAccountStateNamespace } from "@/services/accountStateSync";
import { syncPrivateBookmarkMirror } from "@/services/privateBookmarkMirror";
import { reconcileBookmarkCloudState } from "@/services/bookmarkCloudSync";
import { hydratePrivateDeviceValues, clearPrivateDeviceValues, deviceStorage, putDeviceValue, removeDeviceValue } from "@/services/deviceStorage";
import { warmReadRelaysForSession } from "@/nostr/relayWarmup";
import { startAccountMessageSync, stopAccountMessageSync } from "@/services/accountMessageSync";
import { clearRelaySessionSigner, registerRelaySessionSigner } from "@/services/relaySession";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import {
  forgetDeviceAccount,
  listDeviceAccounts,
  rememberDeviceAccount,
  type DeviceAccount
} from "@/services/accountRegistry";
import {
  enrollBiometricUnlock,
  hasBiometricUnlock,
  removeBiometricUnlock,
  supportsBiometricUnlock,
  unlockPrivateKeyWithBiometric
} from "@/services/biometricUnlock";
import {
  hasDevicePrivateKey,
  removeDevicePrivateKey,
  storeDevicePrivateKey,
  unlockDevicePrivateKey,
} from "@/services/devicePrivateKey";
import type { AccountCredentialMode } from "@/services/accountRegistry";
import {
  hasRemoteSignerCredential,
  removeRemoteSignerCredential,
  storeRemoteSignerCredential,
  unlockRemoteSignerCredential,
} from "@/services/remoteSignerCredential";
import {
  connectRemoteSignerFromInput,
  disconnectRemoteSigner,
  isRemoteSignerConnected,
  isRemoteSignerConnectivityError,
  nip46FeatureEnabled,
  reconnectRemoteSignerFromCredential,
  remoteNip44Decrypt,
  remoteNip44Encrypt,
  remoteSignEvent,
} from "@/services/nip46RemoteSigner";

let restoreSessionFlight: Promise<void> | null = null;
let biometricUnlockFlight: { account: string; promise: Promise<void> } | null = null;
const remoteSignerReconnectFlights = new Map<string, Promise<boolean>>();
const remoteSignerLastReconnectAt = new Map<string, number>();
const REMOTE_SIGNER_PREWARM_COOLDOWN_MS = 15_000;

async function safeGetPublicKey(skHex: string): Promise<string> {
  return nostr.getPublicKey(nostr.utils.hexToBytes(skHex));
}

function logAccountLogin(previousPubkey: string, pubkey: string, loginMethod: string) {
  if (previousPubkey && previousPubkey !== pubkey) {
    clearAccountScopedCaches(previousPubkey);
    debugLog("account", "account_switch", {
      pubkeyPrefix: pubkey,
      previousPubkeyPrefix: previousPubkey,
      loginMethod
    }, "info");
  }
  debugLog("account", "account_login", { pubkeyPrefix: pubkey, loginMethod }, "info");
}

export const useKeyStore = defineStore("keys", {
  state: () => ({
    skHex: "" as string,
    pkHex: "" as string,
    loginMethod: "" as "private-key" | "nip46" | "",
    remoteSignerConnected: false as boolean,
    accounts: listDeviceAccounts() as DeviceAccount[],
    sessionGeneration: 0,
    loginTimestamp: 0 as number, // Unix timestamp when user logged in
    isEncrypted: false as boolean, // Whether the current login uses encrypted storage
    credentialMode: "session" as AccountCredentialMode,
    isUnlocked: false as boolean, // Whether the encrypted key has been unlocked
    isRestoring: false as boolean, // Whether session restoration is in progress
    isRestored: false as boolean // Whether session restoration has completed
  }),
  getters: {
    /**
     * Check if user is logged in with any method
     */
    isLoggedIn(): boolean {
      return !!this.pkHex && !!this.loginMethod;
    },
    supportsNip44(): boolean {
      if (!this.isLoggedIn) return false;
      if (this.loginMethod === "private-key") return !!this.skHex;
      return this.loginMethod === "nip46" && this.isUnlocked;
    }
  },
  actions: {
    async loadAccountStores(pk: string, localVaultSecretHex?: string) {
      const vaultSecretHex = localVaultSecretHex ?? this.skHex;
      if (this.pkHex && this.pkHex !== pk) clearAccountScopedCaches(this.pkHex);
      const generation = ++this.sessionGeneration;
      const isCurrent = () => this.pkHex === pk && this.sessionGeneration === generation && this.isUnlocked;
      await unlockLocalVault(pk, vaultSecretHex, isCurrent);
      if (!isCurrent()) return;
      await migrateLocalVault(db, pk);
      if (!isCurrent()) return;
      await hydratePrivateDeviceValues(pk);
      if (!isCurrent()) return;
      const account = pk.slice(0, 8);
      // Settings must load first so no later store can use the previous account's
      // relay or Blossom mirrors during an account switch.
      try {
        await useSettingsStore().load(pk);
      } catch (e) {
        console.error(`[account] settings load failed account=${account}`, e);
      }
      if (isCurrent()) registerRelaySessionSigner(pk, this.signEvent.bind(this));
      // Warm only after this account's settings have been materialized, otherwise
      // an account switch can briefly reconnect using the previous account's Relay mirror.
      if (!isCurrent()) return;
      warmReadRelaysForSession(this);
      // DM read state, notification read state and friendship authorization are
      // startup-critical. Do not let Relay history race ahead of them: otherwise
      // old history is temporarily counted as unread during a new-device login.
      const criticalStateNamespaces: AccountStateNamespace[] = ["read_state", "notification_state", "friendships"];
      const criticalStateRestore: Promise<{ available: boolean; restored: AccountStateNamespace[] }> = this.supportsNip44
        ? fetchAndMaterializeAccountState(this, criticalStateNamespaces, { onlyNewer: false, isCurrent })
            .catch(error => {
              debugLog("account", "critical_state_restore_unavailable", {
                reason: error instanceof Error ? error.name : "unknown",
              }, "warn");
              return { available: false, restored: [] };
            })
        : Promise.resolve({ available: false, restored: [] });

      const accountLoads: Array<[string, () => unknown | Promise<unknown>]> = [
        ["friends", () => useFriendsStore().load(pk)],
        ["friendships", () => useFriendshipsStore().load(pk)],
        ["profiles", () => useProfilesStore().load(pk)],
        ["feed preferences", () => useFeedPreferencesStore().load(pk)],
        ["bookmarks", () => useBookmarksStore().load(pk)],
        ["messages", () => useMessagesStore().load(pk)],
        ["interactions", () => useInteractionsStore().load(pk)],
        ["notifications", () => useNotificationsStore().load(pk)],
      ];
      // Local-first phase: finish the local IndexedDB/vault restore before
      // returning to Login.vue. Do not make navigation wait for Worker/network
      // account-state restoration.
      await Promise.all(accountLoads.map(async ([label, load]) => {
        try {
          await load();
        } catch (e) {
          console.error(`[account] ${label} load failed account=${account}`, e);
        }
      }));
      if (!isCurrent()) return;
      // Start note sync independently; never delay DM read-state recovery or first paint.
      void import("@/services/privateSpaceSync").then(({ schedulePrivateSpaceSync }) => {
        if (isCurrent()) schedulePrivateSpaceSync(this, 3_000);
      }).catch(() => { /* Local encrypted notes stay available offline. */ });

      // Bookmarks are local-first and have their own durable cloud retry path.
      // Start this independently of DM/Relay history bootstrap.
      if (this.supportsNip44) {
        void (async () => {
          try {
            await reconcileBookmarkCloudState(this, { force: true, isCurrent });
            if (!isCurrent()) return;
            await useBookmarksStore().load(pk, true);
          } catch (error) {
            debugLog("account", "bookmark_cloud_restore_unavailable", {
              reason: error instanceof Error ? error.name : "unknown",
            }, "warn");
          }
          if (!isCurrent()) return;
          try {
            await syncPrivateBookmarkMirror(this);
            if (!isCurrent()) return;
            await useBookmarksStore().load(pk, true);
          } catch (error) {
            debugLog("account", "nip51_bookmark_restore_unavailable", {
              reason: error instanceof Error ? error.name : "unknown",
            }, "warn");
          }
        })();
      }

      const directMessages = useDirectMessagesStore();
      await directMessages.refresh(pk);
      if (!isCurrent()) return;
      // A new device may have an old/empty local read cursor. Hide that
      // provisional unread count until cross-device read_state + friendships
      // have converged, rather than flashing a large false unread badge.
      directMessages.beginReadStateRestore(pk);

      // Network phase: runs after local login has completed. Relay history must
      // still wait for this phase so historical events cannot race an older
      // read cursor or stale friendship authorization.
      void (async () => {
        const criticalState = await criticalStateRestore;
        if (!isCurrent()) return;

        if (criticalState.restored.includes("friendships")) {
          await useFriendshipsStore().reloadFromStorage(pk);
          if (!isCurrent()) return;
        }
        if (criticalState.restored.includes("notification_state")) {
          await useNotificationsStore().refreshSyncedState(pk);
          if (!isCurrent()) return;
        }
        await directMessages.refresh(pk);
        if (!isCurrent()) return;
        directMessages.finishReadStateRestore(pk);

        if (this.supportsNip44) {
          const backgroundNamespaces = ACCOUNT_STATE_NAMESPACES.filter(
            namespace => namespace !== "bookmarks" && !criticalStateNamespaces.includes(namespace)
          );

          void fetchAndMaterializeAccountState(this, backgroundNamespaces, { onlyNewer: true, isCurrent })
            .then(async () => {
              if (!isCurrent()) return;
              await useSettingsStore().load(pk, true);
              if (!isCurrent()) return;
              await Promise.all([useFriendsStore().reloadFromStorage(pk), useProfilesStore().load(pk, true)]);
              if (!isCurrent()) return;
              const { pushEnabledForAccount, syncPushAuthorizationPolicy } = await import("@/services/pushNotifications");
              if (pushEnabledForAccount(pk)) await syncPushAuthorizationPolicy(pk, useFriendshipsStore().records.filter(r => r.state === "accepted").map(r => r.peerPubkey), this.signEvent.bind(this));
            }).catch(() => {
              debugLog("account", "background_restore_unavailable", {}, "warn");
            });
        }

        await startAccountMessageSync(this);
        if (!isCurrent() || !this.supportsNip44) return;
        const syncState = await syncedMessageRepository.getSyncState(pk);
        const namespaces = ACCOUNT_STATE_NAMESPACES.filter(namespace =>
          namespace !== "bookmarks"
          && (syncState.historyBackfillCompletedAt || namespace !== "friendships")
        );
        await Promise.allSettled(namespaces.map(namespace => syncAccountStateNamespace(this, namespace)));
      })().catch(error => {
        if (isCurrent()) directMessages.finishReadStateRestore(pk);
        console.warn(`[account] background account bootstrap unavailable account=${account}`, error instanceof Error ? error.message : "unknown");
      });
    },

    resetAccountStores(currentPk: string) {
      this.sessionGeneration++;
      clearRelaySessionSigner(currentPk);
      void import("@/services/privateSpaceSync").then(({ cancelPrivateSpaceSync }) => {
        cancelPrivateSpaceSync(currentPk.toLowerCase());
      });
      stopAccountMessageSync();
      lockLocalVault(currentPk);
      clearPrivateDeviceValues(currentPk);
      clearAccountScopedCaches(currentPk);
      clearMemoryImageCache(currentPk);
      cancelOutgoingWorkForAccount(currentPk);
      const account = currentPk.slice(0, 8) || "none";
      try {
        useFriendsStore().reset(false);
      } catch (e) {
        console.error(`[account] friends reset failed account=${account}`, e);
      }
      try {
        useFriendshipsStore().reset();
      } catch (e) {
        console.error(`[account] friendships reset failed account=${account}`, e);
      }
      try {
        useProfilesStore().reset();
      } catch (e) {
        console.error(`[account] profiles reset failed account=${account}`, e);
      }
      try {
        useFeedPreferencesStore().reset();
      } catch (e) {
        console.error(`[account] feed preferences reset failed account=${account}`, e);
      }
      try {
        useBookmarksStore().reset();
      } catch (e) {
        console.error(`[account] bookmarks reset failed account=${account}`, e);
      }
      try {
        useMessagesStore().reset(false);
      } catch (e) {
        console.error(`[account] messages reset failed account=${account}`, e);
      }
      try {
        useDirectMessagesStore().reset();
      } catch (e) {
        console.error(`[account] direct messages reset failed account=${account}`, e);
      }
      try {
        useSettingsStore().reset();
      } catch (e) {
        console.error(`[account] settings reset failed account=${account}`, e);
      }
      try {
        useInteractionsStore().reset(false);
      } catch (e) {
        console.error(`[account] interactions reset failed account=${account}`, e);
      }
      try {
        useNotificationsStore().reset(false);
      } catch (e) {
        console.error(`[account] notifications reset failed account=${account}`, e);
      }
    },

    refreshAccounts() {
      this.accounts = listDeviceAccounts();
    },

    async clearPersistedSession() {
      await Promise.all(
        ["skHex", "pkHex", "loginMethod", "loginTimestamp", "isEncrypted", "credentialMode", "bunkerInput", "bunkerClientSecretKey"]
          .map(key => removeDeviceValue(key))
      );
    },

    async persistActiveSession() {
      if (!this.pkHex || !this.loginMethod || !this.isEncrypted) return;
      await Promise.all([
        putDeviceValue("pkHex", this.pkHex),
        putDeviceValue("loginMethod", this.loginMethod),
        putDeviceValue("loginTimestamp", String(this.loginTimestamp)),
        putDeviceValue("isEncrypted", "true"),
        putDeviceValue("credentialMode", this.credentialMode),
        removeDeviceValue("skHex"),
      ]);
    },

    async rememberCurrentAccount() {
      if (!this.pkHex || !this.loginMethod) return;
      if (this.credentialMode === "session") return;
      this.accounts = await rememberDeviceAccount({
        pubkey: this.pkHex,
        authType: this.loginMethod,
        hasEncryptedKey: hasEncryptedKey(this.pkHex),
        credentialMode: this.credentialMode,
        lastUsedAt: Date.now(),
      });
    },

    async clearActiveSession() {
      const currentPk = this.pkHex;
      const currentMethod = this.loginMethod;
      if (currentPk) { await prepareAccountLock(currentPk); await flushDeviceWrites(); this.resetAccountStores(currentPk); }
      if (currentPk && currentMethod === "nip46") {
        await disconnectRemoteSigner(currentPk);
        remoteSignerLastReconnectAt.delete(currentPk);
      }
      this.skHex = "";
      this.pkHex = "";
      this.loginMethod = "";
      this.remoteSignerConnected = false;
      this.loginTimestamp = 0;
      this.isEncrypted = false;
      this.credentialMode = "session";
      this.isUnlocked = false;
      await this.clearPersistedSession();
    },

    async selectRememberedAccount(pubkey: string) {
      const account = listDeviceAccounts().find(item => item.pubkey === pubkey.toLowerCase());
      if (!account) throw new Error("未找到已记住的账号");

      if (account.authType === "nip46") {
        if (!nip46FeatureEnabled()) throw new Error("远程签名器 Beta 当前未启用");
        if (!await hasRemoteSignerCredential(account.pubkey)) throw new Error("远程签名器本机凭据已丢失，请重新连接");
        const credential = await unlockRemoteSignerCredential(account.pubkey);
        if (this.pkHex) { await prepareAccountLock(this.pkHex); await flushDeviceWrites(); this.resetAccountStores(this.pkHex); }
        this.skHex = "";
        this.pkHex = account.pubkey;
        this.loginMethod = "nip46";
        this.remoteSignerConnected = false;
        this.loginTimestamp = Math.floor(Date.now() / 1000);
        this.isEncrypted = true;
        this.isUnlocked = true;
        this.credentialMode = "device";
        await this.persistActiveSession();
        await this.rememberCurrentAccount();
        await this.loadAccountStores(this.pkHex, credential.clientSecretHex);
        void this.reconnectRemoteSigner().catch(() => undefined);
        return "connected" as const;
      }

      if (account.credentialMode === "device") {
        if (!await hasDevicePrivateKey(account.pubkey)) throw new Error("本机登录凭据已丢失，请重新输入私钥");
      } else if (account.credentialMode === "password") {
        if (!hasEncryptedKey(account.pubkey)) throw new Error("本机登录凭据已丢失，请重新输入私钥");
      } else if (account.credentialMode === "passkey") {
        if (!hasBiometricUnlock(account.pubkey)) throw new Error("通行密钥凭据已丢失，请重新输入私钥");
      }
      if (this.pkHex) { await prepareAccountLock(this.pkHex); await flushDeviceWrites(); this.resetAccountStores(this.pkHex); }
      this.skHex = "";
      this.pkHex = account.pubkey;
      this.loginMethod = "private-key";
      this.remoteSignerConnected = false;
      this.loginTimestamp = Math.floor(Date.now() / 1000);
      this.isEncrypted = true;
      this.isUnlocked = false;
      this.credentialMode = account.credentialMode;
      await this.persistActiveSession();
      if (account.credentialMode === "device") {
        await this.unlockWithDeviceCredential();
        return "connected" as const;
      }
      return "unlock" as const;
    },

    hasBiometricUnlock(pubkey?: string) {
      const target = pubkey || this.pkHex;
      return !!target && hasBiometricUnlock(target);
    },

    async supportsBiometricUnlock() {
      return supportsBiometricUnlock();
    },

    async enableBiometricUnlock() {
      if (this.loginMethod !== "private-key") throw new Error("远程签名器账号不使用本机私钥登录保护");
      if (!this.pkHex || !this.skHex || !this.isUnlocked) throw new Error("请先解锁当前账号");
      await enrollBiometricUnlock(this.pkHex, this.skHex);
      if (this.credentialMode === "device") {
        await removeDevicePrivateKey(this.pkHex);
        this.credentialMode = "passkey";
        await this.persistActiveSession();
        await this.rememberCurrentAccount();
      }
    },

    async disableBiometricUnlock(pubkey?: string) {
      const target = pubkey || this.pkHex;
      if (!target) return;
      if (target === this.pkHex && this.credentialMode === "passkey") {
        if (!this.skHex || !this.isUnlocked) throw new Error("请先解锁当前账号");
        await storeDevicePrivateKey(target, this.skHex);
        this.credentialMode = "device";
        await this.persistActiveSession();
        await this.rememberCurrentAccount();
      }
      await removeBiometricUnlock(target);
    },

    async unlockWithBiometric() {
      const account = this.pkHex.toLowerCase();
      if (!account) throw new Error("未找到公钥信息");

      if (biometricUnlockFlight) {
        if (biometricUnlockFlight.account === account) return biometricUnlockFlight.promise;
        throw new Error("通行密钥验证正在进行，请稍后重试");
      }

      const task = (async () => {
        const skHex = await unlockPrivateKeyWithBiometric(account);
        const pk = await safeGetPublicKey(skHex);
        if (pk !== account) throw new Error("通行密钥解锁的私钥与当前账号不匹配");
        if (this.pkHex.toLowerCase() !== account || this.loginMethod !== "private-key") {
          throw new Error("account_session_changed");
        }

        this.skHex = skHex;
        this.isUnlocked = true;
        this.loginTimestamp = Math.floor(Date.now() / 1000);
        await this.persistActiveSession();
        await this.rememberCurrentAccount();
        await this.loadAccountStores(account);
      })();

      biometricUnlockFlight = { account, promise: task };
      try {
        await task;
      } finally {
        if (biometricUnlockFlight?.promise === task) biometricUnlockFlight = null;
      }
    },

    async unlockWithDeviceCredential() {
      if (!this.pkHex) throw new Error("未找到公钥信息");
      const skHex = await unlockDevicePrivateKey(this.pkHex);
      if (await safeGetPublicKey(skHex) !== this.pkHex) throw new Error("本机登录凭据与当前账号不匹配");
      this.skHex = skHex;
      this.isEncrypted = true;
      this.isUnlocked = true;
      this.credentialMode = "device";
      this.loginTimestamp = Math.floor(Date.now() / 1000);
      await this.persistActiveSession();
      await this.rememberCurrentAccount();
      await this.loadAccountStores(this.pkHex);
    },

    async deleteAccountDeviceData(pubkey: string) {
      const account = pubkey.toLowerCase();
      if (this.pkHex === account) await this.clearActiveSession();
      await clearAccountDeviceData(account);
      await this.removeAccountFromDevice(account);
    },

    async removeAccountFromDevice(pubkey: string) {
      const normalized = pubkey.toLowerCase();
      await Promise.all([
        removeEncryptedKey(normalized),
        removeBiometricUnlock(normalized),
        removeDevicePrivateKey(normalized),
        removeRemoteSignerCredential(normalized),
      ]);
      this.accounts = await forgetDeviceAccount(normalized);
      if (this.pkHex === normalized) await this.clearActiveSession();
    },



    async ensureRemoteSignerConnected(options: { force?: boolean; bypassCooldown?: boolean } = {}) {
      if (this.loginMethod !== "nip46" || !this.pkHex || !this.isUnlocked) {
        throw new Error("当前账号不是可用的远程签名器账号");
      }
      if (!nip46FeatureEnabled()) throw new Error("远程签名器 Beta 当前未启用");
      const account = this.pkHex.toLowerCase();

      if (!options.force && this.remoteSignerConnected && isRemoteSignerConnected(account)) return true;
      const existing = remoteSignerReconnectFlights.get(account);
      if (existing) return existing;

      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        this.remoteSignerConnected = false;
        throw new Error("remote_signer_offline");
      }

      const lastReconnectAt = remoteSignerLastReconnectAt.get(account) || 0;
      if (
        !options.bypassCooldown
        && isRemoteSignerConnected(account)
        && Date.now() - lastReconnectAt < REMOTE_SIGNER_PREWARM_COOLDOWN_MS
      ) {
        this.remoteSignerConnected = true;
        return true;
      }

      const task = (async () => {
        const credential = await unlockRemoteSignerCredential(account);
        await reconnectRemoteSignerFromCredential(credential);
        if (this.pkHex.toLowerCase() !== account || this.loginMethod !== "nip46" || !this.isUnlocked) {
          await disconnectRemoteSigner(account).catch(() => undefined);
          throw new Error("account_session_changed");
        }
        this.remoteSignerConnected = true;
        remoteSignerLastReconnectAt.set(account, Date.now());
        debugLog("account", "remote_signer_reconnected", { pubkeyPrefix: account }, "info");
        return true;
      })().catch(error => {
        if (this.pkHex.toLowerCase() === account && this.loginMethod === "nip46") {
          this.remoteSignerConnected = false;
        }
        throw error;
      }).finally(() => {
        if (remoteSignerReconnectFlights.get(account) === task) {
          remoteSignerReconnectFlights.delete(account);
        }
      });

      remoteSignerReconnectFlights.set(account, task);
      return task;
    },

    async prewarmRemoteSigner() {
      if (this.loginMethod !== "nip46" || !this.pkHex || !this.isUnlocked) return false;
      const account = this.pkHex.toLowerCase();
      const lastReconnectAt = remoteSignerLastReconnectAt.get(account) || 0;
      if (
        this.remoteSignerConnected
        && isRemoteSignerConnected(account)
        && Date.now() - lastReconnectAt < REMOTE_SIGNER_PREWARM_COOLDOWN_MS
      ) {
        return true;
      }
      return this.ensureRemoteSignerConnected({ force: true });
    },

    async runRemoteSignerOperation<T>(operation: () => Promise<T>): Promise<T> {
      if (this.loginMethod !== "nip46" || !this.pkHex || !this.isUnlocked) {
        throw new Error("当前账号不是可用的远程签名器账号");
      }
      const account = this.pkHex.toLowerCase();
      try {
        await this.ensureRemoteSignerConnected({ bypassCooldown: true });
      } catch (error) {
        if (isRemoteSignerConnectivityError(error)) {
          throw new Error("远程签名器连接中断，请打开签名器后重试");
        }
        throw error;
      }

      try {
        const result = await operation();
        this.remoteSignerConnected = true;
        return result;
      } catch (error) {
        if (!isRemoteSignerConnectivityError(error)) throw error;
        if (this.pkHex.toLowerCase() !== account || this.loginMethod !== "nip46" || !this.isUnlocked) {
          throw new Error("account_session_changed");
        }

        const message = error instanceof Error ? error.message : "";
        this.remoteSignerConnected = false;
        if (message === "remote_signer_session_changed" && isRemoteSignerConnected(account)) {
          this.remoteSignerConnected = true;
        } else {
          await disconnectRemoteSigner(account).catch(() => undefined);
          await this.ensureRemoteSignerConnected({ force: true, bypassCooldown: true });
        }

        try {
          const result = await operation();
          this.remoteSignerConnected = true;
          return result;
        } catch (retryError) {
          if (isRemoteSignerConnectivityError(retryError)) {
            this.remoteSignerConnected = false;
            throw new Error("远程签名器连接中断，请打开签名器后重试");
          }
          throw retryError;
        }
      }
    },

    async nip44Decrypt(senderPubHex: string, ciphertext: string): Promise<string> {
      if (!this.pkHex || !this.loginMethod) throw new Error("未登录，无法解密消息");
      if (this.loginMethod === "private-key") {
        if (!this.skHex) throw new Error("私钥登录但未找到私钥");
        const conversationKey = nostr.nip44.v2.utils.getConversationKey(nostr.utils.hexToBytes(this.skHex), senderPubHex);
        return nostr.nip44.v2.decrypt(ciphertext, conversationKey);
      }
      if (this.loginMethod === "nip46") {
        const account = this.pkHex;
        return this.runRemoteSignerOperation(() => remoteNip44Decrypt(account, senderPubHex, ciphertext));
      }
      throw new Error("当前登录方式不支持 NIP-44");
    },

    async nip44Encrypt(recipientPubHex: string, plaintext: string): Promise<string> {
      if (!this.pkHex || !this.loginMethod) throw new Error("未登录，无法加密消息");
      if (this.loginMethod === "private-key") {
        if (!this.skHex) throw new Error("私钥登录但未找到私钥");
        const conversationKey = nostr.nip44.v2.utils.getConversationKey(nostr.utils.hexToBytes(this.skHex), recipientPubHex);
        return nostr.nip44.v2.encrypt(plaintext, conversationKey);
      }
      if (this.loginMethod === "nip46") {
        const account = this.pkHex;
        return this.runRemoteSignerOperation(() => remoteNip44Encrypt(account, recipientPubHex, plaintext));
      }
      throw new Error("当前登录方式不支持 NIP-44");
    },

    /**
     * Unified event signing that works with local and remote signing.
     */
    async signEvent(event: EventTemplate): Promise<VerifiedEvent> {
      if (!this.pkHex || !this.loginMethod) throw new Error("未登录，无法签名事件");

      if (this.loginMethod === "private-key") {
        if (!this.skHex) throw new Error("私钥登录但未找到私钥");
        return finalizeEvent(event, nostr.utils.hexToBytes(this.skHex));
      }

      if (this.loginMethod === "nip46") {
        const account = this.pkHex.toLowerCase();
        const signed = await this.runRemoteSignerOperation(() => remoteSignEvent(account, event));
        const unsigned = {
          kind: event.kind,
          content: event.content,
          created_at: event.created_at,
          tags: event.tags,
          pubkey: account,
        };
        const expectedId = nostr.getEventHash(unsigned);
        if (
          signed.pubkey.toLowerCase() !== account
          || signed.kind !== event.kind
          || signed.created_at !== event.created_at
          || signed.content !== event.content
          || JSON.stringify(signed.tags) !== JSON.stringify(event.tags)
          || signed.id !== expectedId
          || !nostr.verifyEvent(signed)
        ) {
          throw new Error("remote_signer_invalid_event");
        }
        return signed;
      }

      throw new Error(`未知的登录方式: ${this.loginMethod}`);
    },

    async loginWithNip46(bunkerInput: string) {
      if (!nip46FeatureEnabled()) throw new Error("远程签名器 Beta 当前未启用");
      const previousPubkey = this.pkHex;
      const previousMethod = this.loginMethod;
      let connectedAccount = "";
      try {
        const credential = await connectRemoteSignerFromInput(bunkerInput);
        connectedAccount = credential.accountPubkey;
        await storeRemoteSignerCredential(credential);
        if (previousPubkey) {
          await prepareAccountLock(previousPubkey);
          await flushDeviceWrites();
          this.resetAccountStores(previousPubkey);
          if (previousMethod === "nip46") await disconnectRemoteSigner(previousPubkey);
        }
        await this.clearPersistedSession();

        this.skHex = "";
        this.pkHex = credential.accountPubkey;
        this.loginMethod = "nip46";
        this.remoteSignerConnected = isRemoteSignerConnected(credential.accountPubkey);
        if (this.remoteSignerConnected) remoteSignerLastReconnectAt.set(credential.accountPubkey, Date.now());
        this.loginTimestamp = Math.floor(Date.now() / 1000);
        this.isEncrypted = true;
        this.credentialMode = "device";
        this.isUnlocked = true;

        await this.persistActiveSession();
        await this.rememberCurrentAccount();
        await this.loadAccountStores(this.pkHex, credential.clientSecretHex);
        logAccountLogin(previousPubkey, this.pkHex, this.loginMethod);
      } catch (error) {
        if (connectedAccount) await disconnectRemoteSigner(connectedAccount).catch(() => undefined);
        this.skHex = "";
        this.pkHex = "";
        this.loginMethod = "";
        this.remoteSignerConnected = false;
        this.loginTimestamp = 0;
        this.isEncrypted = false;
        this.credentialMode = "session";
        this.isUnlocked = false;
        throw error;
      }
    },

    async reconnectRemoteSigner() {
      return this.ensureRemoteSignerConnected({ force: true, bypassCooldown: true });
    },
    async loginWithSk(sk: string) {
      const previousPubkey = this.pkHex;
      if (previousPubkey) { await prepareAccountLock(previousPubkey); await flushDeviceWrites(); this.resetAccountStores(previousPubkey); }
      await this.clearPersistedSession();

      this.skHex = sk;
      this.loginMethod = "private-key";
      this.loginTimestamp = Math.floor(Date.now() / 1000);
      this.isEncrypted = false;
      this.credentialMode = "session";
      try {
        this.pkHex = await safeGetPublicKey(sk);
        this.isUnlocked = true;
        await this.rememberCurrentAccount();
        await this.loadAccountStores(this.pkHex);
        logAccountLogin(previousPubkey, this.pkHex, this.loginMethod);
      } catch (e) {
        this.skHex = "";
        this.pkHex = "";
        this.loginMethod = "";
        this.loginTimestamp = 0;
        this.isUnlocked = false;
        throw e;
      }
    },

    /**
     * Login with nsec (NIP-19 encoded private key) or hex private key
     * @param nsecOrHex - nsec1... string or 64-character hex private key
     * @param password - Optional password to encrypt the private key. If provided, key will be encrypted.
     */
    async loginWithNsec(nsecOrHex: string, password?: string, keepOnDevice = true) {
      const previousPubkey = this.pkHex;
      try {
        let skHex: string;

        // Try to decode as nsec first
        if (nsecOrHex.startsWith("nsec1")) {
          try {
            const decoded = nostr.nip19.decode(nsecOrHex);
            if (decoded.type !== "nsec") {
              throw new Error("输入的不是有效的 nsec 私钥");
            }
            // Convert Uint8Array to hex
            skHex = Array.from(decoded.data as Uint8Array)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
          } catch (e: any) {
            throw new Error(`无效的 nsec 格式: ${e.message || e}`);
          }
        } else if (/^[0-9a-fA-F]{64}$/.test(nsecOrHex)) {
          // Valid hex private key
          skHex = nsecOrHex.toLowerCase();
        } else {
          throw new Error("请输入有效的 nsec 私钥或 64 位十六进制私钥");
        }

        // Get public key
        const pk = await safeGetPublicKey(skHex);

        // If password provided, encrypt and store
        if (password && password.trim()) {
          const encrypted = await encryptPrivateKey(skHex, password);
          await storeEncryptedKey(pk, encrypted);
          await removeDevicePrivateKey(pk);
          if (previousPubkey) { await prepareAccountLock(previousPubkey); await flushDeviceWrites(); this.resetAccountStores(previousPubkey); }
          
          this.skHex = skHex;
          this.pkHex = pk;
          this.loginMethod = "private-key";
          this.isEncrypted = true;
          this.credentialMode = "password";
          this.isUnlocked = true;
          this.loginTimestamp = Math.floor(Date.now() / 1000);

          await this.persistActiveSession();
          await this.rememberCurrentAccount();
        } else if (keepOnDevice) {
          await storeDevicePrivateKey(pk, skHex);
          await Promise.all([removeEncryptedKey(pk), removeBiometricUnlock(pk)]);
          if (previousPubkey) { await prepareAccountLock(previousPubkey); await flushDeviceWrites(); this.resetAccountStores(previousPubkey); }
          this.skHex = skHex;
          this.pkHex = pk;
          this.loginMethod = "private-key";
          this.isEncrypted = true;
          this.isUnlocked = true;
          this.credentialMode = "device";
          this.loginTimestamp = Math.floor(Date.now() / 1000);
          await this.persistActiveSession();
          await this.rememberCurrentAccount();
        } else {
          await Promise.all([
            removeEncryptedKey(pk),
            removeBiometricUnlock(pk),
            removeDevicePrivateKey(pk),
          ]);
          this.accounts = await forgetDeviceAccount(pk);
          await this.loginWithSk(skHex);
          return;
        }

        await this.loadAccountStores(this.pkHex);
        logAccountLogin(previousPubkey, this.pkHex, this.loginMethod);
      } catch (e: any) {
        this.skHex = "";
        this.pkHex = "";
        this.loginMethod = "";
        this.loginTimestamp = 0;
        this.isEncrypted = false;
        this.credentialMode = "session";
        this.isUnlocked = false;
        throw e;
      }
    },

    /**
     * Unlock an encrypted private key with password
     * @param password - The password to decrypt the private key
     */
    async unlockWithPassword(password: string) {
      if (!this.pkHex) {
        throw new Error("未找到公钥信息");
      }

      if (!hasEncryptedKey(this.pkHex)) {
        throw new Error("未找到加密的私钥");
      }

      const encrypted = retrieveEncryptedKey(this.pkHex);
      if (!encrypted) {
        throw new Error("无法读取加密数据");
      }

      try {
        const skHex = await decryptPrivateKey(encrypted, password);
        
        // Verify the decrypted key matches the public key
        const pk = await safeGetPublicKey(skHex);
        if (pk !== this.pkHex) {
          throw new Error("解密的私钥与公钥不匹配");
        }

        this.skHex = skHex;
        this.isUnlocked = true;
        this.credentialMode = "password";
        this.loginTimestamp = Math.floor(Date.now() / 1000);
        await this.persistActiveSession();
        await this.rememberCurrentAccount();

        await this.loadAccountStores(this.pkHex);
      } catch (e: any) {
        // Don't clear state on failed unlock attempt
        throw e;
      }
    },

    
    restoreSession() {
      if (this.isRestored) return Promise.resolve();
      if (restoreSessionFlight) return restoreSessionFlight;
      restoreSessionFlight = this.restoreSessionOnce().finally(() => {
        restoreSessionFlight = null;
      });
      return restoreSessionFlight;
    },

    async restoreSessionOnce() {
      this.isRestoring = true;
      debugLog("account", "session_restore_start", {}, "info");
      try {
        this.refreshAccounts();
        const storedMethod = deviceStorage.getItem("loginMethod");
        const pk = deviceStorage.getItem("pkHex");
        const isEncrypted = deviceStorage.getItem("isEncrypted") === "true";
        const storedCredentialMode = deviceStorage.getItem("credentialMode") as AccountCredentialMode | null;

        if (!storedMethod || !pk) {
          this.isRestored = true;
          debugLog("account", "session_restore_success", { pubkeyPrefix: "", loginMethod: "" }, "info");
          return;
        }

        if (storedMethod === "nip07") {
          debugLog("account", "session_restore_failed", {
            pubkeyPrefix: pk,
            loginMethod: storedMethod,
            reason: "stale_auth_type"
          }, "warn");
          await this.clearActiveSession();
          this.isRestored = true;
          return;
        }

        if (storedMethod === "nip46") {
          if (!nip46FeatureEnabled() || !await hasRemoteSignerCredential(pk)) {
            debugLog("account", "session_restore_failed", {
              pubkeyPrefix: pk,
              loginMethod: storedMethod,
              reason: nip46FeatureEnabled() ? "missing_remote_signer_credential" : "remote_signer_disabled"
            }, "warn");
            await this.clearActiveSession();
            this.isRestored = true;
            return;
          }
          const credential = await unlockRemoteSignerCredential(pk);
          this.skHex = "";
          this.pkHex = pk.toLowerCase();
          this.loginMethod = "nip46";
          this.remoteSignerConnected = false;
          this.loginTimestamp = parseInt(deviceStorage.getItem("loginTimestamp") || "0", 10) || 0;
          this.isEncrypted = true;
          this.credentialMode = "device";
          this.isUnlocked = true;
          await this.persistActiveSession();
          await this.rememberCurrentAccount();
          await this.loadAccountStores(this.pkHex, credential.clientSecretHex);
          this.isRestored = true;
          debugLog("account", "session_restore_success", {
            pubkeyPrefix: this.pkHex,
            loginMethod: this.loginMethod,
            remoteSignerConnected: false
          }, "info");
          void this.reconnectRemoteSigner().catch(error => {
            debugLog("account", "remote_signer_reconnect_unavailable", {
              pubkeyPrefix: this.pkHex,
              reason: error instanceof Error ? error.name : "unknown"
            }, "warn");
          });
          return;
        }

        const method = storedMethod === "sk" ? "private-key" : storedMethod;
        if (method !== "private-key") {
          await this.clearActiveSession();
          this.isRestored = true;
          return;
        }

        this.loginMethod = method;
        this.pkHex = pk.toLowerCase();
        this.loginTimestamp = parseInt(deviceStorage.getItem("loginTimestamp") || "0", 10) || 0;

        if (isEncrypted) {
          const credentialMode = storedCredentialMode || (hasEncryptedKey(this.pkHex) ? "password" : "session");
          if (credentialMode === "device") {
            this.credentialMode = "device";
            await this.unlockWithDeviceCredential();
            this.isRestored = true;
            debugLog("account", "session_restore_success", { pubkeyPrefix: this.pkHex, loginMethod: method }, "info");
            return;
          }
          if (credentialMode === "password" && !hasEncryptedKey(this.pkHex)) throw new Error("未找到加密的私钥");
          if (credentialMode === "passkey" && !hasBiometricUnlock(this.pkHex)) throw new Error("未找到通行密钥凭据");
          this.isEncrypted = true;
          this.isUnlocked = false;
          this.credentialMode = credentialMode;
          await this.persistActiveSession();
          await this.rememberCurrentAccount();
          this.isRestored = true;
          return;
        }

        const sk = deviceStorage.getItem("skHex");
        if (!sk || await safeGetPublicKey(sk) !== this.pkHex) throw new Error("本地私钥与公钥不匹配");
        this.skHex = sk;
        this.isEncrypted = false;
        this.credentialMode = "session";
        this.isUnlocked = true;
        await this.clearPersistedSession();
        await this.rememberCurrentAccount();
        await this.loadAccountStores(this.pkHex);
        this.isRestored = true;
        debugLog("account", "session_restore_success", { pubkeyPrefix: this.pkHex, loginMethod: method }, "info");
      } catch (error) {
        console.error("[keys] restoreSession error", error);
        debugLog("account", "session_restore_failed", {
          pubkeyPrefix: this.pkHex,
          loginMethod: this.loginMethod,
          reason: error instanceof Error ? error.name : "restore_failed"
        }, "error");
        await this.clearActiveSession();
        this.isRestored = true;
      } finally {
        this.isRestoring = false;
      }
    },

    async logout() {
      const currentPk = this.pkHex;
      const currentMethod = this.loginMethod;
      debugLog("account", "account_logout", {
        pubkeyPrefix: currentPk,
        loginMethod: currentMethod
      }, "info");

      await this.clearActiveSession();
      this.refreshAccounts();
      // navigate to login
      try {
        const router = useRouter();
        router.push("/login");
      } catch {
        window.location.href = "/#/login";
      }
    }
  }
});
