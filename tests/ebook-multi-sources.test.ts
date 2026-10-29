import { afterEach,describe,expect,it,vi } from "vitest";
import { onRequestGet as wikiSearch } from "../functions/api/books/wikisource/search";
import { onRequestGet as wikiExport } from "../functions/api/books/wikisource/epub";
import { onRequestGet as aozoraText } from "../functions/api/books/aozora/text";
import { parseAozoraCsv } from "../functions/api/books/aozora/search";
import { searchOtherLibrary,sourceForBook } from "@/services/ebookSources";
import { zipEpub } from "@/services/ebookAozora";
import { clearAozoraCatalogMemoryCache } from "@/services/ebookAozoraCatalog";
import { rowsFromAozoraCsv } from "../scripts/generate-aozora-catalog.mjs";
afterEach(()=>{vi.unstubAllGlobals();clearAozoraCatalogMemoryCache();});
const request=(url:string)=>({request:new Request(url)});
describe("Chinese Wikisource + Japanese Aozora source adapters",()=>{
  it("only searches Chinese Wikisource article namespace, preserving exact page titles",async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({
      query:{search:[{pageid:120,ns:0,title:"論語"},{pageid:12,ns:1,title:"讨论:論語"},{pageid:3,ns:0,title:"論語/學而第一"}]},
      continue:{sroffset:20}
    })));
    vi.stubGlobal("fetch",fetcher);
    const data=await (await wikiSearch(request("https://pwa.lostr.space/api/books/wikisource/search?q="+encodeURIComponent("論語")+"&page=1"))).json() as any;
    expect(data.books.map((b:any)=>b.id)).toEqual(["wikisource:120","wikisource:3"]);
    expect(data.books[0].sourceUrl).toContain("zh.wikisource.org");
    expect(data.books[0].epubUrl).toContain("ws-export-app.wmcloud.org");
    expect(data.hasNext).toBe(true);
    expect(String(fetcher.mock.calls[0][0])).toContain("srnamespace=0");
  });
  it("rejects arbitrary WS export pages and disallows off-site redirects",async()=>{
    const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{Location:"https://evil.example/steal.epub"}}));
    vi.stubGlobal("fetch",fetcher);
    const bad=await wikiExport(request("https://pwa.lostr.space/api/books/wikisource/epub?page="+encodeURIComponent("Template:Main")));
    expect(bad.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const redirect=await wikiExport(request("https://pwa.lostr.space/api/books/wikisource/epub?page="+encodeURIComponent("論語")));
    expect(redirect.status).toBe(502);
  });
  it("does not accept untrusted Aozora source hosts or paths",async()=>{
    const fetcher=vi.fn();
    vi.stubGlobal("fetch",fetcher);
    const bad=await aozoraText(request("https://pwa.lostr.space/api/books/aozora/text?url="+encodeURIComponent("https://evil.test/cards/000148/files/773_14560.html")));
    expect(bad.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const valid=await aozoraText(request("https://pwa.lostr.space/api/books/aozora/text?url="+encodeURIComponent("https://www.aozora.gr.jp/cards/000148/files/773_14560.html")));
    expect(valid.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("falls back to Soranoha Markdown when the official Aozora fetch fails",async()=>{
    const fetcher=vi.fn(async(url:string)=>{
      if(url.startsWith("https://www.aozora.gr.jp/"))return new Response("unavailable",{status:503});
      if(url==="https://soranoha.org/works/000773_000148/markdown")
        return new Response("# こころ\n\n" + "先生と私。".repeat(20));
      return new Response("not found",{status:404});
    });
    vi.stubGlobal("fetch",fetcher);
    const response=await aozoraText(request("https://pwa.lostr.space/api/books/aozora/text?url="+encodeURIComponent("https://www.aozora.gr.jp/cards/000148/files/773_14560.html")));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(response.headers.get("X-Aozora-Source")).toBe("soranoha");
    expect((await response.text())).toContain("先生と私");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("uses only a matching Aozorahack path when the primary and Soranoha are offline",async()=>{
    const mirror="https://raw.githubusercontent.com/aozorahack/aozorabunko_text/master/cards/000148/files/773_ruby_5968/773_ruby_5968.txt";
    const official="https://www.aozora.gr.jp/cards/000148/files/773_14560.html";
    const fetcher=vi.fn(async(url:string)=>url===mirror
      ? new Response("Aozora story text. ".repeat(10))
      : new Response("not found",{status:404}));
    vi.stubGlobal("fetch",fetcher);
    const url="https://pwa.lostr.space/api/books/aozora/text?url="+encodeURIComponent(official)+"&text="+encodeURIComponent(mirror);
    const result=await aozoraText(request(url));
    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toContain("text/plain");
    expect(result.headers.get("X-Aozora-Source")).toBe("aozorahack");
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockClear();
    const invalid=await aozoraText(request(url.replace(encodeURIComponent(mirror),encodeURIComponent("https://raw.githubusercontent.com/aozorahack/aozorabunko_text/master/cards/999999/files/773_ruby_5968/773_ruby_5968.txt"))));
    expect(invalid.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("filters copyrighted works and role duplicates from official Aozora metadata",()=>{
    const names=["作品ID","作品名","作品著作権フラグ","人物著作権フラグ","役割フラグ","姓名","XHTML/HTMLファイルURL","図書カードURL"];
    const row=(id:number,rights:string,role:string)=>[id===773?"000773":String(id),"こころ",rights,"なし",role,"夏目漱石",
      "https://www.aozora.gr.jp/cards/000148/files/773_14560.html","https://www.aozora.gr.jp/cards/000148/card773.html"].join(",");
    const result=parseAozoraCsv("\uFEFF"+names.join(",")+"\r\n"+[row(773,"なし","著者"),row(773,"なし","著者"),
      row(13,"あり","著者"),row(14,"なし","翻訳者")].join("\r\n"));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({id:773,title:"こころ",author:"夏目漱石"});
  });

  it("identifies Wiki search as HaiNei, as required by Wikimedia API policy",async()=>{
    const fetcher=vi.fn(async (_url:string,_options?:RequestInit)=>new Response(JSON.stringify({query:{search:[]}})));
    vi.stubGlobal("fetch",fetcher);
    const response=await wikiSearch(request("https://pwa.lostr.space/api/books/wikisource/search?q="+encodeURIComponent("唐詩")+"&page=1"));
    expect(response.status).toBe(200);
    const options=fetcher.mock.calls[0][1] as RequestInit;
    expect((options.headers as Record<string,string>)["User-Agent"]).toContain("HaiNei-BookReader");
    expect((options.headers as Record<string,string>)["Api-User-Agent"]).toContain("github.com/ganlinlaomu/HaiNei");
  });
  it("falls back to Wikimedia CORS when the Cloudflare search returns a 502",async()=>{
    const fetcher=vi.fn(async (url:string) => url.startsWith("/api/")
      ? new Response(JSON.stringify({error:"Unavailable"}),{status:502})
      : new Response(JSON.stringify({query:{search:[{ns:0,pageid:39,title:"論語"}]}})));
    vi.stubGlobal("fetch",fetcher);
    const data=await searchOtherLibrary("wikisource","論語",1);
    expect(data.books.map(b=>b.id)).toEqual(["wikisource:39"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain("origin=*");
  });
  it("uses the same official Aozora catalogue filters for the prebuilt index",()=>{
    const names=["作品ID","作品名","作品著作権フラグ","人物著作権フラグ","役割フラグ","姓名","XHTML/HTMLファイルURL","図書カードURL"];
    const raw=[names.join(","),[
      "000773","こころ","なし","なし","著者","夏目漱石",
      "https://www.aozora.gr.jp/cards/000148/files/773_14560.html",
      "https://www.aozora.gr.jp/cards/000148/card773.html"
    ].join(",")].join("\r\n");
    expect(rowsFromAozoraCsv(raw)).toMatchObject([{
      id:"aozora:773",title:"こころ",authors:["夏目漱石"],language:"ja"
    }]);
  });
  it("generates a valid ZIP with an uncompressed first mimetype entry",async()=>{
    const epub=zipEpub([["mimetype","application/epub+zip"],["META-INF/container.xml","<container/>"],["OEBPS/chapter1.xhtml","<html/>"]]);
    const bytes=new Uint8Array(await epub.arrayBuffer());
    expect(Array.from(bytes.slice(0,4))).toEqual([0x50,0x4b,0x03,0x04]);
    expect(new TextDecoder().decode(bytes.slice(38,58))).toBe("application/epub+zip");
    expect(bytes.length).toBeGreaterThan(130);
  });
  it("keeps same-origin routing, distinct book IDs and no extra user accounts",async()=>{
    expect(sourceForBook({id:"aozora:773"})).toBe("aozora");
    expect(sourceForBook({id:"wikisource:120"})).toBe("wikisource");
    expect(sourceForBook({id:"gutenberg:1342"})).toBe("gutenberg");
    const books=Array.from({length:1000},(_,i)=>({
      id:"aozora:"+(773+i),title:i===0?"こころ":"別の作品"+i,
      authors:[i===0?"夏目漱石":"無名"],language:"ja",
      sourceUrl:"https://www.aozora.gr.jp/cards/000148/card773.html",
      epubUrl:"https://www.aozora.gr.jp/cards/000148/files/773_14560.html",downloads:0
    }));
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({version:1,books})));
    vi.stubGlobal("fetch",fetcher);
    const results=await searchOtherLibrary("aozora","こころ",1);
    expect(results.books).toHaveLength(1);
    expect(fetcher.mock.calls[0][0]).toContain("/ebook-catalog/aozora-index-v1.json");
  });
});
