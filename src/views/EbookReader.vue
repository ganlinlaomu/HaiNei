<template>
  <main class="reader-page" :class="['theme-' + theme, 'mode-' + readingMode]">
    <header class="reader-header">
      <button type="button" aria-label="返回书架" @click="router.push('/books')">‹</button>
      <div><strong>{{ book?.title || "电子书" }}</strong><small>{{ epub ? (epub.chapters[chapterIndex]?.title || "") : "" }}</small></div>
      <button type="button" :aria-expanded="settingsOpen" aria-label="阅读设置" @click="settingsOpen = !settingsOpen">Aa</button>
    </header>
    <p v-if="error" class="reader-message" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="reader-message">正在从本地书架打开 EPUB…</p>
    <template v-else-if="epub">
      <section v-if="settingsOpen" class="settings" aria-label="阅读设置">
        <label>字号 <button type="button" @click="changeFont(-2)">A−</button> {{ fontSize }} <button type="button" @click="changeFont(2)">A＋</button></label>
        <label>阅读 <select v-model="readingMode" aria-label="阅读模式" @change="refreshChapter"><option value="paged">左右翻页</option><option value="scroll">上下滚动</option></select></label>
        <label>字体 <select v-model="readerFont" aria-label="阅读字体" @change="refreshChapter"><option value="serif">书籍（宋体／明朝）</option><option value="sans">清晰（黑体）</option></select></label>
        <label>背景 <select v-model="theme" @change="refreshChapter"><option value="light">白色</option><option value="sepia">米色</option><option value="dark">夜间</option></select></label>
        <label>目录 <select :value="chapterIndex" @change="selectChapter"><option v-for="(item,i) in epub.chapters" :key="item.path" :value="i">{{ item.title }}</option></select></label>
        <div class="dictionary-settings">
          <span>离线英汉词典 · 5 万词</span>
          <span v-if="dictionaryStatus === 'installed'" class="dictionary-ready">已安装</span>
          <button v-else type="button" :disabled="dictionaryStatus === 'downloading'" @click="downloadDictionary">
            {{ dictionaryStatus === "downloading" ? "正在下载 " + dictionaryProgress + "%" : "下载词典" }}
          </button>
        </div>
        <form class="dictionary-manual" @submit.prevent="lookupManualWord">
          <label for="ebook-lookup-word">手动查词</label>
          <input id="ebook-lookup-word" v-model="manualWord" type="search" placeholder="输入英文单词" autocomplete="off"/>
          <button type="submit">查询</button>
        </form>
        <p v-if="dictionaryError" class="dictionary-error" role="alert">{{ dictionaryError }}</p>
        <p class="settings-tip">轻点英文单词查词 · 长按选句摘录</p>
      </section>
      <div ref="scroller" class="chapter-scroller" @scroll.passive="onScroll">
        <div class="chapter-stage" :class="{ 'is-turning': !!turnPreview }">
          <div class="chapter-sheet" :class="{ 'turn-out': turnPreview?.ready && turnPreview.direction === 1, 'under-back': turnPreview?.ready && turnPreview.direction === -1 }" @animationend="turnAnimationEnd">
            <iframe ref="frame" class="chapter-frame" title="电子书正文" sandbox="allow-same-origin" :srcdoc="chapterHtml" @load="frameLoaded" />
            <div class="sheet-sheen" aria-hidden="true" />
          </div>
          <div v-if="readingMode === 'paged'" class="chapter-sheet chapter-preview" :class="{ 'preview-active': turnPreview?.ready, 'preview-back': turnPreview?.direction === -1, 'under': turnPreview?.ready && turnPreview.direction === 1, 'turn-in': turnPreview?.ready && turnPreview.direction === -1 }" @animationend="turnAnimationEnd" aria-hidden="true">
            <iframe ref="previewFrame" class="chapter-frame" title="翻页预览" tabindex="-1" sandbox="allow-same-origin" :srcdoc="chapterHtml" @load="previewLoaded" />
            <div class="sheet-sheen" aria-hidden="true" />
          </div>
          <div v-if="excerptRects.length" class="excerpt-highlights" aria-hidden="true"><span v-for="(box, i) in excerptRects" :key="i" :style="{ left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' }" /></div>
          <div class="chapter-tap-layer" aria-hidden="true" @click="lookupTappedWord"
            @pointerdown="excerptPointerDown" @pointermove="excerptPointerMove" @pointerup="excerptPointerUp"
            @pointercancel="excerptPointerCancel" @touchmove="excerptTouchMove" @contextmenu.prevent />
        </div>
      </div>
      <aside v-if="excerptSpan && !excerptDragging" class="excerpt-bar" role="toolbar" aria-label="摘录选中的文字">
        <div class="excerpt-bar-info">
          <span>已选 {{ excerptLength }} 字<template v-if="excerptLength > MAX_EXCERPT_CHARS">（摘录时保留前 {{ MAX_EXCERPT_CHARS }} 字）</template></span>
          <button type="button" aria-label="取消选择" @click="clearExcerpt">×</button>
        </div>
        <div class="excerpt-bar-actions">
          <button type="button" @click="growExcerpt('before')">‹ 前一句</button>
          <button type="button" @click="growExcerpt('after')">后一句 ›</button>
          <button type="button" @click="copyExcerpt">复制</button>
          <button v-if="excerptWord" type="button" @click="lookupExcerptWord">查词</button>
          <button type="button" class="excerpt-primary" @click="publishExcerpt">摘录</button>
        </div>
      </aside>
      <aside v-if="selectedWord" class="dictionary-card" aria-label="英汉单词释义" role="dialog">
        <div class="dictionary-card-header">
          <strong>{{ dictionaryEntry?.word || selectedWord }}</strong>
          <button type="button" aria-label="发音" title="英文发音" @click="speakWord">🔊</button>
          <button type="button" aria-label="关闭查词" @click="dismissLookup">×</button>
        </div>
        <small v-if="dictionaryEntry?.phonetic" class="dictionary-phonetic">{{ dictionaryEntry.phonetic }}</small>
        <p v-if="dictionaryLookingUp" class="dictionary-message">正在查词…</p>
        <p v-else-if="dictionaryEntry" class="dictionary-meaning">{{ dictionaryEntry.translation }}</p>
        <p v-else-if="dictionaryStatus === 'installed'" class="dictionary-message">本地词库暂未收录此词。</p>
        <div v-else class="dictionary-uninstalled">
          <p>首次使用需下载英汉词库；安装后可断网查词。</p>
          <button type="button" :disabled="dictionaryStatus === 'downloading'" @click="downloadDictionary">
            {{ dictionaryStatus === "downloading" ? "下载中 " + dictionaryProgress + "%" : "下载离线词典（约 5 万词）" }}
          </button>
        </div>
        <p v-if="dictionaryError" class="dictionary-error" role="alert">{{ dictionaryError }}</p>
        <small class="dictionary-credit">{{ DICTIONARY_ATTRIBUTION }}</small>
      </aside>
      <footer class="reader-footer">
        <template v-if="readingMode === 'paged'">
          <button type="button" aria-label="上一页" :disabled="!!turnPreview || (chapterIndex === 0 && pageIndex === 0)" @click="turnPage(-1)">‹ 上一页</button>
          <span>第 {{ pageIndex + 1 }} / {{ pageCount }} 页 · {{ chapterIndex + 1 }}/{{ epub.chapters.length }} 章</span>
          <button type="button" aria-label="下一页" :disabled="!!turnPreview || (chapterIndex === epub.chapters.length - 1 && pageIndex === pageCount - 1)" @click="turnPage(1)">下一页 ›</button>
        </template>
        <template v-else>
          <button type="button" :disabled="chapterIndex === 0" @click="loadChapter(chapterIndex-1,0)">上一章</button>
          <span>{{ chapterIndex + 1 }} / {{ epub.chapters.length }} · {{ Math.round(chapterPercent*100) }}%</span>
          <button type="button" :disabled="chapterIndex === epub.chapters.length-1" @click="loadChapter(chapterIndex+1,0)">下一章</button>
        </template>
      </footer>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { getLibraryBook, saveLibraryCover, updateReadingState, type LibraryBook } from "@/services/ebookLibrary";
import { OfflineEpub } from "@/services/ebookEpub";
import { pageCountForWidth, pageForPercent, percentForPage } from "@/services/ebookPagination";
import { DICTIONARY_ATTRIBUTION, installDictionary, isDictionaryInstalled, lookupDictionary, normalizeSelection, type DictionaryEntry } from "@/services/ebookDictionary";
import { wordAtPoint } from "@/services/ebookWordSelection";
import {
  ChapterTextIndex, MAX_EXCERPT_CHARS, excerptText, extendSpan, formatExcerptPost, growBySentence, sentenceBounds,
  type TextSpan,
} from "@/services/ebookExcerpt";
import { useUIStore } from "@/stores/ui";

const keys = useKeyStore(), ui = useUIStore(), route = useRoute(), router = useRouter();
const book = ref<LibraryBook|null>(null), epub = ref<OfflineEpub|null>(null);
const chapterIndex = ref(0), chapterPercent = ref(0), chapterHtml = ref("");
const fontSize = ref(18), theme = ref<"light"|"sepia"|"dark">("light");
const readingMode = ref<"paged"|"scroll">("paged"), readerFont = ref<"serif"|"sans">("serif");
const pageIndex = ref(0), pageCount = ref(1);
type PageTurnPreview = { token: number; page: number; direction: -1 | 1; ready: boolean };
const turnPreview = ref<PageTurnPreview | null>(null);
const previewFrame = ref<HTMLIFrameElement | null>(null);
const previewPrepared = ref(false);
let previewRevision = 0;
const watchedChapterFonts = new WeakSet<Document>();
let turnToken = 0;
let turnTimer: ReturnType<typeof setTimeout> | null = null;
const loading = ref(true), error = ref(""), settingsOpen = ref(false);
const frame = ref<HTMLIFrameElement|null>(null);
const selectedWord = ref(""), manualWord = ref(""), dictionaryEntry = ref<DictionaryEntry|null>(null);
const dictionaryStatus = ref<"checking"|"not-installed"|"downloading"|"installed">("checking");
const dictionaryProgress = ref(0), dictionaryError = ref(""), dictionaryLookingUp = ref(false);
let lookupRevision = 0, readerAlive = true;
const scroller = ref<HTMLDivElement|null>(null);
const account = computed(() => keys.pkHex);
const id = computed(() => String(route.params.id || ""));
let loadedAccount = "";
let restorePercent = 0, saveTimer: ReturnType<typeof setTimeout>|null = null, chapterRequest = 0;
let readerResizeObserver: ResizeObserver | null = null;
function explanation(e:unknown) { return e instanceof Error ? e.message : "无法打开这本电子书"; }
function saveSoon() {
  if (!loadedAccount || !book.value) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void saveNow(); }, 400);
}
async function saveNow() {
  if (!loadedAccount || !book.value) return;
  try {
    await updateReadingState(loadedAccount, book.value.id, {
      chapterIndex: chapterIndex.value, chapterPercent: chapterPercent.value,
      fontSize: fontSize.value, theme: theme.value,
      readingMode: readingMode.value, readerFont: readerFont.value,
    });
  } catch { /* Storage errors must not stop a reading session. */ }
}
async function loadChapter(index:number, percent:number) {
  if (!epub.value || index < 0 || index >= epub.value.chapters.length) return;
  cancelTurn();
  previewPrepared.value = false;
  ++previewRevision;
  dismissLookup();
  clearExcerpt();
  const request = ++chapterRequest;
  error.value = "";
  try {
    const html = await epub.value.renderChapter(index,fontSize.value,theme.value,readerFont.value,readingMode.value);
    if (request !== chapterRequest) return;
    chapterIndex.value = index;
    chapterPercent.value = percent;
    restorePercent = percent;
    chapterHtml.value = html;
    saveSoon();
  } catch(e) { if (request === chapterRequest) error.value = explanation(e); }
}
function frameLoaded() {
  const doc = frame.value?.contentDocument;
  const container = scroller.value;
  const iframe = frame.value;
  if (!doc || !container || !iframe || !epub.value) return;
  // EPUB scripts remain disabled: all measuring/turning happens in our parent.
  textIndex = null;
  clearExcerpt();
  if (readingMode.value === "paged") {
    // CSS columns flow off-screen horizontally, one viewport-width column per page.
    // The iframe remains viewport-sized so selection/caret coordinates stay correct.
    container.scrollTop = 0; // clear scroll-mode position on mode switch
    iframe.style.height = Math.max(1, container.clientHeight) + "px";
    const scrollRoot = doc.scrollingElement || doc.documentElement;
    const width = Math.max(1, iframe.clientWidth);
    pageCount.value = pageCountForWidth(Math.max(scrollRoot.scrollWidth, doc.body.scrollWidth), width);
    pageIndex.value = pageForPercent(restorePercent, pageCount.value);
    const maxLeft = Math.max(0, scrollRoot.scrollWidth - width);
    scrollRoot.scrollLeft = Math.min(maxLeft, pageIndex.value * width);
    chapterPercent.value = percentForPage(pageIndex.value, pageCount.value);
    layoutPreviewFrame();
  } else {
    iframe.style.height = "1px";
    const height = Math.max(1, doc.documentElement.scrollHeight, doc.body.scrollHeight);
    iframe.style.height = height + "px";
    pageIndex.value = 0;
    pageCount.value = 1;
    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.round(max * restorePercent);
  }
  // Font downloads/reflow must not silently change page count or reader position.
  if (doc.fonts && !watchedChapterFonts.has(doc)) {
    watchedChapterFonts.add(doc);
    void doc.fonts.ready.then(() => {
      if (!readerAlive || frame.value?.contentDocument !== doc) return;
      restorePercent = chapterPercent.value;
      frameLoaded();
    }).catch(() => {});
  }
}

/** Abandon any pending preview if the chapter, layout or reader changes. */
function cancelTurn() {
  ++turnToken;
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  turnPreview.value = null;
}

function moveToPage(index: number) {
  const iframe = frame.value;
  const doc = iframe?.contentDocument;
  if (!iframe || !doc) return;
  const root = doc.scrollingElement || doc.documentElement;
  const width = Math.max(1, iframe.clientWidth);
  const max = Math.max(0, root.scrollWidth - width);
  root.scrollLeft = Math.min(max, Math.max(0, index * width));
  pageIndex.value = index;
  chapterPercent.value = percentForPage(index, pageCount.value);
  restorePercent = chapterPercent.value;
  saveSoon();
}

/** Commit the target only AFTER the turning page has finished moving. */
function finishTurn(token: number) {
  const preview = turnPreview.value;
  if (!preview || token !== preview.token) return;
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  moveToPage(preview.page);
  // The still-mounted base iframe now shows the same page as the preview.
  turnPreview.value = null;
}

function turnAnimationEnd(event: AnimationEvent) {
  const preview = turnPreview.value;
  if (!preview?.ready || event.target !== event.currentTarget) return;
  // Ignore the shadow animations; only the page's 3-D rotation completes a turn.
  if (event.animationName === "ebook-turn-out" || event.animationName === "ebook-turn-in") finishTurn(preview.token);
}

/** The preview is mounted ONCE per chapter, not loaded/reparsed on every swipe. */
function layoutPreviewFrame(): boolean {
  const iframe = previewFrame.value;
  const doc = iframe?.contentDocument;
  const container = scroller.value;
  if (!iframe || !doc || !container) return false;
  iframe.style.height = Math.max(1, container.clientHeight) + "px";
  return iframe.clientWidth > 0;
}

function previewLoaded() {
  const doc = previewFrame.value?.contentDocument;
  if (!doc || readingMode.value !== "paged") return;
  const revision = ++previewRevision;
  previewPrepared.value = false;
  layoutPreviewFrame();
  // CSS fonts may finish asynchronously; start page flips only after their metrics
  // have settled. Avoid doing any network/font/layout work during a flip.
  void (doc.fonts?.ready ?? Promise.resolve()).then(() => {
    if (!readerAlive || revision !== previewRevision || previewFrame.value?.contentDocument !== doc) return;
    previewPrepared.value = layoutPreviewFrame();
  }).catch(() => { previewPrepared.value = false; });
}

function turnPage(delta: -1 | 1) {
  if (readingMode.value !== "paged" || !epub.value || turnPreview.value) return;
  if (excerptSpan.value) clearExcerpt();
  dismissLookup();
  const next = pageIndex.value + delta;
  if (next < 0) {
    if (chapterIndex.value > 0) void loadChapter(chapterIndex.value - 1, 1);
    return;
  }
  if (next >= pageCount.value) {
    if (chapterIndex.value < epub.value.chapters.length - 1) void loadChapter(chapterIndex.value + 1, 0);
    return;
  }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (reduced || !previewPrepared.value) { moveToPage(next); return; }
  const iframe = previewFrame.value, doc = iframe?.contentDocument;
  if (!iframe || !doc || !layoutPreviewFrame()) { moveToPage(next); return; }
  const root = doc.scrollingElement || doc.documentElement;
  const width = Math.max(1, iframe.clientWidth);
  const left = Math.min(Math.max(0, root.scrollWidth - width), next * width);
  // Programmatic positioning while the sheet is invisible. Never smoothly scroll
  // the iframe; only the opaque paper layer is animated.
  root.scrollLeft = left;
  if (Math.abs(root.scrollLeft - left) > 2) { moveToPage(next); return; }
  const token = ++turnToken;
  turnPreview.value = { token, page: next, direction: delta, ready: false };
  // This fallback also fires if iOS backgrounds the PWA before requestAnimationFrame.
  turnTimer = setTimeout(() => finishTurn(token), 1800);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!readerAlive || turnPreview.value?.token !== token) return;
    // In case font/layout changed while waiting, don't animate a wrong page.
    if (Math.abs(root.scrollLeft - left) > 2) { finishTurn(token); return; }
    turnPreview.value.ready = true;
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => finishTurn(token), 850);
  }));
}

function resizeReader() {
  // Resizing in the middle of a flip must preserve the pending target page.
  if (turnPreview.value) finishTurn(turnPreview.value.token);
  if (readingMode.value !== "paged") { relayoutExcerpt(); return; }
  restorePercent = chapterPercent.value;
  frameLoaded();
  layoutPreviewFrame();
}

function dismissLookup() {
  lookupRevision++;
  selectedWord.value = "";
  dictionaryEntry.value = null;
  dictionaryLookingUp.value = false;
}
function openDictionaryWord(word: string) {
  if (word === selectedWord.value) return;
  selectedWord.value = word;
  dictionaryEntry.value = null;
  dictionaryError.value = "";
  const revision = ++lookupRevision;
  if (dictionaryStatus.value !== "installed") return;
  dictionaryLookingUp.value = true;
  void lookupDictionary(word).then(entry => {
    if (readerAlive && revision === lookupRevision) dictionaryEntry.value = entry;
  }).catch(() => {
    if (readerAlive && revision === lookupRevision) dictionaryError.value = "词库读取失败，请重新下载词典";
  }).finally(() => {
    if (readerAlive && revision === lookupRevision) dictionaryLookingUp.value = false;
  });
}
// WebKit never fires parent-installed listeners inside the script-disabled
// srcdoc iframe, so taps land on a parent-owned layer above it. A click only
// fires for a tap (not a scroll); the caret lookup itself is a plain DOM call.
function lookupTappedWord(event: MouseEvent) {
  // The click a long press's own release may synthesise is not a tap.
  if (event.timeStamp - excerptGestureEndedAt < 200) return;
  if (excerptSpan.value) { clearExcerpt(); return; }
  // Page-edge taps are reserved for turning; central taps keep offline word lookup.
  if (readingMode.value === "paged") {
    const bounds = scroller.value?.getBoundingClientRect();
    if (bounds) {
      const edge = Math.min(48, bounds.width * 0.14);
      if (event.clientX - bounds.left < edge) { turnPage(-1); return; }
      if (bounds.right - event.clientX < edge) { turnPage(1); return; }
    }
  }
  const doc = frame.value?.contentDocument;
  const rect = frame.value?.getBoundingClientRect();
  if (!doc || !rect) return;
  const word = wordAtPoint(doc, event.clientX - rect.left, event.clientY - rect.top);
  if (word) openDictionaryWord(word);
  else if (selectedWord.value) dismissLookup();
}
// Long-press excerpts. The system selection cannot start under the tap
// layer, so a long press picks the sentence under the finger, dragging moves
// the far end, and the highlight is drawn by us from the range's rects.
const LONG_PRESS_MS = 450, PRESS_MOVE_TOLERANCE = 10;
type HighlightBox = { left: number; top: number; width: number; height: number };
const excerptSpan = ref<TextSpan|null>(null), excerptRects = ref<HighlightBox[]>([]), excerptDragging = ref(false);
let textIndex: ChapterTextIndex | null = null, excerptAnchor: TextSpan | null = null;
let press: { id: number; x: number; y: number; target: Element | null; timer: ReturnType<typeof setTimeout> | null } | null = null;
let excerptGestureEndedAt = -Infinity;
let pageSwipe: { id: number; x: number; y: number } | null = null;
const excerptValue = computed(() => excerptSpan.value && textIndex ? excerptText(textIndex.text, excerptSpan.value) : "");
const excerptLength = computed(() => Array.from(excerptValue.value).length);
const excerptWord = computed(() => /^[A-Za-z'’-]+[.,;:!?"”’)]*$/.test(excerptValue.value) ? normalizeSelection(excerptValue.value) : null);
function chapterText() {
  const doc = frame.value?.contentDocument;
  if (!doc?.body) return null;
  if (!textIndex) textIndex = new ChapterTextIndex(doc);
  return textIndex;
}
function offsetAtClient(clientX: number, clientY: number) {
  const rect = frame.value?.getBoundingClientRect();
  const index = chapterText();
  return rect && index ? index.offsetAtPoint(clientX - rect.left, clientY - rect.top) : null;
}
function setExcerpt(span: TextSpan) {
  if (span.end <= span.start || !textIndex) return;
  excerptSpan.value = span;
  excerptRects.value = textIndex.rects(span);
}
function clearExcerpt() {
  cancelPress();
  excerptSpan.value = null;
  excerptRects.value = [];
  excerptAnchor = null;
  excerptDragging.value = false;
}
function cancelPress() {
  if (press?.timer) clearTimeout(press.timer);
  press = null;
}
function excerptPointerDown(event: PointerEvent) {
  if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
  cancelPress();
  pageSwipe = readingMode.value === "paged" ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  const current = { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.currentTarget as Element | null, timer: null as ReturnType<typeof setTimeout> | null };
  current.timer = setTimeout(() => startExcerpt(current), LONG_PRESS_MS);
  press = current;
}
function startExcerpt(current: NonNullable<typeof press>) {
  if (press !== current) return;
  current.timer = null;
  const offset = offsetAtClient(current.x, current.y);
  const index = textIndex;
  if (offset === null || !index) { cancelPress(); return; }
  const span = sentenceBounds(index.text, offset);
  const rect = frame.value?.getBoundingClientRect();
  // Browsers snap a caret in blank margins to the nearest text; only start
  // a selection when the finger is actually on (or right next to) it.
  const x = current.x - (rect?.left || 0), y = current.y - (rect?.top || 0);
  const onText = index.rects(span).some(box =>
    x >= box.left - 24 && x <= box.left + box.width + 24 && y >= box.top - 12 && y <= box.top + box.height + 12);
  if (span.end <= span.start || !onText) { cancelPress(); return; }
  dismissLookup();
  excerptAnchor = span;
  setExcerpt(span);
  excerptDragging.value = true;
  try { navigator.vibrate?.(8); } catch { /* optional */ }
  try { current.target?.setPointerCapture?.(current.id); } catch { /* pointer already gone */ }
}
function excerptPointerMove(event: PointerEvent) {
  if (!press || event.pointerId !== press.id) return;
  if (!excerptDragging.value) {
    // Moving before the long press fires is a scroll, not a selection.
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_MOVE_TOLERANCE) cancelPress();
    return;
  }
  const offset = offsetAtClient(event.clientX, event.clientY);
  if (offset !== null && excerptAnchor && textIndex) setExcerpt(extendSpan(textIndex.text, excerptAnchor, offset));
}
function excerptTouchMove(event: TouchEvent) {
  // Once selecting, the finger extends the selection instead of scrolling.
  if (excerptDragging.value && event.cancelable) event.preventDefault();
}
function excerptPointerUp(event: PointerEvent) {
  const swipe = pageSwipe?.id === event.pointerId ? pageSwipe : null;
  pageSwipe = null;
  const selecting = excerptDragging.value;
  if (press?.id === event.pointerId) {
    cancelPress();
    excerptDragging.value = false;
    if (selecting) excerptGestureEndedAt = event.timeStamp;
  }
  if (!selecting && swipe) {
    const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
    if (Math.abs(dx) >= 54 && Math.abs(dx) > Math.abs(dy) * 1.35) {
      excerptGestureEndedAt = event.timeStamp; // suppress the synthetic click
      turnPage(dx < 0 ? 1 : -1);
    }
  }
}
function excerptPointerCancel(event: PointerEvent) {
  if (pageSwipe?.id === event.pointerId) pageSwipe = null;
  if (!press || event.pointerId !== press.id) return;
  cancelPress();
  excerptDragging.value = false;
}

function growExcerpt(direction: "before" | "after") {
  if (!excerptSpan.value || !textIndex) return;
  const span = growBySentence(textIndex.text, excerptSpan.value, direction);
  excerptAnchor = span;
  setExcerpt(span);
}
async function copyExcerpt() {
  const text = excerptValue.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ui.addToast("已复制", 1500, "success");
    clearExcerpt();
  } catch {
    ui.addToast("复制失败，请改用摘录", 2000, "error");
  }
}
function lookupExcerptWord() {
  const word = excerptWord.value;
  clearExcerpt();
  if (word) openDictionaryWord(word);
}
function publishExcerpt() {
  const text = excerptValue.value;
  if (!text) return;
  const prefill = formatExcerptPost(text, {
    title: book.value?.title,
    authors: book.value?.authors,
    chapter: epub.value?.chapters[chapterIndex.value]?.title,
  });
  clearExcerpt();
  // The composer lets the user pick 动态 (friends) or 笔记 (only me).
  ui.openPostEditor(undefined, prefill);
}
function relayoutExcerpt() {
  if (excerptSpan.value && textIndex) excerptRects.value = textIndex.rects(excerptSpan.value);
}
function lookupManualWord() {
  const word = normalizeSelection(manualWord.value);
  if (!word) {
    dictionaryError.value = "请输入一个英文单词";
    return;
  }
  openDictionaryWord(word);
  settingsOpen.value = false;
}
async function refreshDictionaryLookup() {
  if (!selectedWord.value || dictionaryStatus.value !== "installed") return;
  const revision = ++lookupRevision;
  dictionaryLookingUp.value = true;
  try {
    const entry = await lookupDictionary(selectedWord.value);
    if (readerAlive && revision === lookupRevision) dictionaryEntry.value = entry;
  } catch {
    if (readerAlive && revision === lookupRevision) dictionaryError.value = "词库读取失败";
  } finally {
    if (readerAlive && revision === lookupRevision) dictionaryLookingUp.value = false;
  }
}
async function downloadDictionary() {
  if (dictionaryStatus.value === "downloading" || dictionaryStatus.value === "installed") return;
  dictionaryStatus.value = "downloading";
  dictionaryError.value = "";
  dictionaryProgress.value = 0;
  try {
    await installDictionary((done, total) => {
      if (readerAlive) dictionaryProgress.value = Math.round(done / total * 100);
    });
    if (!readerAlive) return;
    dictionaryStatus.value = "installed";
    await refreshDictionaryLookup();
  } catch (error) {
    if (!readerAlive) return;
    dictionaryStatus.value = "not-installed";
    dictionaryError.value = error instanceof Error ? error.message : "词典安装失败，请稍后重试";
  }
}
function speakWord() {
  if (!selectedWord.value) return;
  if (typeof window.speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
    dictionaryError.value = "此设备暂不支持语音朗读";
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(dictionaryEntry.value?.word || selectedWord.value);
    utterance.lang = "en-US";
    utterance.rate = 0.88;
    window.speechSynthesis.speak(utterance);
  } catch { dictionaryError.value = "发音失败，请检查系统语音设置"; }
}
function onScroll() {
  const container = scroller.value;
  if (!container || !epub.value || readingMode.value === "paged") return;
  const available = Math.max(0,container.scrollHeight - container.clientHeight);
  chapterPercent.value = available ? Math.max(0,Math.min(1,container.scrollTop / available)) : 1;
  saveSoon();
}
function refreshChapter() { void loadChapter(chapterIndex.value,chapterPercent.value); }
function changeFont(delta:number) { fontSize.value = Math.max(14,Math.min(28,fontSize.value+delta)); refreshChapter(); }
function selectChapter(event:Event) { void loadChapter(Number((event.target as HTMLSelectElement).value),0); }
async function init() {
  if (!account.value) { error.value = "请先登录海内"; loading.value = false; return; }
  const owner = account.value;
  try {
    const stored = await getLibraryBook(owner,id.value);
    if (!stored || owner !== account.value) throw new Error("本设备未找到这本书，请重新下载");
    const parsed = await OfflineEpub.open(stored.file);
    if (owner !== account.value) { parsed.destroy(); return; }
    loadedAccount = owner; book.value = stored; epub.value = parsed;
    // Upgrade existing downloads lazily, without re-downloading the EPUB.
    if (!stored.coverBlob) {
      void parsed.coverImage().then(cover => {
        if (cover && readerAlive && loadedAccount === owner) return saveLibraryCover(owner, stored.id, cover);
      }).catch(() => {});
    }
    fontSize.value = stored.fontSize || 18;
    theme.value = stored.theme || "light";
    readingMode.value = stored.readingMode === "scroll" ? "scroll" : "paged";
    readerFont.value = stored.readerFont === "sans" ? "sans" : "serif";
    await nextTick();
    await loadChapter(Math.min(stored.chapterIndex||0,parsed.chapters.length-1),stored.chapterPercent||0);
  } catch(e) { error.value = explanation(e); }
  finally { loading.value = false; }
}
watch(account,(next) => { if (loadedAccount && next !== loadedAccount) void router.replace("/settings"); });
watch(scroller, (element) => {
  readerResizeObserver?.disconnect();
  if (element && typeof ResizeObserver !== "undefined") {
    readerResizeObserver = new ResizeObserver(resizeReader);
    readerResizeObserver.observe(element);
  }
});
watch(settingsOpen, async () => { await nextTick(); resizeReader(); });
onMounted(() => {
  window.addEventListener("resize", resizeReader);
  void init();
  void isDictionaryInstalled().then(installed => {
    if (readerAlive && dictionaryStatus.value === "checking") {
      dictionaryStatus.value = installed ? "installed" : "not-installed";
      if (installed && selectedWord.value) void refreshDictionaryLookup();
    }
  }).catch(() => {
    if (readerAlive && dictionaryStatus.value === "checking") dictionaryStatus.value = "not-installed";
  });
});
onUnmounted(() => {
  window.removeEventListener("resize", resizeReader);
  readerResizeObserver?.disconnect();
  cancelTurn();
  clearExcerpt();
  pageSwipe = null;
  readerAlive = false;
  lookupRevision++;
  chapterRequest++;
  if (saveTimer) clearTimeout(saveTimer);
  void saveNow();
  epub.value?.destroy();
});
</script>
<style scoped>
.reader-page{position:fixed;inset:0;display:flex;flex-direction:column;z-index:50;background:#fff;color:#242830;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
.reader-page.theme-sepia{background:#f3ecdc;color:#2a251e}
.reader-page.theme-dark{background:#20252b;color:#e5e7eb}
.reader-header{display:flex;align-items:center;justify-content:space-between;min-height:50px;border-bottom:1px solid #8882;gap:8px}
.reader-header>button{width:50px;min-height:44px;border:0;background:transparent;color:inherit;font-size:26px;cursor:pointer}
.reader-header>div{display:grid;min-width:0;gap:3px;text-align:center}
.reader-header strong{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px}
.reader-header small{color:inherit;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.settings-tip{width:100%;margin:0;font-size:12px;opacity:.6}
.chapter-scroller{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.mode-paged .chapter-scroller{overflow:hidden}
.mode-paged .chapter-tap-layer{touch-action:none}
.chapter-stage{position:relative}
.chapter-sheet{position:relative;width:100%}
.mode-paged .chapter-stage{height:100%;perspective:1800px;isolation:isolate}
.mode-paged .chapter-sheet{height:100%;transform-origin:left center;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:var(--reader-paper,#fff);will-change:auto;-webkit-transform-style:preserve-3d;transform-style:preserve-3d}
.reader-page.theme-sepia{--reader-paper:#f3ecdc;--reader-ink-shadow:rgba(42,28,9,.2)}
.reader-page.theme-dark{--reader-paper:#20252b;--reader-ink-shadow:rgba(0,0,0,.5)}
.reader-page.theme-light{--reader-paper:#fff;--reader-ink-shadow:rgba(40,28,10,.16)}
.mode-paged .chapter-preview{position:absolute;inset:0;z-index:1;pointer-events:none;visibility:hidden;opacity:0}
.mode-paged .chapter-preview.preview-active{visibility:visible;opacity:1}
.mode-paged .chapter-preview.preview-back{transform:rotateY(-104deg)}
.mode-paged .is-turning .chapter-sheet{will-change:transform}
.mode-paged .chapter-sheet:not(.chapter-preview){z-index:2}
.mode-paged .chapter-preview.turn-in{z-index:3}
.mode-paged .chapter-sheet::before{content:"";position:absolute;inset:0 auto 0 0;width:14px;z-index:2;pointer-events:none;background:linear-gradient(to right,var(--reader-ink-shadow),transparent)}
.mode-paged .chapter-sheet::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:2;background:var(--reader-ink-shadow);opacity:0}
.mode-paged .chapter-sheet.under::after{animation:ebook-shade-out .58s forwards}
.mode-paged .chapter-sheet.under-back::after{animation:ebook-shade-in .58s forwards}
.mode-paged .chapter-sheet.turn-out{animation:ebook-turn-out .58s cubic-bezier(.35,.05,.25,1) both}
.mode-paged .chapter-sheet.turn-in{animation:ebook-turn-in .58s cubic-bezier(.35,.05,.25,1) both}
.sheet-sheen{position:absolute;inset:0;pointer-events:none;z-index:2;opacity:0;background:linear-gradient(to left,var(--reader-ink-shadow),transparent 70%)}
.mode-paged .turn-out>.sheet-sheen{animation:ebook-shade-in .58s forwards}
.mode-paged .turn-in>.sheet-sheen{opacity:1;animation:ebook-shade-out .58s forwards}
@keyframes ebook-turn-out{to{transform:rotateY(-104deg)}}
@keyframes ebook-turn-in{from{transform:rotateY(-104deg)}to{transform:rotateY(0)}}
@keyframes ebook-shade-in{to{opacity:1}}
@keyframes ebook-shade-out{from{opacity:1}to{opacity:0}}
@media (prefers-reduced-motion:reduce){.mode-paged .chapter-sheet{animation:none!important}.mode-paged .sheet-sheen{animation:none!important}}
.chapter-frame{display:block;width:100%;height:1px;border:0;background:transparent}
.mode-paged .chapter-preview .chapter-frame{height:100%;pointer-events:none}
.chapter-tap-layer{position:absolute;inset:0;z-index:5;cursor:pointer;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
.excerpt-highlights{position:absolute;inset:0;z-index:4;pointer-events:none}
.is-turning .chapter-tap-layer{pointer-events:none}
.excerpt-highlights span{position:absolute;border-radius:2px;background:#3b82f647}
.reader-page.theme-dark .excerpt-highlights span{background:#60a5fa59}
.excerpt-bar{position:fixed;z-index:56;left:10px;right:10px;bottom:calc(62px + env(safe-area-inset-bottom));max-width:560px;margin:0 auto;padding:8px 10px 10px;border-radius:14px;border:1px solid #8b8b8b35;box-shadow:0 8px 30px #0003;background:#fff;color:#242830}
.reader-page.theme-sepia .excerpt-bar{background:#fff9ed;color:#433c31}
.reader-page.theme-dark .excerpt-bar{background:#2e343d;color:#f3f4f6}
.excerpt-bar-info{display:flex;align-items:center;justify-content:space-between;font-size:12px;opacity:.8}
.excerpt-bar-info button{min-width:40px;min-height:36px;border:0;background:transparent;color:inherit;font-size:20px}
.excerpt-bar-actions{display:flex;flex-wrap:wrap;gap:6px}
.excerpt-bar-actions button{flex:1 1 auto;min-height:40px;padding:0 10px;border:1px solid #8885;border-radius:9px;background:transparent;color:inherit;font-size:14px;white-space:nowrap}
.excerpt-bar-actions .excerpt-primary{border-color:#2563eb;background:#2563eb;color:#fff;font-weight:600}
.reader-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:50px;padding:2px 10px;border-top:1px solid #8882}
.reader-footer button{border:0;color:inherit;background:transparent;min-height:40px;padding:0 12px;font-size:14px}
.reader-footer button:disabled{opacity:.3}
.reader-footer span{font-size:12px;opacity:.65;font-variant-numeric:tabular-nums;text-align:center}
.reader-message{margin:auto;padding:24px;font-size:14px;line-height:1.6}
.settings{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #8884;font-size:13px}
.settings label{display:flex;align-items:center;gap:6px}
.settings button,.settings select{min-height:34px;border:1px solid #8885;border-radius:8px;background:transparent;color:inherit;padding:4px 7px}
.settings select{max-width:180px;font-size:16px}
.dictionary-settings{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dictionary-manual{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%}
.dictionary-manual input{flex:1;min-width:120px;min-height:40px;border:1px solid #8885;border-radius:8px;background:transparent;color:inherit;padding:4px 10px;font-size:16px}
.dictionary-manual button{min-height:40px}
.dictionary-ready{color:#16803d;font-weight:600}
.dictionary-error{color:#b91c1c;font-size:12px;line-height:1.5}
.dictionary-card{position:fixed;z-index:55;left:12px;right:12px;bottom:calc(62px + env(safe-area-inset-bottom));max-width:520px;margin:0 auto;padding:14px 16px;border-radius:14px;border:1px solid #8b8b8b35;box-shadow:0 8px 30px #0003;background:var(--bg-fff,#fff);color:var(--fg-172033,#242830)}
.reader-page.theme-sepia .dictionary-card{background:#fff9ed;color:#433c31}
.reader-page.theme-dark .dictionary-card{background:#2e343d;color:#f3f4f6}
.dictionary-card-header{display:flex;align-items:center;gap:8px}
.dictionary-card-header strong{font-size:20px;min-width:0;overflow-wrap:anywhere;flex:1}
.dictionary-card-header button{font-size:21px;min-height:44px;min-width:42px;border:0;background:transparent;color:inherit;cursor:pointer}
.dictionary-phonetic{font-size:13px;opacity:.8}
.dictionary-meaning{font-size:15px;line-height:1.6;margin:8px 0;white-space:pre-wrap;max-height:32vh;overflow:auto}
.dictionary-message,.dictionary-uninstalled p{font-size:13px;line-height:1.5}
.dictionary-uninstalled button{border:0;border-radius:9px;color:#fff;background:#2563eb;min-height:42px;padding:8px 12px}
.dictionary-uninstalled button:disabled{opacity:.6}
.dictionary-credit{font-size:10px;opacity:.55}

</style>