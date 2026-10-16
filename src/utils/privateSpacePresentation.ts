export type SpaceFilter = "saved" | "all" | "note" | "todo" | "archived" | "trash";

const presentation: Record<SpaceFilter, { search: string; empty: string; noMatch: string }> = {
  saved: { search: "搜索收藏", empty: "暂无收藏", noMatch: "没有匹配的收藏" },
  note: { search: "搜索笔记", empty: "暂无笔记，点击「＋笔记」开始记录。", noMatch: "没有匹配的笔记" },
  todo: { search: "搜索待办", empty: "暂无待办，点击「＋待办」添加事项。", noMatch: "没有匹配的待办" },
  all: { search: "搜索笔记和待办", empty: "暂无笔记或待办。", noMatch: "没有匹配的笔记或待办" },
  archived: { search: "搜索归档", empty: "暂无归档内容。", noMatch: "没有匹配的归档内容" },
  trash: { search: "搜索最近删除", empty: "最近删除为空。", noMatch: "没有匹配的已删除内容" },
};

export function privateSpaceSearchLabel(filter: SpaceFilter) {
  return presentation[filter].search;
}

export function privateSpaceEmptyMessage(filter: SpaceFilter, query: string) {
  return query.trim() ? presentation[filter].noMatch : presentation[filter].empty;
}
