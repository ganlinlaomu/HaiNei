import type { EventTemplate, NostrEvent, VerifiedEvent } from "nostr-tools";

export type MessageProtocol = "nip17";

export interface CanonicalMessage {
  id: string;
  senderPubkey: string;
  recipientPubkeys: string[];
  conversationId?: string;
  plaintext?: string;
  ciphertext?: string;
  createdAt: number;
  protocol: MessageProtocol;
  transportKind: number;
  transportEventId?: string;
  rumorId?: string;
  replyTo?: string;
  rootId?: string;
  tags: string[][];
  rawEvent?: NostrEvent;
}

export interface DecodeContext {
  accountPubkey: string;
  nip44Decrypt?: (senderPubkey: string, ciphertext: string) => Promise<string>;
}

export interface EncodeContext {
  senderPubkey: string;
  nip44Encrypt?: (recipientPubkey: string, plaintext: string) => Promise<string>;
  signEvent: (event: EventTemplate) => Promise<VerifiedEvent>;
}

export interface OutgoingMessage {
  recipientPubkeys: string[];
  plaintext: string;
  createdAt?: number;
  /** Sub-second send time (0..999) paired with createdAt; becomes the rumor's ms tag. */
  createdMs?: number;
  replyTo?: string;
  rootId?: string;
  tags?: string[][];
  /** Opt-in disappearing DM; normal NIP-17 messages are unchanged. */
  burnAfterSeconds?: 10 | 30 | 60;
  /**
   * NIP-40 expiration on the gift wraps only, for ephemeral controls (live
   * location updates) that relays should drop. Ignored for disappearing DMs.
   */
  wrapTtlSeconds?: number;
}

export interface EncodedMessage {
  message: CanonicalMessage;
  events: NostrEvent[];
}

export interface MessageProtocolAdapter {
  readonly name: MessageProtocol;
  canDecode(event: NostrEvent): boolean;
  decode(event: NostrEvent, context: DecodeContext): Promise<CanonicalMessage | null>;
  encode?(message: OutgoingMessage, context: EncodeContext): Promise<EncodedMessage>;
}
