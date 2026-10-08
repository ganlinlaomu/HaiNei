import type { CanonicalMessage } from "./protocol";

export const DM_BURN_CONTROL_TYPE = "hainei-dm-burn";
const ID = /^[0-9a-f]{64}$/i;

export function burnControlTags(): string[][] {
  return [["t", DM_BURN_CONTROL_TYPE]];
}

export function isBurnControl(message: Pick<CanonicalMessage, "tags">) {
  return message.tags.some(tag => tag[0] === "t" && tag[1] === DM_BURN_CONTROL_TYPE);
}

export function serializeBurnControl(messageId: string) {
  if (!ID.test(messageId)) throw new Error("invalid_burn_target");
  return JSON.stringify({ type: DM_BURN_CONTROL_TYPE, messageId: messageId.toLowerCase() });
}

/** Recognize historical control payloads even when their tags were lost on
 * local restore. Detection does not authorize a deletion operation. */
export function decodeBurnControlPayload(plaintext?: string): string | null {
  if (!plaintext) return null;
  try {
    const obj = JSON.parse(plaintext) as { type?: unknown; messageId?: unknown } | null;
    if (!obj || obj.type !== DM_BURN_CONTROL_TYPE || typeof obj.messageId !== "string" || !ID.test(obj.messageId)) return null;
    return obj.messageId.toLowerCase();
  } catch {
    return null;
  }
}

export function isBurnControlPayload(plaintext?: string) {
  return decodeBurnControlPayload(plaintext) !== null;
}

export function parseBurnControl(message: Pick<CanonicalMessage, "tags" | "plaintext">): string | null {
  // A JSON-looking ordinary post must never be treated as a deletion command.
  if (!isBurnControl(message)) return null;
  return decodeBurnControlPayload(message.plaintext);
}
