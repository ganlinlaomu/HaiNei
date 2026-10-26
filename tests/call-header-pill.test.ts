import { readFileSync } from "node:fs";
import { compile } from "vue";
import { describe, expect, it } from "vitest";
import { selectedTabPill } from "@/utils/tabPillGeometry";

const source = readFileSync("src/views/Calls.vue", "utf8");
const start = source.indexOf('<div ref="callTabs" class="call-header-tabs"');
const end = source.indexOf('</div>', start);
if (start < 0 || end < 0) throw new Error("Missing header call tabs");
const render = compile(source.slice(start, end + 6));

describe("calls centered segmented header", () => {
  it("renders all/missed tabs and switches the model using the real Vue click callbacks", () => {
    const model = { missedOnly: false, tabPillReady: true, tabPillStyle: {} };
    const bar = render(model as any, []) as any;
    const buttons = bar.children.filter((node: any) => node.type === "button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].props["aria-selected"]).toBe(true);
    expect(buttons[1].props["aria-selected"]).toBe(false);
    buttons[1].props.onClick();
    expect(model.missedOnly).toBe(true);
    const missed = render(model as any, []) as any;
    const after = missed.children.filter((node: any) => node.type === "button");
    expect(after[0].props["aria-selected"]).toBe(false);
    expect(after[1].props["aria-selected"]).toBe(true);
    after[0].props.onClick();
    expect(model.missedOnly).toBe(false);
  });
  it("reuses selectedTabPill geometry for the indicator instead of a separate filter row", () => {
    const rows = [{ key: "all", offsetLeft: 3, offsetWidth: 95 }, { key: "missed", offsetLeft: 100, offsetWidth: 116 }];
    expect(selectedTabPill(rows, "all")).toEqual({ translateX: 3, width: 95 });
    expect(selectedTabPill(rows, "missed")).toEqual({ translateX: 100, width: 116 });
    expect(source).toContain("createTabPillObserver(refreshTabPill)");
    expect(source).toContain('class="call-header-tabs"');
    expect(source).not.toContain('class="calls-filters"');
  });
});
