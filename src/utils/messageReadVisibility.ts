/** Read cursors advance only when the actual newest message range is visible. */
export function canMarkConversationTailRead(input: {
  hasList: boolean;
  sourceFocused: boolean;
  searchingHistory: boolean;
  tailRendered: boolean;
  nearBottom: boolean;
}): boolean {
  return input.hasList && !input.sourceFocused && !input.searchingHistory
    && input.tailRendered && input.nearBottom;
}
