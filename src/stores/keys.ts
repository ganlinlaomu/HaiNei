import { defineStore } from "pinia";
import * as nostr from "nostr-tools";
import { useRouter } from "vue-router";
import { useFriendsStore } from "./friends";
import { useMessagesStore } from "./messages";
import { useSettingsStore } from "./settings";
import { useInteractionsStore } from "./interactions";
import { useNotificationsStore } from "./notifications";
import type { WindowNostr } from "nostr-tools/lib/types/nip07";
import { BunkerSigner, type BunkerPointer, parseBunkerInput } from "nostr-tools/nip46";
import { finalizeEvent } from "nostr-tools";
import type { EventTemplate, VerifiedEvent } from "nostr-tools/lib/types/core";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  storeEncryptedKey,
  retrieveEncryptedKey,
  removeEncryptedKey,
  hasEncryptedKey,
  uint8ArrayToBase64,
  base64ToUint8Array,
  type EncryptedData
} from "@/utils/crypto";

/**
 * keys store with robust nostr-tools feature detection.
 * - Supports NIP-07 (browser extension) login
 * - Supports NIP-46 (bunker/remote signer) login
 * - Adds `register()` to create/register an account (wrapper around generateTemp/loginWithSk).
 * - Keeps generate/login/logout functionality resilient to different nostr-tools builds.
 */

// Extend window with nostr property
declare global {
  interface Window {
    nostr?: WindowNostr;
  }
}

function toHex(u8: Uint8Array) {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function genRandomSkHex(): string {
  const arr = crypto.getRandomValues(new Uint8Array(32));
  return toHex(arr);
}
function safeGeneratePrivateKey(): string {
  if (nostr && typeof (nostr as any).generatePrivateKey === "function") {
    try { return (nostr as any).generatePrivateKey(); } catch {}
  }
  return genRandomSkHex();
}
async function safeGetPublicKey(skHex: string): Promise<string> {
  if (nostr && typeof (nostr as any).getPublicKey === "function") {
    try { return (nostr as any).getPublicKey(skHex); } catch (e) { throw e; }
  }
  if (nostr && (nostr as any).secp256k1 && typeof (nostr as any).secp256k1.getPublicKey === "function") {
    try { return (nostr as any).secp256k1.getPublicKey(skHex); } catch (e) { throw e; }
  }
  throw new Error("当前 nostr-tools 构建不支持从私钥派生公钥，请提供兼容的 nostr-tools，或在登录时输入公钥。");
}

export const useKeyStore = defineStore("keys", {
  state: () => ({
    skHex: "" as string,
    pkHex: "" as string,
    loginMethod: "" as "sk" | "nip07" | "nip46" | "",
    bunkerSigner: null as BunkerSigner | null,
    loginTimestamp: 0 as number, // Unix timestamp when user logged in
    isEncrypted: false as boolean, // Whether the current login uses encrypted storage
    isUnlocked: false as boolean, // Whether the encrypted key has been unlocked
    bunkerClientSecretKey: null as Uint8Array | null, // Persisted bunker client secret for reconnection
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
      
      switch (this.loginMethod) {
        case "sk":
          return !!this.skHex;
        case "nip07":
          return !!(window.nostr?.nip04?.encrypt && window.nostr?.nip04?.decrypt);
        case "nip46":
          return !!this.bunkerSigner;
        default:
          return false;
      }
    }
  },
  actions: {
    async loadAccountStores(pk: string) {
      const account = pk.slice(0, 8);
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
        await useMessagesStore().load(pk);
      } catch (e) {
        console.error(`[account] messages load failed account=${account}`, e);
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
    },

    resetAccountStores(currentPk: string) {
      const account = currentPk.slice(0, 8) || "none";
      try {
        useFriendsStore().reset(false);
      } catch (e) {
        console.error(`[account] friends reset failed account=${account}`, e);
      }
      try {
        useMessagesStore().reset(false);
      } catch (e) {
        console.error(`[account] messages reset failed account=${account}`, e);
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

      switch (this.loginMethod) {
        case "sk":
          // Direct decryption with private key
          if (!this.skHex) {
            throw new Error("私钥登录但未找到私钥");
          }
          return await nostr.nip04.decrypt(this.skHex, senderPubHex, ciphertext);

        case "nip07":
          // Use browser extension
          if (!window.nostr?.nip04?.decrypt) {
            throw new Error("浏览器插件不支持 NIP-04 解密");
          }
          return await window.nostr.nip04.decrypt(senderPubHex, ciphertext);

        case "nip46":
          // Use bunker signer
          if (!this.bunkerSigner) {
            throw new Error("Bunker 签名器未初始化");
          }
          return await this.bunkerSigner.nip04Decrypt(senderPubHex, ciphertext);

        default:
          throw new Error(`未知的登录方式: ${this.loginMethod}`);
      }
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

      switch (this.loginMethod) {
        case "sk":
          // Direct encryption with private key
          if (!this.skHex) {
            throw new Error("私钥登录但未找到私钥");
          }
          return await nostr.nip04.encrypt(this.skHex, recipientPubHex, plaintext);

        case "nip07":
          // Use browser extension
          if (!window.nostr?.nip04?.encrypt) {
            throw new Error("浏览器插件不支持 NIP-04 加密");
          }
          return await window.nostr.nip04.encrypt(recipientPubHex, plaintext);

        case "nip46":
          // Use bunker signer
          if (!this.bunkerSigner) {
            throw new Error("Bunker 签名器未初始化");
          }
          return await this.bunkerSigner.nip04Encrypt(recipientPubHex, plaintext);

        default:
          throw new Error(`未知的登录方式: ${this.loginMethod}`);
      }
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

      switch (this.loginMethod) {
        case "sk":
          // Direct signing with private key
          if (!this.skHex) {
            throw new Error("私钥登录但未找到私钥");
          }
          return finalizeEvent(event, this.skHex);

        case "nip07":
          // Use browser extension
          if (!window.nostr?.signEvent) {
            throw new Error("浏览器插件不支持事件签名");
          }
          return await window.nostr.signEvent(event);

        case "nip46":
          // Use bunker signer
          if (!this.bunkerSigner) {
            throw new Error("Bunker 签名器未初始化");
          }
          return await this.bunkerSigner.signEvent(event);

        default:
          throw new Error(`未知的登录方式: ${this.loginMethod}`);
      }
    },
    async loginWithSk(sk: string) {
      this.skHex = sk;
      this.loginMethod = "sk";
      this.loginTimestamp = Math.floor(Date.now() / 1000);
      try {
        const pk = await safeGetPublicKey(sk);
        this.pkHex = pk;
      } catch (e) {
        this.skHex = "";
        this.pkHex = "";
        this.loginMethod = "";
        this.loginTimestamp = 0;
        throw e;
      }
      try {
        localStorage.setItem("skHex", this.skHex);
        localStorage.setItem("pkHex", this.pkHex);
        localStorage.setItem("loginMethod", this.loginMethod);
        localStorage.setItem("loginTimestamp", String(this.loginTimestamp));
      } catch {}
      await this.loadAccountStores(this.pkHex);
    },

    /**
     * Login with NIP-07 browser extension
     */
    async loginWithExtension() {
      if (!window.nostr) {
        throw new Error("未检测到 Nostr 浏览器插件。请安装如 Alby, nos2x 等插件。");
      }

      try {
        const pk = await window.nostr.getPublicKey();
        this.pkHex = pk;
        this.skHex = ""; // No private key with extension
        this.loginMethod = "nip07";
        this.loginTimestamp = Math.floor(Date.now() / 1000);

        try {
          localStorage.setItem("pkHex", this.pkHex);
          localStorage.setItem("loginMethod", this.loginMethod);
          localStorage.setItem("loginTimestamp", String(this.loginTimestamp));
          localStorage.removeItem("skHex"); // Ensure no private key is stored
        } catch {}

        await this.loadAccountStores(this.pkHex);
      } catch (e: any) {
        this.pkHex = "";
        this.loginMethod = "";
        this.loginTimestamp = 0;
        throw new Error(`浏览器插件登录失败: ${e.message || e}`);
      }
    },

    /**
     * Login with NIP-46 bunker/remote signer
     * @param bunkerInput - bunker:// URL or name@domain NIP-05
     */
    async loginWithBunker(bunkerInput: string) {
      try {
        // Parse bunker input (bunker:// URL or NIP-05)
        const bunkerPointer = await parseBunkerInput(bunkerInput.trim());
        
        if (!bunkerPointer) {
          throw new Error("无效的 bunker URL 或 NIP-05 地址。请检查输入格式。");
        }

        // Try to restore existing client secret key, or generate a new one
        let clientSecretKey: Uint8Array;
        const storedKey = localStorage.getItem("bunkerClientSecretKey");
        if (storedKey) {
          try {
            // Restore from base64
            clientSecretKey = base64ToUint8Array(storedKey);
          } catch {
            // If restore fails, generate new
            clientSecretKey = crypto.getRandomValues(new Uint8Array(32));
          }
        } else {
          clientSecretKey = crypto.getRandomValues(new Uint8Array(32));
        }
        
        // Create bunker signer with timeout handling
        const signer = BunkerSigner.fromBunker(clientSecretKey, bunkerPointer, {
          onauth: (url: string) => {
            console.log("Bunker authentication required:", url);
          }
        });
        
        // Connect to the bunker with timeout
        try {
          await signer.sendRequest("connect", []);
        } catch (connectError: any) {
          throw new Error(`无法连接到远程签名器。请确保 bunker 服务可用并且您已授权连接。详情: ${connectError.message || connectError}`);
        }
        
        // Get public key from bunker
        const pk = await signer.getPublicKey();
        
        this.pkHex = pk;
        this.skHex = ""; // No private key with bunker
        this.loginMethod = "nip46";
        this.loginTimestamp = Math.floor(Date.now() / 1000);
        this.bunkerSigner = signer;
        this.bunkerClientSecretKey = clientSecretKey;

        try {
          localStorage.setItem("pkHex", this.pkHex);
          localStorage.setItem("loginMethod", this.loginMethod);
          localStorage.setItem("loginTimestamp", String(this.loginTimestamp));
          localStorage.setItem("bunkerInput", bunkerInput);
          // Store client secret key for reconnection (base64 encoded)
          const keyBase64 = uint8ArrayToBase64(clientSecretKey);
          localStorage.setItem("bunkerClientSecretKey", keyBase64);
          localStorage.removeItem("skHex"); // Ensure no private key is stored
        } catch {}

        await this.loadAccountStores(this.pkHex);
      } catch (e: any) {
        this.pkHex = "";
        this.loginMethod = "";
        this.loginTimestamp = 0;
        this.bunkerSigner = null;
        
        // Re-throw with a user-friendly message if not already handled
        if (e.message && e.message.includes("无法连接")) {
          throw e;
        }
        throw new Error(`Bunker 登录失败: ${e.message || e}`);
      }
    },

    /**
     * Login with nsec (NIP-19 encoded private key) or hex private key
     * @param nsecOrHex - nsec1... string or 64-character hex private key
     * @param password - Optional password to encrypt the private key. If provided, key will be encrypted.
     */
    async loginWithNsec(nsecOrHex: string, password?: string) {
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
          
          this.skHex = skHex;
          this.pkHex = pk;
          this.loginMethod = "sk";
          this.isEncrypted = true;
          this.isUnlocked = true;
          this.loginTimestamp = Math.floor(Date.now() / 1000);

          // Store metadata
          try {
            localStorage.setItem("pkHex", this.pkHex);
            localStorage.setItem("loginMethod", this.loginMethod);
            localStorage.setItem("loginTimestamp", String(this.loginTimestamp));
            localStorage.setItem("isEncrypted", "true");
            // Don't store skHex in plain text
            localStorage.removeItem("skHex");
          } catch {}
        } else {
          // No password, use regular login
          await this.loginWithSk(skHex);
          this.isEncrypted = false;
          this.isUnlocked = true;
          return;
        }

        await this.loadAccountStores(this.pkHex);
      } catch (e: any) {
        this.skHex = "";
        this.pkHex = "";
        this.loginMethod = "";
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
    
    async restoreSession() {
      this.isRestoring = true;
      try {
        const method = localStorage.getItem("loginMethod") as
          | "sk"
          | "nip07"
          | "nip46"
          | null;

        const pk = localStorage.getItem("pkHex");
        const isEncrypted = localStorage.getItem("isEncrypted") === "true";

        if (!method || !pk) {
          this.isRestored = true;
          return;
        }

      this.loginMethod = method;
      this.pkHex = pk;
      const loginTimestamp = localStorage.getItem("loginTimestamp") || "0";
      this.loginTimestamp = parseInt(loginTimestamp, 10) || 0;

      if (method === "nip46") {
        const bunkerInput = localStorage.getItem("bunkerInput");
        if (bunkerInput) {
          try {
            const bunkerPointer = await parseBunkerInput(bunkerInput);
            
            // Try to restore the client secret key
            let clientSecretKey: Uint8Array;
            const storedKey = localStorage.getItem("bunkerClientSecretKey");
            if (storedKey) {
              try {
                clientSecretKey = base64ToUint8Array(storedKey);
              } catch {
                console.warn("[keys] Failed to restore bunker client secret, generating new");
                clientSecretKey = crypto.getRandomValues(new Uint8Array(32));
              }
            } else {
              clientSecretKey = crypto.getRandomValues(new Uint8Array(32));
            }

            const signer = BunkerSigner.fromBunker(
              clientSecretKey,
              bunkerPointer
            );

            // Connect with timeout (properly cleanup timeout on success)
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            const connectPromise = signer.sendRequest("connect", []);
            const timeoutPromise = new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error("Bunker connection timeout")), 10000);
            });
            
            try {
              await Promise.race([connectPromise, timeoutPromise]);
              // Clear timeout if connect succeeds
              if (timeoutId !== null) clearTimeout(timeoutId);
            } catch (e) {
              // Clear timeout if connect fails
              if (timeoutId !== null) clearTimeout(timeoutId);
              throw e;
            }

            this.bunkerSigner = signer;
            this.bunkerClientSecretKey = clientSecretKey;
          } catch (e) {
            console.error("[keys] bunker restore failed", e);
            this.logout();
            this.isRestored = true;
            return;
          }
        } else {
          this.logout();
          this.isRestored = true;
          return;
        }
      }

      if (method === "sk") {
        if (isEncrypted) {
          // Encrypted private key - need to unlock
          this.isEncrypted = true;
          this.isUnlocked = false;
          // Don't load stores yet, wait for unlock
          this.isRestored = true;
          return;
        } else {
          // Plain text private key
          const sk = localStorage.getItem("skHex");
          if (sk) {
            this.skHex = sk;
            this.isEncrypted = false;
            this.isUnlocked = true;
          }
        }
      }

      // Load account-scoped stores for non-encrypted or successfully restored sessions
      if (method === "nip07" || method === "nip46" || (method === "sk" && !isEncrypted)) {
        await this.loadAccountStores(this.pkHex);
      }
      
      this.isRestored = true;
    } catch (error) {
      console.error("[keys] restoreSession error", error);
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
        const regsRaw = localStorage.getItem("nostr_registered_accounts") || "[]";
        const regs = JSON.parse(regsRaw);
        if (!Array.isArray(regs)) regs.length = 0;
        if (!regs.includes(this.pkHex)) {
          regs.push(this.pkHex);
          localStorage.setItem("nostr_registered_accounts", JSON.stringify(regs));
        }
      } catch {
        // ignore storage errors
      }
      return { skHex: this.skHex, pkHex: this.pkHex };
    },

    logout() {
      const currentPk = this.pkHex;

      // Stop and clear account-scoped runtime state while the account context exists.
      this.resetAccountStores(currentPk);

      // Close bunker signer before clearing the key/login state.
      if (this.bunkerSigner) {
        try {
          this.bunkerSigner.close();
        } catch (e) {
          console.error(`[account] bunker close failed account=${currentPk.slice(0, 8) || "none"}`, e);
        }
        this.bunkerSigner = null;
      }

      this.skHex = "";
      this.pkHex = "";
      this.loginMethod = "";
      this.loginTimestamp = 0;
      this.isEncrypted = false;
      this.isUnlocked = false;
      
      this.bunkerClientSecretKey = null;
      
      try {
        localStorage.removeItem("skHex");
        localStorage.removeItem("pkHex");
        localStorage.removeItem("loginMethod");
        localStorage.removeItem("loginTimestamp");
        localStorage.removeItem("bunkerInput");
        localStorage.removeItem("bunkerClientSecretKey");
        localStorage.removeItem("isEncrypted");
        // Note: We don't remove the encrypted key itself, user can unlock again
      } catch (e) {
        console.error(`[account] login metadata cleanup failed account=${currentPk.slice(0, 8) || "none"}`, e);
      }
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
