import { readFileSync } from "node:fs";
import { compile } from "vue";
import { describe, expect, it } from "vitest";

const component = readFileSync("src/components/SwipeLucideIcon.vue", "utf8");
const template = component.slice(component.indexOf("<template>") + 10, component.indexOf("</template>\n<script"));
const render = compile(template);
function paths(name: string) {
  const vnode = render({ name } as any, []);
  const ds: string[] = [];
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "path") ds.push(node.props?.d);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  }
  walk(vnode);
  return ds;
}
describe("canonical Lucide swipe icon rendering", () => {
  it("renders distinct pin and pin-off, bell and bell-off paths from the same component", () => {
    for (const icon of ["pin", "pin-off", "bell", "bell-off", "eye-off", "pencil", "undo-2", "trash", "check"]) {
      expect(paths(icon).length).toBeGreaterThan(0);
    }
    expect(paths("pin")).not.toEqual(paths("pin-off"));
    expect(paths("bell")).not.toEqual(paths("bell-off"));
    expect(paths("trash")).toContain("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6");
  });
  it("retains the 48/22px circular styles and action bindings in all five views", () => {
    const css = readFileSync("src/swipeActions.css", "utf8");
    expect(css).toContain("width:48px;height:48px");
    expect(css).toContain("width:22px;height:22px");
    for (const file of ["Calls","Conversations","Friends","PrivateSpace","Notifications"]) {
      const code = readFileSync(`src/views/${file}.vue`, "utf8");
      expect(code).toContain("SwipeLucideIcon");
      expect(code).toContain("hainei-swipe-button");
    }
    const conversation = readFileSync("src/views/Conversations.vue", "utf8");
    expect(conversation).toContain("conversation.pinned ? 'pin-off' : 'pin'");
    expect(conversation).toContain("conversation.muted ? 'bell-off' : 'bell'");
    expect(conversation).toContain('aria-label="隐藏私信"');
  });
});
