// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { useDmImageSelection } from "@/composables/useDmImageSelection";

const notify = vi.fn();
const warm = vi.fn(() => Promise.resolve());

// Same wiring as Messages.vue: a real file input bound to selectImages, and
// one remove button per preview.
const Harness = defineComponent({
  setup() {
    const selection = useDmImageSelection({ max: 9, notify, warm });
    return () => h("div", [
      h("input", { ref: selection.imageInput, type: "file", accept: "image/*", multiple: true, onChange: selection.selectImages }),
      ...selection.selectedImages.value.map((image, index) => h("div", { class: "selected-image", key: image.preview }, [
        h("img", { src: image.preview, alt: image.file.name }),
        h("button", { class: "remove", onClick: () => selection.removeSelectedImage(index) }, "×"),
      ])),
      h("button", { class: "clear", onClick: selection.clearSelectedImages }, "clear"),
    ]);
  },
});

let previewId = 0;
beforeEach(() => {
  previewId = 0;
  notify.mockReset();
  warm.mockClear();
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++previewId}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const photo = (name: string, type = "image/jpeg") => new File([name], name, { type, lastModified: 1 });

async function pick(wrapper: ReturnType<typeof mount>, files: File[]) {
  const input = wrapper.get("input[type=file]");
  Object.defineProperty(input.element, "files", { configurable: true, value: files });
  await input.trigger("change");
}

const names = (wrapper: ReturnType<typeof mount>) => wrapper.findAll(".selected-image img").map(img => img.attributes("alt"));

describe("私信选图片", () => {
  it("第二次选图追加到已选照片后面，不替换", async () => {
    const wrapper = mount(Harness);
    await pick(wrapper, [photo("a.jpg"), photo("b.jpg")]);
    await pick(wrapper, [photo("c.jpg")]);

    expect(names(wrapper)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(warm).toHaveBeenCalledTimes(3);
  });

  it("同一张照片不会重复加入，非图片文件被忽略", async () => {
    const wrapper = mount(Harness);
    await pick(wrapper, [photo("a.jpg")]);
    await pick(wrapper, [photo("a.jpg"), photo("doc.pdf", "application/pdf"), photo("d.png", "image/png")]);

    expect(names(wrapper)).toEqual(["a.jpg", "d.png"]);
  });

  it("每次选完都清空 input，移除后能重新选回同一张", async () => {
    const wrapper = mount(Harness);
    const input = wrapper.get("input[type=file]").element as HTMLInputElement;
    const valueSetter = vi.spyOn(input, "value", "set");

    await pick(wrapper, [photo("a.jpg")]);
    expect(valueSetter).toHaveBeenCalledWith("");

    await wrapper.get(".remove").trigger("click");
    expect(names(wrapper)).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");

    await pick(wrapper, [photo("a.jpg")]);
    expect(names(wrapper)).toEqual(["a.jpg"]);
  });

  it("最多 9 张，超出时提示一次", async () => {
    const wrapper = mount(Harness);
    await pick(wrapper, Array.from({ length: 7 }, (_, i) => photo(`${i}.jpg`)));
    expect(notify).not.toHaveBeenCalled();

    await pick(wrapper, [photo("x.jpg"), photo("y.jpg"), photo("z.jpg")]);

    expect(names(wrapper)).toHaveLength(9);
    expect(names(wrapper).slice(-2)).toEqual(["x.jpg", "y.jpg"]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("一次最多发送 9 张图片");
  });

  it("移除中间一张只释放那一张的预览", async () => {
    const wrapper = mount(Harness);
    await pick(wrapper, [photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);

    await wrapper.findAll(".remove")[1].trigger("click");

    expect(names(wrapper)).toEqual(["a.jpg", "c.jpg"]);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
  });

  it("清空会释放全部预览", async () => {
    const wrapper = mount(Harness);
    await pick(wrapper, [photo("a.jpg"), photo("b.jpg")]);

    await wrapper.get(".clear").trigger("click");

    expect(names(wrapper)).toEqual([]);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls.map(call => call[0])).toEqual(["blob:preview-1", "blob:preview-2"]);
  });

  it("预热失败不影响选图", async () => {
    warm.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const wrapper = mount(Harness);
    await pick(wrapper, [photo("a.jpg")]);
    expect(names(wrapper)).toEqual(["a.jpg"]);
  });
});
