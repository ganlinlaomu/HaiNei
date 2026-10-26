import { readFileSync } from "node:fs";
import { compile } from "vue";
import { describe, expect, it } from "vitest";

const component = readFileSync("src/components/SwipeLucideIcon.vue", "utf8");
const template = component.slice(component.indexOf("<template>") + 10, component.indexOf("</template>\n<script"));
const render = compile(template);
function paths(name: string) {
  // Vue hoists constant SVG paths into static VNodes; inspect the matching
  // conditional branch while still executing the real render for the prop.
  const vnode = render({ name } as any, []);
  expect(vnode.props?.["data-lucide"]).toBe(name);
  const marker = new RegExp(`(?:v-if|v-else-if)="name === '${name}'"[^>]*>`);
  const start = template.search(marker);
  if (start < 0) throw new Error("Missing Lucide branch: " + name);
  const end = template.indexOf("</template>", start);
  if (end < 0) throw new Error("Unclosed Lucide branch: " + name);
  return Array.from(template.slice(start, end).matchAll(/<path d="([^"]+)"[^>]*>/g), match => match[1]);
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
