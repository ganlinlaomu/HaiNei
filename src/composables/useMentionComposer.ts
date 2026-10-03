import { computed, nextTick, ref, type Ref } from "vue";
import {
  filterMentionCandidates,
  insertMention,
  mentionQueryAtCursor,
  type MentionCandidate,
  type MentionQuery,
} from "@/utils/mentions";

export function useMentionComposer<T extends HTMLInputElement | HTMLTextAreaElement>(
  model: Ref<string>,
  input: Ref<T | null>,
  candidates: Readonly<Ref<readonly MentionCandidate[]>>,
) {
  const query = ref("");
  const activeIndex = ref(0);
  const range = ref<MentionQuery | null>(null);
  const open = ref(false);
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  const selectedMentions = new Map<string, string>();

  function containsMentionLabel(text: string, label: string) {
    const token = `@${label.trim()}`;
    if (token === "@") return false;
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(token, offset);
      if (index < 0) return false;
      const previous = index > 0 ? text[index - 1] : "";
      const next = text[index + token.length] || "";
      const previousOk = !previous || !/[\p{L}\p{N}_]/u.test(previous);
      const nextOk = !next || !/[\p{L}\p{N}_]/u.test(next);
      if (previousOk && nextOk) return true;
      offset = index + 1;
    }
    return false;
  }

  function mentionedPubkeys() {
    const result = new Set<string>();
    for (const [pubkey, label] of selectedMentions) {
      if (containsMentionLabel(model.value, label)) result.add(pubkey);
    }

    // Drafts restored on a later session do not retain the selection map.
    // Recover only unambiguous labels so a same-named friend is never guessed.
    const labels = new Map<string, MentionCandidate[]>();
    for (const candidate of candidates.value) {
      const label = candidate.label.trim();
      if (!label) continue;
      const key = label.normalize("NFKC").toLocaleLowerCase();
      const bucket = labels.get(key) || [];
      bucket.push(candidate);
      labels.set(key, bucket);
    }
    for (const bucket of labels.values()) {
      if (bucket.length !== 1) continue;
      const candidate = bucket[0];
      if (containsMentionLabel(model.value, candidate.label)) result.add(candidate.pubkey.toLowerCase());
    }
    return [...result];
  }

  const matches = computed(() =>
    open.value ? filterMentionCandidates(candidates.value, query.value) : []);

  function close() {
    open.value = false;
    range.value = null;
    query.value = "";
    activeIndex.value = 0;
  }

  function sync(elementOverride?: T | null) {
    const element = elementOverride || input.value;
    if (!element) return close();
    const value = element.value;
    const cursor = element.selectionStart ?? value.length;
    const next = mentionQueryAtCursor(value, cursor);
    if (!next) return close();
    range.value = next;
    query.value = next.query;
    open.value = filterMentionCandidates(candidates.value, next.query, 1).length > 0;
    if (activeIndex.value >= matches.value.length) activeIndex.value = 0;
  }

  function onInput(event?: Event) {
    const element = event?.currentTarget instanceof HTMLInputElement || event?.currentTarget instanceof HTMLTextAreaElement
      ? event.currentTarget as T
      : input.value;
    sync(element);
  }

  function onFocus() {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = null;
    sync();
  }

  function onClick() {
    sync();
  }

  function onBlur() {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = null;
      close();
    }, 120);
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open.value || !matches.value.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex.value = (activeIndex.value + 1) % matches.value.length;
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex.value = (activeIndex.value - 1 + matches.value.length) % matches.value.length;
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void select(matches.value[activeIndex.value] || matches.value[0]);
    }
  }

  async function select(candidate: MentionCandidate) {
    const current = range.value;
    if (!current) return;
    selectedMentions.set(candidate.pubkey.toLowerCase(), candidate.label.trim());
    const next = insertMention(model.value, current, candidate);
    model.value = next.text;
    close();
    await nextTick();
    input.value?.focus();
    input.value?.setSelectionRange(next.cursor, next.cursor);
  }

  return {
    mentionOpen: open,
    mentionMatches: matches,
    mentionActiveIndex: activeIndex,
    syncMention: sync,
    onMentionInput: onInput,
    onMentionFocus: onFocus,
    onMentionClick: onClick,
    onMentionBlur: onBlur,
    onMentionKeydown: onKeydown,
    selectMention: select,
    mentionedPubkeys,
    closeMention: close,
  };
}
