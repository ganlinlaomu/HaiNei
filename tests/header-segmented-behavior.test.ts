import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { computed, createRenderer, h, nextTick, ref } from "vue";
import HeaderSegmented from "@/components/HeaderSegmented.vue";
import { afterEach, describe, expect, it, vi } from "vitest";

type Node = { type: string; props: Record<string, any>; children: Node[]; parent: Node | null; text: string;
  offsetLeft: number; offsetWidth: number; querySelectorAll: (selector: string) => Node[] };
function node(type: string): Node {
  const n: Node = { type, props: {}, children: [], parent: null, text: "", offsetLeft: 0, offsetWidth: 96,
    querySelectorAll: () => n.children.filter(x => x.props["data-space-tab"]) };
  return n;
}
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => Object.assign(node("#text"), { text }),
  createComment: text => Object.assign(node("#comment"), { text }),
  setText: (el, text) => { el.text = text; },
  setElementText: (el, text) => { el.children = []; el.text = text; },
  patchProp: (el, key, _prev, next) => {
    el.props[key] = next;
    if (key === "data-space-tab") {
      el.offsetLeft = next === "all" ? 3 : 110;
      el.offsetWidth = next === "all" ? 103 : 107;
    }
  },
  insert: (el, parent, anchor) => {
    if (el.parent) el.parent.children = el.parent.children.filter(x => x !== el);
    el.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(el); else parent.children.splice(index, 0, el);
  },
  remove: el => { if (el.parent) el.parent.children = el.parent.children.filter(x => x !== el); el.parent = null; },
  parentNode: el => el.parent,
  nextSibling: el => {
    const siblings = el.parent?.children || [];
    return siblings[siblings.indexOf(el) + 1] || null;
  },
});
function buttons(root: Node) {
  const container = root.children.find(n => n.type === "div");
  if (!container) throw Error("missing segmented tabs");
  return container.children.filter(n => n.type === "button");
}
afterEach(() => vi.unstubAllGlobals());

describe("HeaderSegmented real component lifecycle and selection", () => {
  it("emits selected tab, renders counts, and detaches resize handlers on unmount", async () => {
    const window = new EventTarget();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const observers: Array<{ disconnected: boolean; resize: () => void }> = [];
    class Observer {
      state: (typeof observers)[number];
      constructor(callback: () => void) { this.state = { disconnected: false, resize: callback }; observers.push(this.state); }
      observe() {}
      disconnect() { this.state.disconnected = true; }
    }
    const frameCallbacks = new Map<number, () => void>();
    vi.stubGlobal("ResizeObserver", Observer);
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", { fonts: { ready: Promise.resolve() } });
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frameCallbacks.set(1, callback); return 1; });
    const cancel = vi.fn((id: number) => frameCallbacks.delete(id));
    vi.stubGlobal("cancelAnimationFrame", cancel);

    const root = node("root");
    let selected = "all";
    const options = [{ key: "all", label: "全部" }, { key: "unread", label: "未读", count: 3 }];
    const draw = () => renderer.render(h(HeaderSegmented, {
      options, modelValue: selected, "onUpdate:modelValue": (v: string) => { selected = v; },
    }), root);
    draw();
    expect(buttons(root).map(n => n.props["aria-selected"])).toEqual([true, false]);
    expect(buttons(root)[1].children.some(n => n.text === "3")).toBe(true);
    buttons(root)[1].props.onClick();
    expect(selected).toBe("unread");
    draw();
    await nextTick();
    expect(buttons(root).map(n => n.props["aria-selected"])).toEqual([false, true]);
    expect(add).toHaveBeenCalledWith("resize", expect.any(Function), { passive: true });
    const listener = add.mock.calls.find(args => args[0] === "resize")![1];
    renderer.render(null, root);
    expect(remove).toHaveBeenCalledWith("resize", listener);
    expect(observers[0].disconnected).toBe(true);
    expect(cancel).toHaveBeenCalled();
    const before = observers.length;
    window.dispatchEvent(new Event("resize"));
    observers[0].resize();
    await nextTick();
    expect(observers).toHaveLength(before);
    expect(root.children).toHaveLength(0);
  });
});

function realComputed(path: string, start: string, end: string, scope: Record<string, unknown>) {
  const file = readFileSync(path, "utf8");
  const a = file.indexOf(start), b = file.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error("filter not found");
  const code = ts.transpileModule(file.slice(a, b), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const varName = start.includes("filteredConversations") ? "filteredConversations" : "filtered";
  return runInNewContext(code + "\n" + varName, { computed, ...scope }) as { value: Array<{ id?: string; peerPubkey?: string }> };
}
describe("original page list filtering behavior", () => {
  it("filters private messages by actual unread state, retaining the all list", () => {
    const mode = ref("all");
    const searchQuery = ref("");
    const rows = ref([{ peerPubkey: "a", unread: 0 }, { peerPubkey: "b", unread: 3 }]);
    const filtered = realComputed("src/views/Conversations.vue",
      "const filteredConversations = computed(", "const emptyFilteredMessage = computed(", {
        filterMode: mode, searchQuery, conversations: rows,
        friendByPubkey: ref(new Map()), profiles: { getProfile: () => null }, displayName: (pk: string) => pk,
      });
    expect(filtered.value.map(x => x.peerPubkey)).toEqual(["a", "b"]);
    mode.value = "unread";
    expect(filtered.value.map(x => x.peerPubkey)).toEqual(["b"]);
  });
  it("keeps missed-call filtering unchanged", () => {
    const missedOnly = ref(false);
    const records = ref([{ id: "first", missed: true, peer: "a", createdAt: 9 },
      { id: "second", missed: false, peer: "b", createdAt: 8 }]);
    const filtered = realComputed("src/views/Calls.vue",
      "const filtered = computed(", "const callableFriends = computed(", {
        missedOnly, records, search: ref(""),
        callHistory: { localMissed: [], isDeleted: () => false },
        name: (key: string) => key, uniqueCallHistory: (values: unknown[]) => values,
      });
    expect(filtered.value.map(x => x.id)).toEqual(["first", "second"]);
    missedOnly.value = true;
    expect(filtered.value.map(x => x.id)).toEqual(["first"]);
  });
});
