import type { CanonicalMessage } from "./protocol";

export class MessageDeduplicator {
  private readonly logicalIds = new Set<string>();

  accept(message: CanonicalMessage): boolean {
    const key = message.rumorId || message.id || message.transportEventId;
    if (!key || this.logicalIds.has(key)) return false;
    this.logicalIds.add(key);
    return true;
  }

  clear() {
    this.logicalIds.clear();
  }
}
