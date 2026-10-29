<template>
  <main class="reader-page" :class="'theme-' + theme">
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
      </section>
      <p class="reader-lookup-hint">{{ dictionaryStatus === "installed" ? "轻点英文单词，离线查看中文释义" : "轻点英文单词查词 · 首次请在 Aa 下载词典" }}</p>
      <div ref="scroller" class="chapter-scroller" @scroll.passive="onScroll"><iframe ref="frame" class="chapter-frame" title="电子书正文" sandbox="allow-same-origin" :srcdoc="chapterHtml" @load="frameLoaded" /></div>
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
        <button type="button" :disabled="chapterIndex === 0" @click="loadChapter(chapterIndex-1,0)">上一章</button>
        <span>{{ chapterIndex + 1 }} / {{ epub.chapters.length }} · {{ Math.round(chapterPercent*100) }}%</span>
        <button type="button" :disabled="chapterIndex === epub.chapters.length-1" @click="loadChapter(chapterIndex+1,0)">下一章</button>
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
import { DICTIONARY_ATTRIBUTION, installDictionary, isDictionaryInstalled, lookupDictionary, normalizeSelection, type DictionaryEntry } from "@/services/ebookDictionary";
import { wordAtPoint } from "@/services/ebookWordSelection";

const keys = useKeyStore(), route = useRoute(), router = useRouter();
const book = ref<LibraryBook|null>(null), epub = ref<OfflineEpub|null>(null);
const chapterIndex = ref(0), chapterPercent = ref(0), chapterHtml = ref("");
const fontSize = ref(18), theme = ref<"light"|"sepia"|"dark">("light");
const loading = ref(true), error = ref(""), settingsOpen = ref(false);
const frame = ref<HTMLIFrameElement|null>(null);
const selectedWord = ref(""), manualWord = ref(""), dictionaryEntry = ref<DictionaryEntry|null>(null);
const dictionaryStatus = ref<"checking"|"not-installed"|"downloading"|"installed">("checking");
const dictionaryProgress = ref(0), dictionaryError = ref(""), dictionaryLookingUp = ref(false);
let selectionDocument: Document|null = null, selectionTimer: ReturnType<typeof setTimeout>|null = null;
let tapLookupTimer: ReturnType<typeof setTimeout>|null = null;
let lastTouchEnd = 0;
let touchStart: { x: number; y: number; at: number } | null = null;
let lookupRevision = 0, readerAlive = true;
const scroller = ref<HTMLDivElement|null>(null);
const account = computed(() => keys.pkHex);
const id = computed(() => String(route.params.id || ""));
let loadedAccount = "";
let restorePercent = 0, saveTimer: ReturnType<typeof setTimeout>|null = null, chapterRequest = 0;
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
    });
  } catch { /* Storage errors must not stop a reading session. */ }
}
async function loadChapter(index:number, percent:number) {
  if (!epub.value || index < 0 || index >= epub.value.chapters.length) return;
  dismissLookup();
  const request = ++chapterRequest;
  error.value = "";
  try {
    const html = await epub.value.renderChapter(index,fontSize.value,theme.value);
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
  if (!doc || !container || !frame.value || !epub.value) return;
  // WebKit blocks parent-installed listeners inside script-sandboxed srcdoc.
  // Scroll in our own page instead, keeping the EPUB iframe script-disabled.
  frame.value.style.height = "1px";
  const contentHeight = Math.max(1,doc.documentElement.scrollHeight,doc.body.scrollHeight);
  frame.value.style.height = contentHeight + "px";
  const max = Math.max(0,container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.round(max * restorePercent);
  // Our own listener runs in the parent origin; publisher scripts remain
  // disabled inside the sandboxed srcdoc iframe.
  // iOS can delay or omit selectionchange inside a script-disabled iframe.
  // Also listen for completed taps/long-presses in the same-origin document;
  // publisher JS remains disabled and no text is transmitted.
  unbindFrameSelection();
  selectionDocument = doc;
  doc.addEventListener("selectionchange", queueSelectedWord);
  doc.addEventListener("touchstart", recordFrameTouchStart, { passive: true });
  doc.addEventListener("touchend", completeFrameTouch, { passive: true });
  doc.addEventListener("touchcancel", cancelFrameTouch, { passive: true });
  doc.addEventListener("mouseup", completeFrameMouse);
}
function unbindFrameSelection() {
  if (!selectionDocument) return;
  selectionDocument.removeEventListener("selectionchange", queueSelectedWord);
  selectionDocument.removeEventListener("touchstart", recordFrameTouchStart);
  selectionDocument.removeEventListener("touchend", completeFrameTouch);
  selectionDocument.removeEventListener("touchcancel", cancelFrameTouch);
  selectionDocument.removeEventListener("mouseup", completeFrameMouse);
  selectionDocument = null;
  touchStart = null;
  if (tapLookupTimer) clearTimeout(tapLookupTimer);
  tapLookupTimer = null;
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
function recordFrameTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) { touchStart = null; return; }
  const point = event.touches[0];
  touchStart = { x: point.clientX, y: point.clientY, at: Date.now() };
}
function cancelFrameTouch() { touchStart = null; }
function completeFrameTouch(event: TouchEvent) {
  lastTouchEnd = Date.now();
  const start = touchStart;
  touchStart = null;
  if (!start || event.changedTouches.length !== 1 || event.touches.length !== 0) return;
  const point = event.changedTouches[0];
  if (Math.hypot(start.x - point.clientX, start.y - point.clientY) > 14) return;
  // Prefer an actual selection on a long press, but allow a quick single tap
  // to resolve its word without relying on iOS native selection menus.
  scheduleFrameWord(point.clientX, point.clientY, Date.now() - start.at >= 450);
}
function completeFrameMouse(event: MouseEvent) {
  // Mobile Safari may synthesize a mouseup after touchend; do not override
  // the user's tapped word with an older native selection.
  if (event.button !== 0 || Date.now() - lastTouchEnd < 850) return;
  scheduleFrameWord(event.clientX, event.clientY, true);
}
function scheduleFrameWord(x: number, y: number, preferSelection: boolean) {
  const doc = selectionDocument;
  if (!doc) return;
  if (tapLookupTimer) clearTimeout(tapLookupTimer);
  tapLookupTimer = setTimeout(() => {
    tapLookupTimer = null;
    if (!readerAlive || selectionDocument !== doc) return;
    const selected = normalizeSelection(doc.getSelection()?.toString() || "");
    const tapped = wordAtPoint(doc, x, y);
    const word = preferSelection ? (selected || tapped) : (tapped || selected);
    if (word) openDictionaryWord(word);
  }, 180);
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
function queueSelectedWord() {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    selectionTimer = null;
    const selected = selectionDocument?.getSelection()?.toString() || "";
    const word = normalizeSelection(selected);
    if (word) openDictionaryWord(word);
  }, 240);
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
  if (!container || !epub.value) return;
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
    await nextTick();
    await loadChapter(Math.min(stored.chapterIndex||0,parsed.chapters.length-1),stored.chapterPercent||0);
  } catch(e) { error.value = explanation(e); }
  finally { loading.value = false; }
}
watch(account,(next) => { if (loadedAccount && next !== loadedAccount) void router.replace("/settings"); });
onMounted(() => {
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
  readerAlive = false;
  lookupRevision++;
  unbindFrameSelection();
  if (selectionTimer) clearTimeout(selectionTimer);
  chapterRequest++;
  if (saveTimer) clearTimeout(saveTimer);
  void saveNow();
  epub.value?.destroy();
});
</script>
<style scoped>
.reader-page{position:fixed;inset:0;display:flex;flex-direction:column;z-index:50;background:#fff;color:#242830;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
.reader-page.theme-sepia{background:#f5edda;color:#433c31}
.reader-page.theme-dark{background:#20252b;color:#e5e7eb}
.reader-header{display:flex;align-items:center;justify-content:space-between;min-height:52px;border-bottom:1px solid #8884;gap:8px}
.reader-header>button{width:50px;min-height:44px;border:0;background:transparent;color:inherit;font-size:26px;cursor:pointer}
.reader-header>div{display:grid;min-width:0;gap:3px;text-align:center}
.reader-header strong{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px}
.reader-header small{color:inherit;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.reader-lookup-hint{margin:0;padding:5px 14px;text-align:center;font-size:11px;line-height:1.5;opacity:.65}
.chapter-scroller{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.chapter-frame{display:block;width:100%;height:1px;border:0;background:transparent}
.reader-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:54px;padding:4px 14px;border-top:1px solid #8884}
.reader-footer button{border:0;color:inherit;background:transparent;min-height:40px;padding:0 12px;font-size:14px}
.reader-footer button:disabled{opacity:.3}
.reader-footer span{font-size:12px;opacity:.7}
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