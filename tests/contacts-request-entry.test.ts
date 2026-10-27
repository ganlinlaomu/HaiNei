import { readFileSync } from "node:fs";
import { compile } from "vue";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync("src/views/Friends.vue", "utf8");
function block(start: string, end: string) {
  const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
  if (left < 0 || right < 0) throw new Error("Missing request control");
  return source.slice(left, right + end.length);
}
const entry = compile(block('<button v-if="activeSection === \'accepted\'" class="contacts-requests"', '</button>'));
const header = compile(block('<SecondaryPageHeader v-if="activeSection !== \'accepted\'"', '<header v-else class="contacts-header primary-page-header">') + "</header>");
const accept = compile(block('<button class="btn request-accept"', '</button>'));
const withdraw = compile(block('<button class="swipe-action withdraw hainei-swipe-button"', '</button>'));

function renderedButton(vnode: any): any {
  if (vnode?.type === "button") return vnode;
  if (Array.isArray(vnode?.children)) {
    for (const child of vnode.children) {
      const button = renderedButton(child);
      if (button) return button;
    }
  }
  return null;
}

function textContent(vnode: any): string {
  if (typeof vnode === "string") return vnode;
  if (!vnode) return "";
  return Array.isArray(vnode.children)
    ? vnode.children.map(textContent).join("")
    : String(vnode.children || "");
}
describe("contacts request inbox navigation", () => {
  it("shows the incoming count only when needed and opens the request view", () => {
    const showSection = vi.fn();
    const model = { activeSection: "accepted", incomingRequests: [{}, {}], showSection };
    const button = renderedButton(entry(model as any, [])) as any;
    expect(button.props["aria-label"]).toBe("查看好友请求");
    expect(textContent(button)).toContain("2");
    button.props.onClick();
    expect(showSection).toHaveBeenCalledWith("incoming");
    model.incomingRequests = [];
    const zero = renderedButton(entry(model as any, [])) as any;
    expect(textContent(zero)).not.toMatch(/\\b0\\b/);
  });
  it("puts the return in the page header, titled for the request view", () => {
    const closeRequests = vi.fn();
    const ctx = { activeSection: "incoming", closeRequests, $options: { components: {} } };
    const vnode = header(ctx as any, []) as any;
    // The secondary header replaces the contacts header instead of an
    // inline link below it that scrolled away with the list.
    expect(vnode.props).toMatchObject({ title: "好友请求", "back-label": "返回通讯录", "back-mode": "emit" });
    vnode.props.onBack();
    expect(closeRequests).toHaveBeenCalledOnce();
    expect(source).not.toContain("contacts-requests-back");
  });
  it("keeps accept and withdraw actions available inside the unified request view", () => {
    const accepted = vi.fn(), withdrawn = vi.fn();
    const props = {
      request: { peerPubkey: "abc" }, relationshipBusy: new Set(),
      friendships: { requestDelivery: () => "sent" },
      acceptRequest: accepted, withdrawFromSwipe: withdrawn,
    };
    const acceptVNode = renderedButton(accept(props as any, [])) as any;
    expect(acceptVNode.props.disabled).toBe(false);
    acceptVNode.props.onClick();
    expect(accepted).toHaveBeenCalledWith("abc");
    const withdrawVNode = renderedButton(withdraw(props as any, [])) as any;
    expect(withdrawVNode.props.disabled).toBe(false);
    withdrawVNode.props.onClick({ stopPropagation: () => {} });
    expect(withdrawn).toHaveBeenCalledWith("abc");
    expect(source).toContain("v-show=\"activeSection !== 'accepted'\" id=\"incoming-requests\"");
    expect(source).toContain("已发送请求（{{ outgoingRequests.length }}）");
  });
});
