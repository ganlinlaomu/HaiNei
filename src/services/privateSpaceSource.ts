import type { PrivateSpaceRecord } from "@/db/dexie";
import { privateSpaceDisplay } from "@/services/privateSpaceContent";

/** Compatibility adapter: older PR3-A embeds source in body, newer notes use encrypted fields. */
export type PrivateNoteSource = {
  kind: "post" | "dm";
  messageId: string;
  peerPubkey?: string;
  author: string;
  date: string;
};
export function privateNoteSource(
  note: Pick<PrivateSpaceRecord, "kind" | "body"> &
    Partial<Pick<PrivateSpaceRecord, "source" | "attachments">>,
): PrivateNoteSource | null {
  if (note.kind !== "note") return null;
  return privateSpaceDisplay(note).source || null;
}
