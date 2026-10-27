import { computed, ref } from "vue";
import type { DmSearchResult } from "@/stores/directMessages";

export const DM_SEARCH_PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 180;

type SearchPeerMessages = (peer: string, query: string, options: {
  signal: AbortSignal;
  onBatch: (batch: DmSearchResult[], progress: { complete: boolean }) => void;
}) => Promise<DmSearchResult[]>;

/**
 * Local in-chat search state for one conversation. Results stream in
 * batches from this device's history (never a Relay query); a newer query,
 * another account or another peer discards older results.
 */
export function useDmSearch(options: {
  account: () => string;
  peer: () => string;
  search: SearchPeerMessages;
}) {
  const searchOpen = ref(false);
  const searchQuery = ref("");
  const searchResults = ref<DmSearchResult[]>([]);
  const searching = ref(false);
  const searchComplete = ref(false);
  const searchRenderLimit = ref(DM_SEARCH_PAGE_SIZE);
  const visibleSearchResults = computed(() => searchResults.value.slice(0, searchRenderLimit.value));
  const hiddenSearchResultCount = computed(() => Math.max(0, searchResults.value.length - visibleSearchResults.value.length));
  const searchStatusText = computed(() => {
    if (!searchQuery.value.trim()) return "";
    if (searching.value) return `${searchResults.value.length} 条 · 搜索中`;
    return searchComplete.value ? `${searchResults.value.length} 条 · 已完成` : "";
  });

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchGeneration = 0;
  let searchAbortController: AbortController | null = null;

  function clearSearchTimer() {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = null;
  }
  function cancelSearchRequest() {
    clearSearchTimer();
    searchAbortController?.abort();
    searchAbortController = null;
    searchGeneration += 1;
  }
  function resetSearchResults() {
    searchResults.value = [];
    searchRenderLimit.value = DM_SEARCH_PAGE_SIZE;
    searching.value = false;
    searchComplete.value = false;
  }
  /** Closes the search and drops its query and results (focus is the view's). */
  function resetSearch() {
    cancelSearchRequest();
    searchOpen.value = false;
    searchQuery.value = "";
    resetSearchResults();
  }
  function showMoreSearchResults() {
    searchRenderLimit.value += DM_SEARCH_PAGE_SIZE;
  }
  function mergeSearchBatch(batch: DmSearchResult[]) {
    if (!batch.length) return;
    const merged = new Map(searchResults.value.map(result => [result.id, result]));
    for (const result of batch) merged.set(result.id, result);
    searchResults.value = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }
  /** Removes results that must no longer be shown (e.g. burned messages). */
  function dropSearchResults(hidden: (result: DmSearchResult) => boolean) {
    searchResults.value = searchResults.value.filter(result => !hidden(result));
  }
  function scheduleSearch() {
    cancelSearchRequest();
    const query = searchQuery.value.trim();
    if (!query) {
      resetSearchResults();
      return;
    }

    const generation = ++searchGeneration;
    const account = options.account();
    const peer = options.peer();
    const controller = new AbortController();
    searchAbortController = controller;
    searchResults.value = [];
    searchRenderLimit.value = DM_SEARCH_PAGE_SIZE;
    searching.value = true;
    searchComplete.value = false;

    searchTimer = setTimeout(async () => {
      searchTimer = null;
      const isCurrent = () => generation === searchGeneration
        && !controller.signal.aborted
        && account === options.account()
        && peer === options.peer()
        && query === searchQuery.value.trim();

      try {
        const results = await options.search(peer, query, {
          signal: controller.signal,
          onBatch: (batch, progress) => {
            if (!isCurrent()) return;
            mergeSearchBatch(batch);
            searching.value = !progress.complete;
            searchComplete.value = progress.complete;
          },
        });
        if (!isCurrent()) return;
        searchResults.value = results;
        searching.value = false;
        searchComplete.value = true;
      } catch {
        if (!isCurrent()) return;
        searching.value = false;
        searchComplete.value = true;
      } finally {
        if (searchAbortController === controller) searchAbortController = null;
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  return {
    searchOpen,
    searchQuery,
    searchResults,
    searching,
    searchComplete,
    visibleSearchResults,
    hiddenSearchResultCount,
    searchStatusText,
    scheduleSearch,
    cancelSearchRequest,
    resetSearch,
    showMoreSearchResults,
    dropSearchResults,
  };
}
