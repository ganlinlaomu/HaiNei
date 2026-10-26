import { readFileSync } from "node:fs";
import { compile } from "vue";
import type { VNode } from "vue";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync("src/views/Conversations.vue", "utf8");
function action(name: "pin" | "mute", state: boolean) {
  const markup = source.match(new RegExp('<button class="action ' + name + ' hainei-swipe-button"[\\s\\S]*?<\\/button>'))?.[0];
  if (!markup) throw new Error("missing " + name + " control");
  // Compile the actual Vue template, including v-if branches and @click.
  const render = compile(markup);
  const click = vi.fn();
  const vnode = render({
    conversation: { peerPubkey: "peer-1", pinned: state, muted: state },
    togglePin: click,
    toggleMute: click,
  } as any, []) as VNode;
  const paths: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.props?.name) paths.push(node.props.name);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(vnode);
  return { vnode, click, paths };
}
describe("round swipe actions actual render and event behavior", () => {
  it("changes the pin icon and accessible label when already pinned", () => {
    const normal = action("pin", false), active = action("pin", true);
    expect(normal.vnode.props?.["aria-label"]).toBe("置顶");
    expect(active.vnode.props?.["aria-label"]).toBe("取消置顶");
    expect(normal.paths).not.toEqual(active.paths);
    normal.vnode.props?.onClick({ stopPropagation: () => {} });
    active.vnode.props?.onClick({ stopPropagation: () => {} });
    expect(normal.click).toHaveBeenCalledWith("peer-1");
    expect(active.click).toHaveBeenCalledWith("peer-1");
  });
  it("changes bell icon and label for muted/unmuted", () => {
    const normal = action("mute", false), active = action("mute", true);
    expect(normal.vnode.props?.["aria-label"]).toBe("免打扰");
    expect(active.vnode.props?.["aria-label"]).toBe("取消免打扰");
    expect(normal.paths).not.toEqual(active.paths);
    normal.vnode.props?.onClick({ stopPropagation: () => {} });
    expect(normal.click).toHaveBeenCalledWith("peer-1");
  });
  it("uses a single stylesheet and matching 64px slots for all swipe lists", () => {
    const css = readFileSync("src/swipeActions.css", "utf8");
    expect(css).toMatch(/width:48px;height:48px/);
    expect(css).toMatch(/width:22px;height:22px/);
    expect(css).toContain("var(--swipe-action-count,1) * 64px");
    expect(readFileSync("src/views/Conversations.vue", "utf8")).toContain('--swipe-action-count:4');
    expect(readFileSync("src/views/PrivateSpace.vue", "utf8")).toContain("actionWidth: 128");
    expect(readFileSync("src/views/Friends.vue", "utf8")).toContain("actionWidth: 128");
  });
});
