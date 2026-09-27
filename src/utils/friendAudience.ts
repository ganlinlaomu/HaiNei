export type AudienceFriend = {
  pubkey: string;
  groups?: string[];
  group?: string;
};

export const UNGROUPED_FRIEND_LABEL = "未分组";

export function friendGroupTags(friend: Pick<AudienceFriend, "groups" | "group">): string[] {
  const raw = Array.isArray(friend.groups) && friend.groups.length > 0
    ? friend.groups
    : friend.group ? [friend.group] : [];
  const groups = [...new Set(raw.map(value => String(value || "").trim()).filter(Boolean))];
  return groups.length ? groups : [UNGROUPED_FRIEND_LABEL];
}

export function audienceGroupCounts(friends: AudienceFriend[]) {
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const friend of friends) {
    for (const group of friendGroupTags(friend)) {
      if (!(group in counts)) order.push(group);
      counts[group] = (counts[group] || 0) + 1;
    }
  }
  return { order, counts };
}

export function normalizeSelectedAudienceGroups(selected: string[], available: string[]) {
  const valid = new Set(available);
  return [...new Set(selected.map(value => String(value || "").trim()).filter(group => group && valid.has(group)))];
}

export function audienceRecipients(friends: AudienceFriend[], allFriends: boolean, selectedGroups: string[]) {
  const selected = new Set(selectedGroups);
  const recipients = new Set<string>();
  for (const friend of friends) {
    const pubkey = String(friend.pubkey || "").trim().toLowerCase();
    if (!pubkey) continue;
    if (allFriends || friendGroupTags(friend).some(group => selected.has(group))) recipients.add(pubkey);
  }
  return [...recipients];
}

export function audienceGroupsMeta(
  friends: AudienceFriend[],
  allFriends: boolean,
  selectedGroups: string[],
): Array<{ name: string; count: number }> {
  const recipients = audienceRecipients(friends, allFriends, selectedGroups);
  if (allFriends) return recipients.length ? [{ name: "全部好友", count: recipients.length }] : [];
  const { counts } = audienceGroupCounts(friends);
  return selectedGroups
    .map(name => ({ name, count: counts[name] || 0 }))
    .filter(group => group.count > 0);
}
