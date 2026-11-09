// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { PrivateSpaceRecord } from "@/db/dexie";
import TodoPlanner from "@/components/TodoPlanner.vue";

const ACCOUNT = "a".repeat(64);
const mocks = vi.hoisted(() => ({
  keys: { pkHex: "" },
  addToast: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  noteMutation: vi.fn(),
}));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.keys }));
vi.mock("@/stores/ui", () => ({ useUIStore: () => ({ addToast: mocks.addToast }) }));
vi.mock("@/repositories/privateSpaceRepository", () => ({
  privateSpaceRepository: { get: mocks.get, update: mocks.update },
}));
vi.mock("@/services/privateSpaceSync", () => ({ notePrivateSpaceMutation: mocks.noteMutation }));

function todo(overrides: Partial<PrivateSpaceRecord> = {}): PrivateSpaceRecord {
  return {
    accountPubkey: ACCOUNT, id: "rec-1", kind: "todo", title: "", body: "", pinned: false,
    tasks: [{ id: "task-1", text: "买牛奶", done: false }],
    createdAt: 1, updatedAt: 1, revision: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.keys.pkHex = ACCOUNT;
  mocks.addToast.mockReset();
  mocks.get.mockReset();
  mocks.update.mockReset();
  mocks.noteMutation.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("TodoPlanner 行为", () => {
  it("今天的未安排待办显示在列表里", () => {
    const wrapper = mount(TodoPlanner, { props: { records: [todo()] } });
    expect(wrapper.text()).toContain("未安排时间");
    expect(wrapper.get(".card-text").text()).toBe("买牛奶");
  });

  it("点完成会保存最新记录里的这一项，并通知同步", async () => {
    const record = todo();
    mocks.get.mockResolvedValue(record);
    mocks.update.mockResolvedValue(undefined);
    const wrapper = mount(TodoPlanner, { props: { records: [record] } });

    await wrapper.get("button.check").trigger("click");
    await flushPromises();

    expect(mocks.update).toHaveBeenCalledWith(ACCOUNT, "rec-1", {
      tasks: [{ id: "task-1", text: "买牛奶", done: true }],
    });
    expect(mocks.noteMutation).toHaveBeenCalledWith(mocks.keys);
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("保存失败时提示「无法更新待办」，按钮恢复可用", async () => {
    const record = todo();
    mocks.get.mockResolvedValue(record);
    mocks.update.mockRejectedValue(new Error("locked"));
    const wrapper = mount(TodoPlanner, { props: { records: [record] } });

    await wrapper.get("button.check").trigger("click");
    await flushPromises();

    expect(mocks.addToast).toHaveBeenCalledWith("无法更新待办，请确认账号已解锁", 2_200, "error");
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(wrapper.get("button.check").attributes("disabled")).toBeUndefined();
  });

  it("保存途中切换了账号，不写入也不提示", async () => {
    const record = todo();
    mocks.get.mockImplementation(async () => {
      mocks.keys.pkHex = "b".repeat(64);
      return record;
    });
    const wrapper = mount(TodoPlanner, { props: { records: [record] } });

    await wrapper.get("button.check").trigger("click");
    await flushPromises();

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(wrapper.emitted("changed")).toBeUndefined();
  });

  it("已删除或已归档的待办不显示", () => {
    const wrapper = mount(TodoPlanner, {
      props: { records: [todo({ id: "a", deletedAt: 2 }), todo({ id: "b", archivedAt: 2 })] },
    });
    expect(wrapper.find(".card").exists()).toBe(false);
    expect(wrapper.text()).toContain("今天没有安排");
  });
});
