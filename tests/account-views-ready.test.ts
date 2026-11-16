import { describe, expect, it, vi } from "vitest";
import { nextTick, reactive, ref } from "vue";
import { untilAccountViewsCanRender } from "@/router/accountViewsReady";

const PK = "a".repeat(64);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

function setup() {
  const restore = deferred();
  const keys = reactive({
    pkHex: "", isUnlocked: false, isRestored: false, isLoggedIn: false, accountStoresReadyFor: "",
    restoreSession: vi.fn(() => restore.promise),
  });
  const router = {
    currentRoute: ref({ path: "/", fullPath: "/", meta: { requiresAuth: true } }),
    replace: vi.fn(async () => undefined),
  };
  let resolved = false;
  const wait = untilAccountViewsCanRender(keys, router as never).then(() => { resolved = true; });
  return { keys, router, restore, wait, isResolved: () => resolved };
}

const flush = async () => { for (let i = 0; i < 5; i++) { await nextTick(); await Promise.resolve(); } };

describe("冷启动时路由等到账号页面能显示", () => {
  it("本地数据就绪就放行，不等恢复登录的后半段", async () => {
    const t = setup();
    t.keys.pkHex = PK;
    t.keys.isUnlocked = true;
    t.keys.isLoggedIn = true;
    await flush();
    expect(t.isResolved()).toBe(false);

    t.keys.accountStoresReadyFor = PK;
    await flush();
    expect(t.isResolved()).toBe(true);
    expect(t.router.replace).not.toHaveBeenCalled();
  });

  it("加密库还没解锁时不放行", async () => {
    const t = setup();
    t.keys.pkHex = PK;
    t.keys.accountStoresReadyFor = PK;
    await flush();
    expect(t.isResolved()).toBe(false);
    t.restore.resolve();
    await t.wait;
  });

  it("没有本地账号时，等恢复结束再放行（去登录页由守卫后续处理）", async () => {
    const t = setup();
    await flush();
    expect(t.isResolved()).toBe(false);
    t.keys.isRestored = true;
    t.restore.resolve();
    await t.wait;
    expect(t.router.replace).not.toHaveBeenCalled();
  });

  it("提前放行后，恢复的后半段失败清掉了会话，就回到登录页", async () => {
    const t = setup();
    Object.assign(t.keys, { pkHex: PK, isUnlocked: true, isLoggedIn: true, accountStoresReadyFor: PK });
    await t.wait;

    Object.assign(t.keys, { pkHex: "", isUnlocked: false, isLoggedIn: false, isRestored: true });
    t.restore.resolve();
    await flush();

    expect(t.router.replace).toHaveBeenCalledWith({ path: "/login", query: { redirect: "/" } });
  });

  it("提前放行后恢复正常结束，不跳转", async () => {
    const t = setup();
    Object.assign(t.keys, { pkHex: PK, isUnlocked: true, isLoggedIn: true, accountStoresReadyFor: PK });
    await t.wait;
    t.keys.isRestored = true;
    t.restore.resolve();
    await flush();
    expect(t.router.replace).not.toHaveBeenCalled();
  });

  it("恢复出错也会放行", async () => {
    const restore = Promise.reject(new Error("boom"));
    const keys = reactive({ pkHex: "", isUnlocked: false, isRestored: false, isLoggedIn: false, accountStoresReadyFor: "", restoreSession: () => restore });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(untilAccountViewsCanRender(keys, { currentRoute: ref({ meta: {} }), replace: vi.fn() } as never)).resolves.toBeUndefined();
  });
});
