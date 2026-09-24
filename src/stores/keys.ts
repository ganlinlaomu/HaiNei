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
import { cancelOutgoingWorkForAccount } from "@/nostr/messaging/service";
import { ACCOUNT_STATE_NAMESPACES, fetchAndMaterializeAccountState, syncAccountStateNamespace } from "@/services/accountStateSync";
import { deviceStorage } from "@/services/deviceStorage";
import { warmReadRelaysForSession } from "@/nostr/relayWarmup";
import { startAccountMessageSync, stopAccountMessageSync } from "@/services/accountMessageSync";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import {
  forgetDeviceAccount,
  listDeviceAccounts,
  rememberDeviceAccount,
  type DeviceAccount
} from "@/services/accountRegistry";
import {
  connectWithPomegranate,
  validatePomegranateSigner,
  type HaiNeiRemoteSigner
} from "@/services/pomegranateAuth";

let restoreSessionFlight: Promise<void> | null = null;

function toHex(u8: Uint8Array) {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function genRandomSkHex(): string {
  const arr = crypto.getRandomValues(new Uint8Array(32));
  return toHex(arr);
}
function safeGeneratePrivateKey(): string {
  try { return toHex(nostr.generateSecretKey()); } catch { return genRandomSkHex(); }
}
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
    loginMethod: "" as "google" | "private-key" | "",
    googleSigner: null as HaiNeiRemoteSigner | null,
    accounts: listDeviceAccounts() as DeviceAccount[],
    loginTimestamp: 0 as number, // Unix timestamp when user logged in
    isEncrypted: false as boolean, // Whether the current login uses encrypted storage
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
    /**
     * Check if the current login method supports NIP-04 encryption/decryption
     */
    supportsNip04(): boolean {
      if (!this.isLoggedIn) return false;
      
      if (this.loginMethod === "private-key") return !!this.skHex;
      if (this.loginMethod === "google") return !!this.googleSigner?.nip04;
      return false;
    },
    supportsNip44(): boolean {
      if (!this.isLoggedIn) return false;
      if (this.loginMethod === "private-key") return !!this.skHex;
      if (this.loginMethod === "google") return !!this.googleSigner?.nip44;
      return false;
    }
  },
  actions: {
    async loadAccountStores(pk: string) {
      if (this.pkHex && this.pkHex !== pk) clearAccountScopedCaches(this.pkHex);
      const account = pk.slice(0, 8);
      // Start bootstrap Relay handshakes while the encrypted Worker snapshot is
      // being authenticated and fetched. This opens sockets only; subscriptions
      // remain owned by their existing sync managers.
      warmReadRelaysForSession(this);
      if (this.supportsNip44) {
        try {
          await fetchAndMaterializeAccountState(this);
        } catch (e) {
          console.warn(`[account] encrypted snapshot restore unavailable account=${account}`, e);
        }
      }
      // Settings must load first so no later store can use the previous account's
      // relay or Blossom mirrors during an account switch.
      try {
        await useSettingsStore().load(pk);
      } catch (e) {
        console.error(`[account] settings load failed account=${account}`, e);
      }
      try {
        await useFriendsStore().load(pk);
      } catch (e) {
        console.error(`[account] friends load failed account=${account}`, e);
      }
      try {
        await useFriendshipsStore().load(pk);
      } catch (e) {
        console.error(`[account] friendships load failed account=${account}`, e);
      }
      try {
        await useProfilesStore().load(pk);
      } catch (e) {
        console.error(`[account] profiles load failed account=${account}`, e);
      }
      try {
        await useFeedPreferencesStore().load(pk);
      } catch (e) {
        console.error(`[account] feed preferences load failed account=${account}`, e);
      }
      try {
        await useBookmarksStore().load(pk);
      } catch (e) {
        console.error(`[account] bookmarks load failed account=${account}`, e);
      }
      try {
        await useMessagesStore().load(pk);
      } catch (e) {
        console.error(`[account] messages load failed account=${account}`, e);
      }
      try {
        await useDirectMessagesStore().refresh(pk);
      } catch (e) {
        console.error(`[account] direct messages load failed account=${account}`, e);
      }
      try {
        await useInteractionsStore().load(pk);
      } catch (e) {
        console.error(`[account] interactions load failed account=${account}`, e);
      }
      try {
        await useNotificationsStore().load(pk);
      } catch (e) {
        console.error(`[account] notifications load failed account=${account}`, e);
      }
      // Account-level UI is ready from IndexedDB/D1 now. Relay history repair
      // continues in the session service and checkpoints only after reconciliation.
      void startAccountMessageSync(this)
        .then(async () => {
          if (!this.supportsNip44 || this.pkHex !== pk) return;
          const syncState = await syncedMessageRepository.getSyncState(pk);
          const namespaces = syncState.historyBackfillCompletedAt
            ? ACCOUNT_STATE_NAMESPACES
            : ACCOUNT_STATE_NAMESPACES.filter(namespace => namespace !== "friendships");
          await Promise.allSettled(namespaces.map(namespace => syncAccountStateNamespace(this, namespace)));
        })
        .catch(e => console.warn(`[account] Relay history bootstrap unavailable account=${account}`, e));
    },

    resetAccountStores(currentPk: string) {
      stopAccountMessageSync();
      clearAccountScopedCaches(currentPk);
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

    persistActiveSession() {
      if (!this.pkHex || !this.loginMethod) return;
      deviceStorage.setItem("pkHex", this.pkHex);
      deviceStorage.setItem("loginMethod", this.loginMethod);
      deviceStorage.setItem("loginTimestamp", String(this.loginTimestamp));
      deviceStorage.setItem("isEncrypted", this.isEncrypted ? "true" : "false");
    },

    rememberCurrentAccount() {
      if (!this.pkHex || !this.loginMethod) return;
      this.accounts = rememberDeviceAccount({
        pubkey: this.pkHex,
        authType: this.loginMethod,
        hasEncryptedKey: this.loginMethod === "private-key" && hasEncryptedKey(this.pkHex),
        lastUsedAt: Date.now(),
      });
    },

    clearActiveSession() {
      const currentPk = this.pkHex;
      if (currentPk) this.resetAccountStores(currentPk);
      try { this.googleSigner?.disconnect?.(); } catch {}
      this.skHex = "";
      this.pkHex = "";
      this.loginMethod = "";
      this.googleSigner = null;
      this.loginTimestamp = 0;
      this.isEncrypted = false;
      this.isUnlocked = false;
      for (const key of ["skHex", "pkHex", "loginMethod", "loginTimestamp", "isEncrypted", "bunkerInput", "bunkerClientSecretKey"]) {
        deviceStorage.removeItem(key);
      }
    },

    async loginWithGoogle(expectedPubkey?: string) {
      const connection = await connectWithPomegranate(expectedPubkey);
      await this.loginWithGoogleSigner(connection.pubkey, connection.signer, expectedPubkey);
    },

    async loginWithGoogleSigner(pubkey: string, signer: unknown, expectedPubkey?: string) {
      const previousPubkey = this.pkHex;
      const connection = await validatePomegranateSigner(pubkey, signer, expectedPubkey);
      if (previousPubkey && previousPubkey !== connection.pubkey) this.resetAccountStores(previousPubkey);
      if (this.googleSigner && this.googleSigner !== connection.signer) {
        try { this.googleSigner.disconnect?.(); } catch {}
      }
      this.skHex = "";
      this.pkHex = connection.pubkey;
      this.loginMethod = "google";
      this.googleSigner = connection.signer;
      this.loginTimestamp = Math.floor(Date.now() / 1000);
      this.isEncrypted = false;
      this.isUnlocked = true;
      deviceStorage.removeItem("skHex");
      this.persistActiveSession();
      this.rememberCurrentAccount();
      await this.loadAccountStores(this.pkHex);
      logAccountLogin(previousPubkey, this.pkHex, this.loginMethod);
    },

    async selectRememberedAccount(pubkey: string) {
      const account = listDeviceAccounts().find(item => item.pubkey === pubkey.toLowerCase());
      if (!account) throw new Error("未找到已记住的账号");
      if (account.authType === "google") {
        await this.loginWithGoogle(account.pubkey);
        return "connected" as const;
      }
      if (!account.hasEncryptedKey || !hasEncryptedKey(account.pubkey)) {
        throw new Error("该私钥账号未在本机加密保存，请重新输入私钥");
      }
      if (this.pkHex && this.pkHex !== account.pubkey) this.resetAccountStores(this.pkHex);
      try { this.googleSigner?.disconnect?.(); } catch {}
      this.skHex = "";
      this.pkHex = account.pubkey;
      this.loginMethod = "private-key";
      this.googleSigner = null;
      this.loginTimestamp = Math.floor(Date.now() / 1000);
      this.isEncrypted = true;
      this.isUnlocked = false;
      this.persistActiveSession();
      return "unlock" as const;
    },

    removeAccountFromDevice(pubkey: string) {
      const normalized = pubkey.toLowerCase();
      removeEncryptedKey(normalized);
      this.accounts = forgetDeviceAccount(normalized);
      if (this.pkHex === normalized) this.clearActiveSession();
    },

    /**
     * Unified NIP-04 decryption that works with all login methods
     * @param senderPubHex - The public key of the sender
     * @param ciphertext - The encrypted content
     * @returns Promise<string> - The decrypted plaintext
     */
    async nip04Decrypt(senderPubHex: string, ciphertext: string): Promise<string> {
      if (!this.pkHex || !this.loginMethod) {
        throw new Error("未登录，无法解密消息");
      }

      if (this.loginMethod === "private-key") {
        if (!this.skHex) throw new Error("私钥登录但未找到私钥");
        return nostr.nip04.decrypt(this.skHex, senderPubHex, ciphertext);
      }
      if (this.loginMethod === "google" && this.googleSigner?.nip04) {
        return this.googleSigner.nip04.decrypt(senderPubHex, ciphertext);
      }
      throw new Error("当前登录方式不支持 NIP-04");
    },

    /**
     * Unified NIP-04 encryption that works with all login methods
     * @param recipientPubHex - The public key of the recipient
     * @param plaintext - The plaintext to encrypt
     * @returns Promise<string> - The encrypted ciphertext
     */
    async nip04Encrypt(recipientPubHex: string, plaintext: string): Promise<string> {
      if (!this.pkHex || !this.loginMethod) {
        throw new Error("未登录，无法加密消息");
      }

      if (this.loginMethod === "private-key") {
        if (!this.skHex) throw new Error("私钥登录但未找到私钥");
        return nostr.nip04.encrypt(this.skHex, recipientPubHex, plaintext);
      }
      if (this.loginMethod === "google" && this.googleSigner?.nip04) {
        return this.googleSigner.nip04.encrypt(recipientPubHex, plaintext);
      }
      throw new Error("当前登录方式不支持 NIP-04");
    },

    async nip44Decrypt(senderPubHex: string, ciphertext: string): Promise<string> {
      if (!this.pkHex || !this.loginMethod) throw new Error("未登录，无法解密消息");
      if (this.loginMethod === "private-key") {
        if (!this.skHex) throw new Error("私钥登录但未找到私钥");
        const conversationKey = nostr.nip44.v2.utils.getConversationKey(nostr.utils.hexToBytes(this.skHex), senderPubHex);
        return nostr.nip44.v2.decrypt(ciphertext, conversationKey);
      }
      if (this.loginMethod === "google" && this.googleSigner) {
        return this.googleSigner.nip44.decrypt(senderPubHex, ciphertext);
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
      if (this.loginMethod === "google" && this.googleSigner) {
        return this.googleSigner.nip44.encrypt(recipientPubHex, plaintext);
      }
      throw new Error("当前登录方式不支持 NIP-44");
    },

    /**
     * Unified event signing that works with all login methods
     * @param event - The event template to sign
     * @returns Promise<VerifiedEvent> - The signed event
     */
    async signEvent(event: EventTemplate): Promise<VerifiedEvent> {
      if (!this.pkHex || !this.loginMethod) {
        throw new Error("未登录，无法签名事件");
      }

      if (this.loginMethod === "private-key") {
        if (!this.skHex) throw new Error("私钥登录但未找到私钥");
        return finalizeEvent(event, nostr.utils.hexToBytes(this.skHex));
      }
      if (this.loginMethod === "google" && this.googleSigner) {
        return this.googleSigner.signEvent(event);
      }
      throw new Error(`未知的登录方式: ${this.loginMethod}`);
    },
    async loginWithSk(sk: string) {
      const previousPubkey = this.pkHex;
      if (previousPubkey) this.resetAccountStores(previousPubkey);
      try { this.googleSigner?.disconnect?.(); } catch {}
      this.skHex = sk;
      this.loginMethod = "private-key";
      this.googleSigner = null;
      this.loginTimestamp = Math.floor(Date.now() / 1000);
      this.isEncrypted = false;
      try {
        const pk = await safeGetPublicKey(sk);
        this.pkHex = pk;
        this.isUnlocked = true;
      } catch (e) {
        this.skHex = "";
        this.pkHex = "";
        this.loginMethod = "";
        this.loginTimestamp = 0;
        this.isUnlocked = false;
        throw e;
      }
      deviceStorage.setItem("skHex", this.skHex);
      this.persistActiveSession();
      this.rememberCurrentAccount();
      await this.loadAccountStores(this.pkHex);
      logAccountLogin(previousPubkey, this.pkHex, this.loginMethod);
    },

    /**
     * Login with nsec (NIP-19 encoded private key) or hex private key
     * @param nsecOrHex - nsec1... string or 64-character hex private key
     * @param password - Optional password to encrypt the private key. If provided, key will be encrypted.
     */
    async loginWithNsec(nsecOrHex: string, password?: string) {
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
          storeEncryptedKey(pk, encrypted);
          if (previousPubkey) this.resetAccountStores(previousPubkey);
          try { this.googleSigner?.disconnect?.(); } catch {}
          
          this.skHex = skHex;
          this.pkHex = pk;
          this.loginMethod = "private-key";
          this.googleSigner = null;
          this.isEncrypted = true;
          this.isUnlocked = true;
          this.loginTimestamp = Math.floor(Date.now() / 1000);

          deviceStorage.removeItem("skHex");
          this.persistActiveSession();
          this.rememberCurrentAccount();
        } else {
          // No password, use regular login
          await this.loginWithSk(skHex);
          this.isEncrypted = false;
          this.isUnlocked = true;
          return;
        }

        await this.loadAccountStores(this.pkHex);
        logAccountLogin(previousPubkey, this.pkHex, this.loginMethod);
      } catch (e: any) {
        this.skHex = "";
        this.pkHex = "";
        this.loginMethod = "";
        this.googleSigner = null;
        this.loginTimestamp = 0;
        this.isEncrypted = false;
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
        this.loginTimestamp = Math.floor(Date.now() / 1000);
        this.persistActiveSession();
        this.rememberCurrentAccount();

        await this.loadAccountStores(this.pkHex);
      } catch (e: any) {
        // Don't clear state on failed unlock attempt
        throw e;
      }
    },

    async generateTemp() {
      const sk = safeGeneratePrivateKey();
      await this.loginWithSk(sk);
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

        if (!storedMethod || !pk) {
          this.isRestored = true;
          debugLog("account", "session_restore_success", { pubkeyPrefix: "", loginMethod: "" }, "info");
          return;
        }

        if (storedMethod === "nip07" || storedMethod === "nip46") {
          debugLog("account", "session_restore_failed", {
            pubkeyPrefix: pk,
            loginMethod: storedMethod,
            reason: "stale_auth_type"
          }, "warn");
          this.clearActiveSession();
          this.isRestored = true;
          return;
        }

        const method = storedMethod === "sk" ? "private-key" : storedMethod;
        if (method !== "private-key" && method !== "google") {
          this.clearActiveSession();
          this.isRestored = true;
          return;
        }

        this.loginMethod = method;
        this.pkHex = pk.toLowerCase();
        this.loginTimestamp = parseInt(deviceStorage.getItem("loginTimestamp") || "0", 10) || 0;

        if (method === "google") {
          const connection = await connectWithPomegranate(this.pkHex);
          await this.loginWithGoogleSigner(connection.pubkey, connection.signer, this.pkHex);
          this.isRestored = true;
          return;
        }

        if (isEncrypted) {
          if (!hasEncryptedKey(this.pkHex)) throw new Error("未找到加密的私钥");
          this.isEncrypted = true;
          this.isUnlocked = false;
          this.persistActiveSession();
          this.rememberCurrentAccount();
          this.isRestored = true;
          return;
        }

        const sk = deviceStorage.getItem("skHex");
        if (!sk || await safeGetPublicKey(sk) !== this.pkHex) throw new Error("本地私钥与公钥不匹配");
        this.skHex = sk;
        this.isEncrypted = false;
        this.isUnlocked = true;
        this.persistActiveSession();
        this.rememberCurrentAccount();
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
        this.clearActiveSession();
        this.isRestored = true;
      } finally {
        this.isRestoring = false;
      }
    },
    /**
     * register(options?)
     * - Creates a new keypair (or uses provided skHex) and logs in the user.
     * - This function exists because some parts of the UI call ks.register(...).
     * - If you need server-side registration or additional metadata storage, extend this method.
     */
    async register(skHex?: string) {
      // If caller provided a specific skHex, try to use it, otherwise generate a fresh one.
      const sk = skHex && typeof skHex === "string" && skHex.trim() ? skHex.trim() : safeGeneratePrivateKey();
      await this.loginWithSk(sk);
      // Mark as registered locally (useful if UI expects a flag)
      try {
        const regsRaw = deviceStorage.getItem("nostr_registered_accounts") || "[]";
        const regs = JSON.parse(regsRaw);
        if (!Array.isArray(regs)) regs.length = 0;
        if (!regs.includes(this.pkHex)) {
          regs.push(this.pkHex);
          deviceStorage.setItem("nostr_registered_accounts", JSON.stringify(regs));
        }
      } catch {
        // ignore storage errors
      }
      return { skHex: this.skHex, pkHex: this.pkHex };
    },

    logout() {
      const currentPk = this.pkHex;
      const currentMethod = this.loginMethod;
      debugLog("account", "account_logout", {
        pubkeyPrefix: currentPk,
        loginMethod: currentMethod
      }, "info");

      this.clearActiveSession();
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
