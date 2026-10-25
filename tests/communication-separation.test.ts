import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const src = (path: string) => readFileSync(path, "utf8");
describe("separate DMs, missed calls, contacts and history deletion", () => {
  it("keeps missed calls on Calls tab only and reads call state separately", () => {
    const nav = src("src/components/HeaderBar.vue");
    const calls = src("src/views/Calls.vue");
    const state = src("src/stores/callHistory.ts");
    expect(nav).toContain("directMessages.unreadCount");
    expect(nav).toContain("callHistory.missedUnreadCount");
    expect(calls).toContain('aria-label="通话记录筛选"');
    expect(calls).toContain("callHistory.acknowledge(account)");
    expect(state).toContain("uniqueCallHistory");
    expect(state).toContain('metaRepository.put(account, SEEN_KEY, timestamp)');
  });
  it("persists call deletion tombstones so relay resync cannot revive a hidden record", () => {
    const calls = src("src/views/Calls.vue");
    const state = src("src/stores/callHistory.ts");
    expect(calls).toContain("@click.stop=\"deleteCallRecord(item)\"");
    expect(calls).toContain("!callHistory.isDeleted(item.id)");
    expect(calls).toContain('class="call-swipe-actions"');
    expect(calls).toContain("onTouchMove");
    expect(calls).not.toContain("item.text }}");
    // The call picker avatar is a span. Flex-grow must be limited to the
    // contact name, otherwise ProfileAvatar stretches horizontally into an oval.
    expect(calls).toContain('class="picker-name"');
    expect(calls).toContain('.picker-row .picker-name{flex:1;min-width:0;');
    expect(calls).toContain('.picker-row :deep(.profile-avatar){flex:0 0 42px;');
    expect(calls).not.toContain('.picker-row span{flex:1}');
    expect(calls).not.toContain('class="call-more"');
    expect(calls).not.toContain(">···</button>");
    const callBackMarkup = calls.slice(calls.indexOf('class="call-back"'), calls.indexOf('</button>', calls.indexOf('class="call-back"')));
    const pickerPhoneMarkup = calls.slice(calls.indexOf('class="picker-row"'), calls.indexOf('</button>', calls.indexOf('class="picker-row"')));
    const phonePath = 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2';
    expect(callBackMarkup).toContain(phonePath);
    expect(pickerPhoneMarkup).toContain(phonePath);
    expect(state).toContain("DELETED_PREFIX + id");
    expect(state).toContain("metaRepository.listPrefix(account, DELETED_PREFIX)");
    expect(state).not.toContain("db.syncedMessages.delete(");
  });
  it("has only one visible add action, with QR scanning inside the add form", () => {
    const contacts = src("src/views/Friends.vue");
    expect(contacts.match(/aria-label="添加好友"/g)).toHaveLength(1);
    expect(contacts).toContain('showScanner = true');
    expect(contacts).toContain("scan-qr-button");
    const settings = src("src/views/Settings.vue");
    expect(settings).not.toContain("好友 / 好友分组");
  });
});
