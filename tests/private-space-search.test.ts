import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { privateSpaceEmptyMessage, privateSpaceSearchLabel, type SpaceFilter } from "@/utils/privateSpacePresentation";

describe("private space category-specific search and empty states", () => {
  const cases: [SpaceFilter, string, string, string][] = [
    ["saved", "搜索收藏", "暂无收藏", "没有匹配的收藏"],
    ["note", "搜索笔记", "暂无笔记，点击「＋笔记」开始记录。", "没有匹配的笔记"],
    ["todo", "搜索待办", "暂无待办，点击「＋待办」添加事项。", "没有匹配的待办"],
    ["all", "搜索笔记和待办", "暂无笔记或待办。", "没有匹配的笔记或待办"],
    ["archived", "搜索归档", "暂无归档内容。", "没有匹配的归档内容"],
    ["trash", "搜索最近删除", "最近删除为空。", "没有匹配的已删除内容"],
  ];
  it.each(cases)("uses the %s category for labels and empty/search states", (filter, label, empty, noMatch) => {
    expect(privateSpaceSearchLabel(filter)).toBe(label);
    expect(privateSpaceEmptyMessage(filter, "")).toBe(empty);
    expect(privateSpaceEmptyMessage(filter, "  \n ")).toBe(empty);
    expect(privateSpaceEmptyMessage(filter, " missing ")).toBe(noMatch);
  });

  it("wires category-aware copy and keeps search scoped to the active category", () => {
    const source = readFileSync("src/views/PrivateSpace.vue", "utf8");
    expect(source).toContain(':aria-label="searchLabel" :placeholder="searchLabel"');
    expect(source).toContain("privateSpaceSearchLabel(filter.value)");
    expect(source).toContain("privateSpaceEmptyMessage(filter.value, query.value)");
    expect(source).toContain('{{ emptyMessage }}');
    expect(source).not.toContain("这里还没有内容。可以新建一条笔记或待办。");
    expect(source).toContain('note.kind === filter.value');
    expect(source).toContain('query.value = ""');
  });

  it("uses an iOS-safe font size and bounded fixed-height search layout without blocking zoom", () => {
    const source = readFileSync("src/views/PrivateSpace.vue", "utf8");
    const rule = source.match(/\.toolbar input\{([^}]+)\}/)?.[1] || "";
    for (const declaration of ["font-size:16px", "height:44px", "box-sizing:border-box", "min-width:0", "width:0", "flex:1 1 0", "appearance:none"]) {
      expect(rule).toContain(declaration);
    }
    expect(source).toContain(".toolbar button{flex-shrink:0}");
    const html = readFileSync("index.html", "utf8");
    expect(html).not.toContain("user-scalable=no");
    expect(html).not.toContain("maximum-scale=1");
  });
});
