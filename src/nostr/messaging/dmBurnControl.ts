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

export function parseBurnControl(message: Pick<CanonicalMessage, "tags" | "plaintext">): string | null {
  if (!isBurnControl(message)) return null;
  try {
    const obj = JSON.parse(message.plaintext || "") as { type?: unknown; messageId?: unknown };
    if (obj?.type !== DM_BURN_CONTROL_TYPE || typeof obj.messageId !== "string" || !ID.test(obj.messageId)) return null;
    return obj.messageId.toLowerCase();
  } catch {
    return null;
  }
}
