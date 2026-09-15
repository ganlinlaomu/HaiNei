const FORBIDDEN_KEY = /(skhex|nsec|password|private.*key|secret.*key|conversation.*key|ciphertext|encrypted.*payload|encrypted.*key|blossomtoken|authorization|(^|_)token($|_))/i;
const IDENTIFIER_KEY = /(eventid|messageid|rumorid|pubkey|account|sender|recipient|target)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 400;

function sanitizeValue(value: unknown, key: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (IDENTIFIER_KEY.test(key)) return value.slice(0, 12);
    const scrubbed = value
      .replace(/nsec1[023456789acdefghjklmnpqrstuvwxyz]+/gi, "[redacted-nsec]")
      .replace(/(bunker:\/\/[^\s?]+\?[^\s#]*\bsecret=)[^&\s]+/gi, "$1[redacted]");
    return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}…` : scrubbed;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (value instanceof Error) return { name: value.name };
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, key, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(childKey) || childKey.toLowerCase() === "content" || childKey.toLowerCase() === "plaintext") {
        result[childKey] = "[redacted]";
        continue;
      }
      const sanitized = sanitizeValue(childValue, childKey, depth + 1);
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
  }
  return String(value).slice(0, MAX_STRING);
}

export function sanitizeDebugData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return sanitizeValue(data, "", 0) as Record<string, unknown>;
}

