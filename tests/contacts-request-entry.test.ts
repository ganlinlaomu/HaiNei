import { readFileSync } from "node:fs";
import { compile } from "vue";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync("src/views/Friends.vue", "utf8");
function block(start: string, end: string) {
  const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
  if (left < 0 || right < 0) throw new Error("Missing request control");
  return source.slice(left, right + end.length);
}
const entry = compile(block('<button v-if="activeSection === \'accepted\'" class="contacts-requests"', '</button>\n    <button v-else class="contacts-requests-back" type="button" aria-label="返回好友列表"\n      @click="activeSection = \'accepted\'"><span aria-hidden="true">‹</span> 返回通讯录</button>'));
const accept = compile(block('<button class="btn request-accept"', '</button>'));
const withdraw = compile(block('<button class="swipe-action withdraw"', '</button>'));

function textContent(vnode: any): string {
  if (typeof vnode === "string") return vnode;
  if (!vnode) return "";
  return Array.isArray(vnode.children)
    ? vnode.children.map(textContent).join("")
    : String(vnode.children || "");
}
describe("contacts request inbox navigation", () => {
  it("shows the incoming count only when needed, and returns to friend list", () => {
    const model = { activeSection: "accepted", incomingRequests: [{}, {}] };
    const button = entry(model as any, []) as any;
    expect(button.props["aria-label"]).toBe("查看好友请求");
    expect(textContent(button)).toContain("2");
    button.props.onClick();
    expect(model.activeSection).toBe("incoming");
    const back = entry(model as any, []) as any;
    expect(back.props["aria-label"]).toBe("返回好友列表");
    back.props.onClick();
    expect(model.activeSection).toBe("accepted");
    model.incomingRequests = [];
    const zero = entry(model as any, []) as any;
    expect(textContent(zero)).not.toMatch(/\\b0\\b/);
  });
  it("keeps accept and withdraw actions available inside the unified request view", () => {
    const accepted = vi.fn(), withdrawn = vi.fn();
    const props = {
      request: { peerPubkey: "abc" }, relationshipBusy: new Set(),
      friendships: { requestDelivery: () => "sent" },
      acceptRequest: accepted, withdrawFromSwipe: withdrawn,
    };
    const acceptVNode = accept(props as any, []) as any;
    expect(acceptVNode.props.disabled).toBe(false);
    acceptVNode.props.onClick();
    expect(accepted).toHaveBeenCalledWith("abc");
    const withdrawVNode = withdraw(props as any, []) as any;
    expect(withdrawVNode.props.disabled).toBe(false);
    withdrawVNode.props.onClick({ stopPropagation: () => {} });
    expect(withdrawn).toHaveBeenCalledWith("abc");
    expect(source).toContain("v-show=\"activeSection !== 'accepted'\" id=\"incoming-requests\"");
    expect(source).toContain("已发送请求（{{ outgoingRequests.length }}）");
  });
});
