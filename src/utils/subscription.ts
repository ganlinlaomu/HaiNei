import { SimplePool } from "nostr-tools";
import { pool, RELAYS } from "@/nostr/relays";
import { useKeyStore } from "@/stores/keys";
import { nip04 } from "nostr-tools";
import { symDecryptPackage } from "@/nostr/crypto";
import { LEGACY_MESSAGE_KIND } from "@/nostr/messaging/protocol";

/**
 * subscribeToGroupWithAuthors:
 * - groupId: string
 * - authors: string[]  // 推荐填写群内允许发帖的 authors（owner 或成员列表）
 * - onMessage: (evt, plaintext) => void
 *
 * 说明：client 主动发起带 authors 的订阅，relay 会把匹配的事件推给 client。
 *       收到事件后，客户端寻找 payload.keys 中属于自己的那一项并解密。
 */
export function subscribeToGroupWithAuthors(groupId: string, authors: string[], onMessage: (evt: any, plaintext: string) => void) {
  const keyStore = useKeyStore();
  const myPub = keyStore.pkHex;
  const mySk = keyStore.skHex;
  if (!myPub || !mySk) throw new Error("请先加载本地密钥");

  // 构造 filter：kinds + '#g' + authors（authors 可选但强烈推荐）
  const filters: any = { kinds: [LEGACY_MESSAGE_KIND], '#g': [groupId] };
  if (Array.isArray(authors) && authors.length) filters.authors = authors;

  // 使用全局 pool（nostr-tools SimplePool）
  const sub = pool.sub(RELAYS, [filters]);

  sub.on('event', async (evt: any) => {
    try {
      // 1) 解析 payload
      let payload;
      try { payload = JSON.parse(evt.content); } catch { return; }
      if (!payload || !payload.keys || !payload.pkg) return;

      // 2) 查找属于自己的 encrypted sym
      const myEntry = payload.keys.find((k: any) => k.to === myPub);
      if (!myEntry) {
        // 说明这条消息不是发给我的（或者发送者没有把我包含在 keys）
        return;
      }

      // 3) 用 nip04.decrypt 解出 symHex（接收者私钥 + 发送者 pubkey）
      const symHex = await nip04.decrypt(mySk, evt.pubkey, myEntry.enc);

      // 4) 用 symHex 解密 pkg 得到明文
      const plaintext = await symDecryptPackage(symHex, payload.pkg);

      // 5) 回调给 UI 显示（上层负责把明文加密保存到本地 DB）
      onMessage(evt, plaintext);
    } catch (err) {
      console.warn("解密或处理 group event 失败", err);
    }
  });

  return sub; // 调用方可在需要时 sub.unsub()
}
