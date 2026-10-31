import { validGutenbergEpubUrl, type CatalogBook } from "@/services/ebookCatalog";
import { MAX_EPUB_SIZE, checkBookStorageSpace, saveLibraryBook } from "@/services/ebookLibrary";
import { OfflineEpub } from "@/services/ebookEpub";
import { makeAozoraEpub, makeAozoraFallbackEpub } from "@/services/ebookAozora";

/** Downloads only verified Gutenberg EPUBs. Complete before IndexedDB commit. */
export async function downloadGutenbergBook(
  account: string,
  book: CatalogBook,
  onProgress: (percent: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!validGutenbergEpubUrl(book.epubUrl)) throw new Error("不受支持的书籍下载地址");
  const proxy = "/api/books/epub?url=" + encodeURIComponent(book.epubUrl);
  const response = await fetch(proxy, { signal, cache: "no-store" });
  if (!response.ok) {
    throw new Error(response.status === 413 ? "文件超过 25MB 限制" :
      "暂时无法下载 EPUB（HTTP " + response.status + "）");
  }
  const headerLength = Number(response.headers.get("Content-Length") || 0);
  if (headerLength > MAX_EPUB_SIZE) throw new Error("文件超过 25MB 限制");
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (!response.body) throw new Error("服务器没有返回文件内容");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_EPUB_SIZE) throw new Error("文件超过 25MB 限制");
      chunks.push(value);
      onProgress(headerLength > 0 ? Math.min(100, Math.floor(received / headerLength * 100)) : null);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (headerLength && received !== headerLength) throw new Error("文件下载不完整，请重试");
  if (received < 100) throw new Error("下载的文件为空");
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error("下载内容不是 EPUB 文件");
  const file = new Blob([buffer], { type: "application/epub+zip" });
  const verified = await OfflineEpub.open(file);
  let cover: Blob | null = null;
  try {
    cover = await verified.coverImage();
  } finally {
    verified.destroy();
  }
  await checkBookStorageSpace(received + (cover?.size || 0));
  await saveLibraryBook(account, book, file, cover);
  onProgress(100);
}


/** Same EPUB library & reader for all three sources; source gateways are allowlisted. */
export async function downloadCatalogBook(
  account:string, book:CatalogBook, onProgress:(percent:number|null)=>void, signal?:AbortSignal
):Promise<void>{
  if(book.id.startsWith("gutenberg:"))return downloadGutenbergBook(account,book,onProgress,signal);
  if(book.id.startsWith("aozora:")){
    const target=new URL(book.epubUrl);
    if(target.protocol!=="https:"||target.hostname!=="www.aozora.gr.jp"||
      !/^\/cards\/\d{6}\/files\/\d+_[\w-]+\.html$/.test(target.pathname))throw new Error("不受支持的青空文库作品地址");
    const params=new URLSearchParams({url:target.href});
    if(book.textUrl)params.set("text",book.textUrl);
    const response=await fetch("/api/books/aozora/text?"+params.toString(),{signal,cache:"no-store"});
    if(!response.ok)throw new Error(response.status===503
      ?"青空文库官网及备用书源暂时无法连接，请稍后重试或打开原书页"
      :response.status===413?"青空文库正文超过 5MB 限制"
      :"青空文库正文无法下载（HTTP "+response.status+"）");
    const length=Number(response.headers.get("Content-Length")||0);
    if(length>5*1024*1024)throw new Error("作品正文过大");
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength>5*1024*1024)throw new Error("作品正文过大");
    const html=new TextDecoder("utf-8").decode(bytes);
    const contentType=response.headers.get("Content-Type")||"";
    const format=contentType.startsWith("text/markdown")?"markdown":
      contentType.startsWith("text/plain")?"plain":null;
    const author=book.authors.join("、")||"青空文庫";
    const file=format?makeAozoraFallbackEpub(html,format,book.title,author):
      makeAozoraEpub(html,book.title,author);
    onProgress(80);
    const checked=await OfflineEpub.open(file);
    checked.destroy();
    await checkBookStorageSpace(file.size);
    if(signal?.aborted)throw new DOMException("下载已取消","AbortError");
    await saveLibraryBook(account,book,file);
    onProgress(100);
    return;
  }
  if(book.id.startsWith("wikisource:")){
    if(!/^wikisource:\d+$/.test(book.id)||!book.title||book.title.length>180)throw new Error("不受支持的维基文库作品");
    const response=await fetch("/api/books/wikisource/epub?page="+encodeURIComponent(book.title),{signal,cache:"no-store"});
    if(response.status===409){
      const body=await response.json().catch(()=>null) as {editions?:unknown}|null;
      const editions=Array.isArray(body?.editions)?body!.editions.filter((x):x is string=>typeof x==="string").slice(0,4):[];
      throw new Error("「"+book.title+"」是版本页，没有正文。请重新搜索并选择具体版本"+(editions.length?"，例如："+editions.join("、"):""));
    }
    if(response.status===404)throw new Error("维基文库找不到这部作品");
    if(!response.ok)throw new Error(response.status===413?"EPUB 超过 25MB":"维基文库无法导出 EPUB（HTTP "+response.status+"），可尝试其他已完成的作品");
    const announced=Number(response.headers.get("Content-Length")||0);
    if(announced>MAX_EPUB_SIZE)throw new Error("EPUB 超过 25MB");
    const buffer=await response.arrayBuffer();
    if(buffer.byteLength>MAX_EPUB_SIZE||buffer.byteLength<100)throw new Error("下载的 EPUB 大小异常");
    const bytes=new Uint8Array(buffer);
    if(bytes[0]!==0x50||bytes[1]!==0x4b)throw new Error("维基文库没有返回有效的 EPUB");
    const file=new Blob([buffer],{type:"application/epub+zip"});
    const checked=await OfflineEpub.open(file);
    let cover:Blob|null=null;
    try{cover=await checked.coverImage();}finally{checked.destroy();}
    await checkBookStorageSpace(file.size+(cover?.size||0));
    if(signal?.aborted)throw new DOMException("下载已取消","AbortError");
    await saveLibraryBook(account,book,file,cover);
    onProgress(100);
    return;
  }
  throw new Error("未知书库");
}
