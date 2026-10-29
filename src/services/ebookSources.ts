import type { CatalogBook, CatalogPage } from "@/services/ebookCatalog";
export type BookSource="gutenberg"|"wikisource"|"aozora";
export const BOOK_SOURCE_LABELS:Record<BookSource,string>={gutenberg:"Project Gutenberg",wikisource:"中文维基文库",aozora:"青空文庫"};
export function sourceForBook(book:Pick<CatalogBook,"id">):BookSource{
  if(book.id.startsWith("wikisource:"))return "wikisource";
  if(book.id.startsWith("aozora:"))return "aozora";
  return "gutenberg";
}
export async function searchOtherLibrary(source:"wikisource"|"aozora",query:string,page:number,signal?:AbortSignal):Promise<CatalogPage>{
  const trimmed=query.trim();
  if(!trimmed)return {books:[],hasNext:false};
  const url="/api/books/"+source+"/search?"+new URLSearchParams({q:trimmed,page:String(page)});
  let response:Response;
  try{response=await fetch(url,{signal,cache:"no-store"});}
  catch(e){if(signal?.aborted)throw e;throw new Error("无法连接"+BOOK_SOURCE_LABELS[source]+"，请稍后重试。");}
  if(!response.ok)throw new Error(BOOK_SOURCE_LABELS[source]+"暂时无法搜索（HTTP "+response.status+"）");
  const data=await response.json() as CatalogPage;
  if(!Array.isArray(data.books)||typeof data.hasNext!=="boolean")throw new Error("书库数据格式异常");
  return {books:data.books.filter(book=>typeof book.id==="string"&&book.id.startsWith(source+":")&&
    typeof book.title==="string"&&Array.isArray(book.authors)&&typeof book.sourceUrl==="string"&&typeof book.epubUrl==="string"),hasNext:data.hasNext};
}
