/** listConversationPage never returns more rows than this per call. */
export const MAX_CONVERSATION_PAGE_SIZE = 100;

/**
 * The page size listConversationPage actually reads for `limit`. A caller
 * that infers "no older rows" from a short page must compare with this, not
 * with what it asked for.
 */
export function conversationPageSize(limit: number) {
  return Math.max(1, Math.min(Math.floor(limit) || 1, MAX_CONVERSATION_PAGE_SIZE));
}
