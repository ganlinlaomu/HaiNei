import type { CanonicalMessage } from "./protocol";

/**
 * Voice call signaling as NIP-17 control messages. Only the two parties (and
 * their own devices, via the sender's self-copy) can read them. An invite
 * carries a one-time Trystero room and password; media then flows over
 * WebRTC (DTLS-SRTP, end to end), with TURN only as an encrypted relay.
 */
export const CALL_CONTROL_TYPE = "hainei-call";
/** Second `t` tag on invites only, so push and routing can tell them apart. */
export const CALL_INVITE_TYPE = "hainei-call-invite";
/** The caller's ordinary DM recording a call's outcome; missed ones also notify. */
export const CALL_LOG_TYPE = "hainei-call-log";
export const CALL_MISSED_TYPE = "hainei-call-missed";
/** An invite older than this rings no more: it is recorded as missed. */
export const CALL_RING_WINDOW_SECONDS = 60;

// ringing: the callee's device is ringing (caller shows 对方响铃中 instead of 正在呼叫).
export type CallAction = "invite" | "ringing" | "accept" | "reject" | "busy" | "cancel" | "end";
const ACTIONS = new Set<CallAction>(["invite", "ringing", "accept", "reject", "busy", "cancel", "end"]);
const CALL_ID = /^[0-9a-f]{32}$/;
const ROOM = /^[0-9a-f]{32}$/;
const SECRET = /^[0-9a-f]{64}$/;

export type CallSignal = {
  action: CallAction;
  callId: string;
  /** Invite only: one-time WebRTC room and its password. */
  room?: string;
  secret?: string;
  /** End only: connected duration. */
  durationSeconds?: number;
};

export function callControlTags(signal: Pick<CallSignal, "action">): string[][] {
  return signal.action === "invite"
    ? [["t", CALL_CONTROL_TYPE], ["t", CALL_INVITE_TYPE]]
    : [["t", CALL_CONTROL_TYPE]];
}

export function isCallControl(message: Pick<CanonicalMessage, "tags">) {
  return message.tags?.some(tag => tag[0] === "t" && tag[1] === CALL_CONTROL_TYPE) === true;
}

export function isCallInviteTags(tags: string[][] | undefined) {
  return tags?.some(tag => tag[0] === "t" && tag[1] === CALL_INVITE_TYPE) === true;
}

export function serializeCallSignal(signal: CallSignal) {
  const parsed = parseCallPayload(JSON.stringify({ type: CALL_CONTROL_TYPE, ...signal }));
  if (!parsed) throw new Error("invalid_call_signal");
  return JSON.stringify({ type: CALL_CONTROL_TYPE, ...parsed });
}

function parseCallPayload(plaintext?: string): CallSignal | null {
  if (!plaintext) return null;
  let value: any;
  try { value = JSON.parse(plaintext); } catch { return null; }
  if (!value || value.type !== CALL_CONTROL_TYPE || !ACTIONS.has(value.action) || !CALL_ID.test(value.callId)) return null;
  const signal: CallSignal = { action: value.action, callId: value.callId };
  if (signal.action === "invite") {
    if (!ROOM.test(value.room) || !SECRET.test(value.secret)) return null;
    signal.room = value.room;
    signal.secret = value.secret;
  }
  if (signal.action === "end" && Number.isSafeInteger(value.durationSeconds) && value.durationSeconds >= 0) {
    signal.durationSeconds = Math.min(value.durationSeconds, 24 * 60 * 60);
  }
  return signal;
}

/** A call signal from a tagged control message; anything else is ignored. */
export function parseCallSignal(message: Pick<CanonicalMessage, "tags" | "plaintext">): CallSignal | null {
  if (!isCallControl(message)) return null;
  return parseCallPayload(message.plaintext);
}

/** Payload check for tag-less copies (local restore), mirroring other controls. */
export function isCallPayload(plaintext?: string) {
  return parseCallPayload(plaintext) !== null;
}

export function randomHex(bytes: number) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, byte => byte.toString(16).padStart(2, "0")).join("");
}
