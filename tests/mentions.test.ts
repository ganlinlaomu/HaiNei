import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterMentionCandidates,
  insertMention,
  mentionTags,
  mentionedPubkeysFromTags,
  mentionQueryAtCursor,
  splitKnownMentions,
  type MentionCandidate,
} from "@/utils/mentions";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

describe("user mentions", () => {
  it("detects an @ query only at a mention boundary", () => {
    expect(mentionQueryAtCursor("hello @ali", 10)).toEqual({ start: 6, end: 10, query: "ali" });
    expect(mentionQueryAtCursor("mail@example", 12)).toBeNull();
    expect(mentionQueryAtCursor("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("filters candidates by name, note, and pubkey", () => {
    const candidates: MentionCandidate[] = [
      { pubkey: ALICE, label: "Alice", searchText: "咖啡" },
      { pubkey: BOB, label: "Bob", secondary: "小博" },
    ];
    expect(filterMentionCandidates(candidates, "咖啡").map(item => item.pubkey)).toEqual([ALICE]);
    expect(filterMentionCandidates(candidates, "小博").map(item => item.pubkey)).toEqual([BOB]);
  });

  it("inserts a selected mention and keeps the cursor after the trailing space", () => {
    const result = insertMention("hello @al world", { start: 6, end: 9, query: "al" }, { label: "Alice" });
    expect(result).toEqual({ text: "hello @Alice  world", cursor: 13 });
  });

  it("turns known @ names into clickable-ready segments without matching email text", () => {
    expect(splitKnownMentions("hi @Alice and mail@example.com", [
      { pubkey: ALICE, labels: ["Alice"] },
    ])).toEqual([
      { type: "text", text: "hi " },
      { type: "mention", text: "@Alice", label: "Alice", pubkey: ALICE },
      { type: "text", text: " and mail@example.com" },
    ]);
  });

  it("encodes mention recipients as private message metadata", () => {
    expect(mentionTags([ALICE, ALICE.toUpperCase(), "bad"])).toEqual([["hainei-mention", ALICE]]);
    expect(mentionedPubkeysFromTags([
      ["hainei-mention", ALICE],
      ["hainei-mention", BOB.toUpperCase()],
      ["p", BOB],
    ])).toEqual([ALICE, BOB]);
  });

  it("wires autocomplete into DMs, posts, and comments while keeping text transport unchanged", () => {
    const dm = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const post = readFileSync(join(process.cwd(), "src/components/PostEditorModal.vue"), "utf8");
    const comment = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    const postCard = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    const directStore = readFileSync(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");

    for (const source of [dm, post, comment]) {
      expect(source).toContain("MentionSuggestions");
      expect(source).toContain("useMentionComposer");
      expect(source).toContain("onMentionKeydown");
    }
    expect(dm).toContain('placement="above"');
    expect(comment).toContain('placement="above"');
    expect(post).toContain("const allowed = new Set(recipients.value");
    expect(post).toContain("inline");
    expect(comment).toContain("...(props.message.recipientPubkeys || [])");
    expect(comment).toContain(".filter(friend => allowed.has(friend.pubkey.toLowerCase()))");
    expect(postCard).toContain('<MentionText :text="displayedText" />');
    expect(comment).toContain('h(MentionText, { text: rowProps.comment.text })');
    expect(dm).toContain('<MentionText class="bubble-text"');
    expect(directStore).toContain("const text = content.trim()");
    const composer = readFileSync(join(process.cwd(), "src/composables/useMentionComposer.ts"), "utf8");
    expect(composer).toContain("const value = element.value");
    expect(composer).toContain("event?.currentTarget");
    expect(directStore).not.toContain("mentionPubkeys");
    expect(post).toContain("mentionTags(mentionRecipients)");
    expect(comment).toContain("mentionedPubkeys()");
  });
});
