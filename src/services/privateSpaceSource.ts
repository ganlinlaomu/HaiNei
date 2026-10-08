import type { PrivateSpaceRecord } from "@/db/dexie";

/** PR3-A embedded source headers in already-encrypted note body. No plaintext index. */
export type PrivateNoteSource = {
  kind: "post" | "dm";
  messageId: string;
  peerPubkey?: string;
  author: string;
  date: string;
};
const MSG = /^[0-9a-f]{64}$/i;
function field(header: string, name: string) {
  const line = header.split("\n").find(line => line.startsWith(name + "："));
  return line?.slice(name.length + 1).trim() || "";
}

export function privateNoteSource(note: Pick<PrivateSpaceRecord, "kind" | "body">): PrivateNoteSource | null {
  if (note.kind !== "note") return null;
  const [first] = note.body.split("\n");
  const kind = first === "来源：海内动态" ? "post"
    : first === "来源：海内普通私信（仅文字）" ? "dm" : null;
  if (!kind) return null;
  const header = note.body.split("\n\n")[0];
  const messageId = field(header, "消息 ID");
  if (!MSG.test(messageId)) return null;
  if (kind === "post") {
    const author = field(header, "作者");
    const date = field(header, "发布时间");
    return { kind, messageId: messageId.toLowerCase(), author, date };
  }
  const peerPubkey = field(header, "对话对象");
  if (!MSG.test(peerPubkey)) return null;
  return {
    kind, messageId: messageId.toLowerCase(),
    peerPubkey: peerPubkey.toLowerCase(),
    author: field(header, "发送者"),
    date: field(header, "发送时间"),
  };
}
