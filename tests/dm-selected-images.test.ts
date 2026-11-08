import { describe, expect, it } from "vitest";
import { imagesToAppend } from "@/utils/selectedImages";

const image = (name: string, type = "image/jpeg") => new File([name], name, { type, lastModified: 1 });

describe("DM image selection", () => {
  it("adds a second pick to the photos already selected", () => {
    const first = [image("a.jpg"), image("b.jpg")];
    const { added, overflow } = imagesToAppend(first, [image("c.jpg")], 9);
    expect(added.map(file => file.name)).toEqual(["c.jpg"]);
    expect(overflow).toBe(false);
  });

  it("skips photos already selected and non-images", () => {
    const { added } = imagesToAppend([image("a.jpg")], [image("a.jpg"), image("a.jpg"), image("doc.pdf", "application/pdf"), image("d.png", "image/png")], 9);
    expect(added.map(file => file.name)).toEqual(["d.png"]);
  });

  it("stops at the limit and reports the overflow", () => {
    const selected = Array.from({ length: 8 }, (_, index) => image(`${index}.jpg`));
    const { added, overflow } = imagesToAppend(selected, [image("x.jpg"), image("y.jpg")], 9);
    expect(added.map(file => file.name)).toEqual(["x.jpg"]);
    expect(overflow).toBe(true);
    expect(imagesToAppend([...selected, ...added], [image("z.jpg")], 9)).toEqual({ added: [], overflow: true });
  });
});
