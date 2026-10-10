/** The official HaiNei chat bot; only its exact public key receives special treatment. */
export const HAINEI_BOT_NPUB = "npub15m0wl0dqr2ucudfqqengmw0prwfgkjfed92z5t3q5rpjc3wx68mq30yq57";
export const HAINEI_BOT_PUBKEY = "a6deefbda01ab98e352006668db9e11b928b493969542a2e20a0c32c45c6d1f6";
export const HAINEI_BOT_NAME = "Hainei Bot";

export function isHaiNeiBot(pubkey: string | null | undefined): boolean {
  return typeof pubkey === "string" && pubkey.trim().toLowerCase() === HAINEI_BOT_PUBKEY;
}
