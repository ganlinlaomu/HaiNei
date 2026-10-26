import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compile, computed, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const component = readFileSync("src/components/HeaderSegmented.vue", "utf8");
const template = component.slice(component.indexOf("<template>") + 10, component.indexOf("</template>"));
function renderedButtons(modelValue: string, emit: (event: string, value: string) => void) {
  const render = compile(template);
  const node = render({
    options: [{ key: "all", label: "全部" }, { key: "unread", label: "未读", count: 3 }],
    modelValue, pillReady: true, pillStyle: {}, emit,
  } as any, []);
  const results: any[] = [];
  function walk(v: any) {
    if (!v || typeof v !== "object") return;
    if (v.type === "button") results.push(v);
    if (Array.isArray(v.children)) v.children.forEach(walk);
  }
  walk(node);
  return results;
}
afterEach(() => vi.unstubAllGlobals());

describe("HeaderSegmented template and listener lifetime", () => {
  it("emits selection and updates aria-selected, keeping the nonzero unread count", () => {
    const emit = vi.fn();
    const all = renderedButtons("all", emit);
    expect(all).toHaveLength(2);
    expect(all.map(node => node.props["aria-selected"])).toEqual([true, false]);
    all[1].props.onClick();
    expect(emit).toHaveBeenCalledWith("update:modelValue", "unread");
    const unread = renderedButtons("unread", emit);
    expect(unread.map(node => node.props["aria-selected"])).toEqual([false, true]);
    expect(JSON.stringify(unread[1].children)).toContain("3");
  });
  it("stops responding to resize events and observer callbacks after unmount", async () => {
    const callbacks: Array<() => void> = [];
    const registered: Array<{ callback: () => void; disconnected: boolean }> = [];
    class FakeResizeObserver {
      record: (typeof registered)[number];
      constructor(callback: () => void) {
        this.record = { callback, disconnected: false };
        registered.push(this.record);
      }
      observe() {}
      disconnect() { this.record.disconnected = true; }
    }
    const fakeWindow = new EventTarget();
    const remove = vi.spyOn(fakeWindow, "removeEventListener");
    const cancel = vi.fn();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { callbacks.push(fn); return 23; });
    vi.stubGlobal("document", { fonts: { ready: Promise.resolve() } });

    const source = component.slice(component.indexOf("const tabBar = ref<HTMLElement"), component.indexOf("</script>"));
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const fakeButtons = [
      { dataset: { segmentKey: "all" }, offsetLeft: 3, offsetWidth: 102 },
      { dataset: { segmentKey: "unread" }, offsetLeft: 108, offsetWidth: 104 },
    ];
    const bar = { querySelectorAll: () => fakeButtons };
    const mounts: Array<() => void> = [], unmounts: Array<() => void> = [];
    let measured = 0;
    const state = runInNewContext(code + "\n({ tabBar, pillStyle })", {
      ref, nextTick, watch: () => undefined,
      onMounted: (fn: () => void) => mounts.push(fn),
      onBeforeUnmount: (fn: () => void) => unmounts.push(fn),
      props: { modelValue: "unread", options: [{ key: "all" }, { key: "unread" }] },
      selectedTabPill: (tabs: any, selected: string) => {
        measured++;
        return tabs.find((tab: any) => tab.key === selected)
          ? { translateX: 108, width: 104 } : null;
      },
      createTabPillObserver: (cb: () => void) => {
        let observer: InstanceType<typeof FakeResizeObserver> | null = null;
        return {
          attach: (_bar: unknown) => { cb(); observer = new FakeResizeObserver(cb); observer.observe(); },
          disconnect: () => observer?.disconnect(),
        };
      },
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      window: fakeWindow, document: { fonts: { ready: Promise.resolve() } },
    }) as { tabBar: { value: unknown }; pillStyle: { value: Record<string,string> } };
    state.tabBar.value = bar;
    mounts.forEach(fn => fn());
    await Promise.resolve();
    expect(state.pillStyle.value.transform).toBe("translateX(108px)");
    fakeWindow.dispatchEvent(new Event("resize"));
    expect(measured).toBeGreaterThanOrEqual(2);
    unmounts.forEach(fn => fn());
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(cancel).toHaveBeenCalledWith(23);
    expect(registered[0].disconnected).toBe(true);
    const count = measured;
    fakeWindow.dispatchEvent(new Event("resize"));
    registered[0].callback();
    callbacks.forEach(fn => fn());
    await Promise.resolve();
    expect(measured).toBe(count);
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
