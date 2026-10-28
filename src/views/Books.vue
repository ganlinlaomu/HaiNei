<template>
  <main class="books-page app-page">
    <SecondaryPageHeader title="电子书" back-to="/settings" />
    <nav class="tabs" aria-label="电子书视图">
      <button type="button" :class="{ active: tab === 'discover' }" @click="tab = 'discover'">发现书籍</button>
      <button type="button" :class="{ active: tab === 'library' }" @click="openLibrary">我的书架（{{ library.length }}）</button>
    </nav>
    <section v-if="tab === 'discover'" class="content">
      <form class="search" @submit.prevent="startSearch">
        <label for="ebook-query">搜索公版经典文学</label>
        <div class="search-row"><input id="ebook-query" v-model="query" type="search" placeholder="书名、作者（建议英文原名）" autocomplete="off" /><button type="submit" :disabled="searching || !online">搜索</button></div>
        <div class="filters"><label for="ebook-language">语言</label><select id="ebook-language" v-model="language" @change="startSearch"><option value="">全部</option><option value="en">英文</option><option value="zh">中文</option><option value="ja">日文</option><option value="fr">法文</option></select><span>Project Gutenberg</span></div>
      </form>
      <p v-if="!online" class="note offline-message" role="status">当前已离线，无法搜索或下载新书。<button type="button" @click="openLibrary">前往我的书架</button>，已下载的 EPUB 仍可正常阅读。联网后可继续搜索。</p>
      <p class="note">无需注册书源账号。仅展示 Gutenberg 标记为无版权限制并提供 EPUB 的作品；具体使用仍以所在地法律与原书页面说明为准。</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="searching" class="hint" role="status">正在查询书库…</p>
      <template v-else>
        <div v-for="book in results" :key="book.id" class="book-row">
          <img v-if="book.coverUrl" :src="book.coverUrl" alt="" loading="lazy" class="cover"/>
          <div v-else class="cover placeholder" aria-hidden="true">📖</div>
          <div class="info"><strong>{{ book.title }}</strong><small>{{ book.authors.join("、") || "作者未知" }}</small><small>{{ languageLabel(book.language) }} · EPUB</small>
            <div class="actions"><button v-if="downloaded.has(book.id)" type="button" class="primary" @click="openBook(book.id)">阅读</button>
              <button v-else type="button" class="primary" :disabled="!!downloadingId" @click="download(book)">{{ downloadingId === book.id ? '下载中 ' + (progress === null ? '…' : progress + '%') : '下载到书架' }}</button>
              <a :href="book.sourceUrl" target="_blank" rel="noopener noreferrer">原书页</a>
            </div>
          </div>
        </div>
        <p v-if="!results.length && !error" class="hint">没有找到符合条件的 EPUB。可以试试作者原文名。</p>
        <button v-if="hasNext" type="button" class="more" :disabled="!online" @click="nextPage">加载更多</button>
      </template>
    </section>
    <section v-else class="content">
      <div class="library-title"><strong>已下载的书籍</strong><small>{{ library.length }} 本 · 离线保存在此设备</small></div>
      <p class="note">断网也可阅读。iOS 可能清除 PWA 网站数据，建议将重要 EPUB 导出到「文件」App 备份。</p>
      <p v-if="libraryError" class="error" role="alert">{{ libraryError }}</p>
      <div v-for="book in library" :key="book.id" class="book-row">
        <img v-if="book.coverUrl" :src="book.coverUrl" alt="" loading="lazy" class="cover"/>
        <div v-else class="cover placeholder" aria-hidden="true">📖</div>
        <div class="info"><strong>{{ book.title }}</strong><small>{{ book.authors.join("、") || "作者未知" }}</small><small>{{ formatBytes(book.bytes) }} · 已保存</small>
          <div class="actions"><button type="button" class="primary" @click="openBook(book.id)">继续阅读</button><button type="button" @click="exportLibraryBook(book)">导出</button><button type="button" class="danger" @click="remove(book.id)">删除</button></div>
        </div>
      </div>
      <p v-if="!library.length" class="hint">书架为空。前往「发现书籍」下载第一本 EPUB。</p>
    </section>
  </main>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import { useKeyStore } from "@/stores/keys";
import { searchGutenberg, type CatalogBook } from "@/services/ebookCatalog";
import { downloadGutenbergBook } from "@/services/ebookDownload";
import { deleteLibraryBook, exportLibraryBook, listLibraryBooks, type LibraryBook } from "@/services/ebookLibrary";

const router = useRouter(), keys = useKeyStore();
const account = computed(() => keys.pkHex);
const tab = ref<"discover"|"library">("discover"), query = ref(""), language = ref("");
const searching = ref(false), results = ref<CatalogBook[]>([]), library = ref<LibraryBook[]>([]);
const online = ref(typeof navigator === "undefined" ? true : navigator.onLine !== false);
const hasNext = ref(false), page = ref(1), error = ref(""), libraryError = ref("");
const downloadingId = ref(""), progress = ref<number|null>(null);
let searchController: AbortController|null = null, downloadController: AbortController|null = null;
const downloaded = computed(() => new Set(library.value.map(b => b.id)));
function languageLabel(code: string) { return ({en:"英文",ja:"日文",zh:"中文",fr:"法文"} as Record<string,string>)[code] || code || "其他语言"; }
function formatBytes(bytes:number) { return bytes >= 1048576 ? (bytes/1048576).toFixed(1)+" MB" : Math.ceil(bytes/1024)+" KB"; }
function message(e:unknown) { return e instanceof Error ? e.message : "操作失败"; }
async function refreshLibrary() { if (!account.value) return; try { library.value = await listLibraryBooks(account.value); libraryError.value = ""; } catch(e) { libraryError.value = message(e); } }
function openLibrary() { tab.value = "library"; void refreshLibrary(); }
function openBook(id:string) { void router.push({ name:"EbookReader",params:{id} }); }
async function search(append:boolean) {
  if (!online.value) { searching.value = false; error.value = ""; return; }
  searchController?.abort();
  const controller = new AbortController(); searchController = controller; searching.value = true; error.value = "";
  try {
    const data = await searchGutenberg(query.value, page.value, language.value, controller.signal);
    if (!controller.signal.aborted) { results.value = append ? [...results.value,...data.books] : data.books; hasNext.value = data.hasNext; }
  } catch(e) { if (!controller.signal.aborted) error.value = message(e); }
  finally { if (searchController === controller) { searching.value = false; searchController = null; } }
}
function startSearch() { page.value = 1; void search(false); }
function nextPage() { if (!online.value || searching.value) return; page.value++; void search(true); }
async function download(book:CatalogBook) {
  if (downloadingId.value || !account.value) return;
  downloadingId.value = book.id; progress.value = null; error.value = "";
  const controller = new AbortController(); downloadController = controller;
  try {
    await downloadGutenbergBook(account.value, book, value => { progress.value = value; }, controller.signal);
    await refreshLibrary(); tab.value = "library";
  } catch(e) { if (!controller.signal.aborted) error.value = message(e); }
  finally { downloadingId.value = ""; downloadController = null; }
}
async function remove(id:string) {
  if (!account.value || !window.confirm("确定从本设备删除这本电子书吗？")) return;
  try { await deleteLibraryBook(account.value,id); await refreshLibrary(); } catch(e) { libraryError.value = message(e); }
}
function handleOnline() {
  online.value = true;
  if (tab.value === "discover" && (error.value || !results.value.length)) startSearch();
}
function handleOffline() {
  online.value = false;
  searchController?.abort();
  searchController = null;
  searching.value = false;
  error.value = "";
}
onMounted(() => {
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  void refreshLibrary();
  if (online.value) startSearch();
});
onUnmounted(() => {
  window.removeEventListener("online", handleOnline);
  window.removeEventListener("offline", handleOffline);
  searchController?.abort();
  downloadController?.abort();
});
</script>
<style scoped>
.books-page{min-height:100vh;padding-bottom:calc(var(--bottom-nav-height,75px) + env(safe-area-inset-bottom) + 24px);background:var(--bg-fff);color:var(--fg-172033)}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 16px 0}
.tabs button{min-height:42px;border:0;border-radius:10px;background:var(--bg-eef2f6);color:var(--fg-64748b)}
.tabs .active{background:var(--fg-172033);color:#fff;font-weight:600}
.content{padding:16px}
.search{display:grid;gap:10px}
.search>label{font-size:16px;font-weight:650}
.search-row{display:flex;gap:8px}
.search-row input{min-width:0;flex:1;min-height:44px;border:1px solid var(--bd-e2e8f0);border-radius:10px;padding:0 12px;background:var(--bg-fff);color:inherit;font-size:15px}
.search-row button,.primary{background:#2563eb!important;color:#fff!important;border-color:#2563eb!important}
.search-row button{min-width:70px;border:0;border-radius:10px}
button:disabled{opacity:.55}
.filters{display:flex;align-items:center;gap:8px;color:var(--fg-64748b);font-size:12px}
.filters select{border:1px solid var(--bd-e2e8f0);padding:7px;border-radius:8px;background:var(--bg-fff);color:inherit}.filters span{margin-left:auto}
.note{font-size:12px;line-height:1.6;color:var(--fg-64748b);margin:14px 0}
.offline-message button{margin:0 4px;padding:2px 0;border:0;border-bottom:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.error{color:#b91c1c;background:#fef2f2;border-radius:10px;padding:12px;font-size:13px}
.hint{padding:24px 8px;color:var(--fg-64748b);text-align:center;font-size:14px;line-height:1.7}
.book-row{display:flex;gap:14px;padding:15px 0;border-bottom:1px solid var(--bd-eff1f3)}
.cover{width:82px;height:112px;flex-shrink:0;object-fit:cover;border-radius:6px;background:#ece9df}
.placeholder{display:grid;place-items:center;font-size:28px}
.info{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px}.info strong{font-size:14px;line-height:1.45;overflow-wrap:anywhere}.info small{font-size:12px;color:var(--fg-64748b)}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:8px}
.actions button,.actions a,.more{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:6px 10px;border:1px solid var(--bd-e2e8f0);border-radius:8px;background:var(--bg-fff);color:var(--fg-334155);font-size:12px;text-decoration:none;cursor:pointer}.actions .danger{color:#b91c1c}
.more{width:100%;min-height:42px;margin-top:14px}
.library-title{display:flex;justify-content:space-between;align-items:center;font-size:14px}.library-title small{font-size:12px;color:var(--fg-64748b)}
</style>