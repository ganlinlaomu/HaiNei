import { defineStore } from "pinia";
import { pool } from "@/nostr/relays";
import { getRelaysFromStorage } from "@/nostr/relays";
import { useKeyStore } from "@/stores/keys";
import { genSymHex, symEncryptPackage } from "@/nostr/crypto";
import { logger } from "@/utils/logger";
import { useMessagesStore } from "@/stores/messages";

export const usePostsStore = defineStore("posts", {
  state: () => ({}),

  actions: {
    async publishNip44PerMessage(recipients: string[], plaintext: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");

      let targetPk = key.pkHex;

      if (!Array.isArray(recipients) || recipients.length === 0) {
        throw new Error("recipients 不能为空");
      }
      if (!recipients.includes(targetPk)) {
        recipients = [...recipients, targetPk];
      }

      const symHex = genSymHex();
      const pkg = await symEncryptPackage(symHex, plaintext);

      const keysArr: Array<{ to: string; enc: string }> = [];
      for (const r of recipients) {
        try {
          const enc = await key.nip04Encrypt(r, symHex);
          keysArr.push({ to: r, enc });
        } catch (e) {
          logger.warn("envelope encrypt failed for", r, e);
          keysArr.push({ to: r, enc: "" });
        }
      }

      const payload = { version: "nip-44-per-message-v1", keys: keysArr, pkg };
      const contentStr = JSON.stringify(payload);

      const event: any = {
        kind: 8964,
        pubkey: targetPk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: contentStr
      };

      const signed = await key.signEvent(event);
      const relays = getRelaysFromStorage();

      let relayResults: Array<{ relay: string; ok: boolean; reason?: any; ts?: number }> = [];

      try {
        const pubs: any = await pool.publish(relays, signed);
        if (Array.isArray(pubs)) {
          relayResults = pubs.map((p: any) => ({
            relay: p.relay || p.url,
            ok: !!p.ok,
            reason: p.reason,
            ts: p.ts || Date.now()
          }));
        } else {
          relayResults = relays.map((r) => ({
            relay: r,
            ok: true,
            ts: Date.now()
          }));
        }
      } catch (e) {
        logger.warn("publish failed", e);
        relayResults = relays.map((r) => ({
          relay: r,
          ok: false,
          reason: e,
          ts: Date.now()
        }));
      }

      const out = {
        id: signed.id,
        created_at: signed.created_at,
        sent_at: Date.now(),
        content: contentStr,
        relayResults
      };

      /* =========================
       * ✅ 安全写入 per-account outbox
       * ========================= */
      try {
        const msgs = useMessagesStore();

        // 🔐 显式按当前账号 load
        if (msgs.loadedFor !== targetPk) {
          await msgs.load(targetPk);
        }

        // 🔐 await，避免 PWA 挂起丢数据
        await msgs.addOutbox(out);
      } catch (e) {
        logger.warn("saving outbox to messages store failed", e);
        try {
          const fallbackKey = `nostr_outbox_${targetPk}`;
          const existing = JSON.parse(localStorage.getItem(fallbackKey) || "[]");
          const scopedOutbox = Array.isArray(existing) ? [out, ...existing].slice(0, 500) : [out];
          localStorage.setItem(fallbackKey, JSON.stringify(scopedOutbox));
        } catch {}
      }

      logger.debug("published event", { signed, relayResults });

      return { signed, relayResults };
    }
  }
});
