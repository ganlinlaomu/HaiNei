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
      </section>
      <div ref="scroller" class="chapter-scroller" @scroll.passive="onScroll"><iframe ref="frame" class="chapter-frame" title="电子书正文" sandbox="allow-same-origin" :srcdoc="chapterHtml" @load="frameLoaded" /></div>
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
import { getLibraryBook, updateReadingState, type LibraryBook } from "@/services/ebookLibrary";
import { OfflineEpub } from "@/services/ebookEpub";

const keys = useKeyStore(), route = useRoute(), router = useRouter();
const book = ref<LibraryBook|null>(null), epub = ref<OfflineEpub|null>(null);
const chapterIndex = ref(0), chapterPercent = ref(0), chapterHtml = ref("");
const fontSize = ref(18), theme = ref<"light"|"sepia"|"dark">("light");
const loading = ref(true), error = ref(""), settingsOpen = ref(false);
const frame = ref<HTMLIFrameElement|null>(null);
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
    fontSize.value = stored.fontSize || 18;
    theme.value = stored.theme || "light";
    await nextTick();
    await loadChapter(Math.min(stored.chapterIndex||0,parsed.chapters.length-1),stored.chapterPercent||0);
  } catch(e) { error.value = explanation(e); }
  finally { loading.value = false; }
}
watch(account,(next) => { if (loadedAccount && next !== loadedAccount) void router.replace("/settings"); });
onMounted(() => { void init(); });
onUnmounted(() => {
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
.settings select{max-width:180px}
</style>