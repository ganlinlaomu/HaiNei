/** Search Aozora Bunko's public, official UTF-8 catalogue without account/API keys.
 * Metadata © Aozora Bunko contributors (CC BY 4.0); work rights are distinct.
 */
type CatalogRow={id:number;title:string;author:string;url:string;card:string};
const CATALOG_URL="https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";
const MAX_ZIP=12*1024*1024, MAX_CSV=32*1024*1024;
type Context={request:Request;waitUntil?:(promise:Promise<unknown>)=>void};
function output(body:unknown,status=200):Response{return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":status===200?"public, max-age=60, s-maxage=3600":"no-store","X-Content-Type-Options":"nosniff"}});}
function unzipCsv(buffer:ArrayBuffer):Promise<string>{
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);
  let eocd=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(view.getUint32(i,true)===0x06054b50){eocd=i;break;}}
  if(eocd<0)throw new Error("Aozora catalogue ZIP is invalid");
  const count=view.getUint16(eocd+10,true);let off=view.getUint32(eocd+16,true);
  if(!count||count>20)throw new Error("Invalid catalogue entries");
  for(let i=0;i<count;i++){
    if(off+46>bytes.length||view.getUint32(off,true)!==0x02014b50)throw new Error("Corrupt catalogue directory");
    const method=view.getUint16(off+10,true),size=view.getUint32(off+20,true),unpacked=view.getUint32(off+24,true);
    const len=view.getUint16(off+28,true),extra=view.getUint16(off+30,true),comment=view.getUint16(off+32,true);
    const local=view.getUint32(off+42,true);
    const filename=new TextDecoder().decode(bytes.subarray(off+46,off+46+len));
    off+=46+len+extra+comment;
    if(!filename.toLowerCase().endsWith(".csv"))continue;
    if(unpacked>MAX_CSV||size>MAX_ZIP||local+30>bytes.length||view.getUint32(local,true)!==0x04034b50)throw new Error("Catalogue too large");
    const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    if(start+size>bytes.length)throw new Error("Incomplete catalogue");
    const compressed=bytes.slice(start,start+size);
    if(method===0)return Promise.resolve(new TextDecoder().decode(compressed));
    if(method!==8)throw new Error("Unsupported ZIP compression");
    return new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer().then(buf=>{
      if(buf.byteLength!==unpacked||buf.byteLength>MAX_CSV)throw new Error("Invalid catalogue length");
      return new TextDecoder().decode(buf);
    });
  }
  throw new Error("Catalogue CSV not found");
}
function parseCsv(text:string,onRow:(row:string[])=>void):void{
  let cells:string[]=[],field="",quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(c===","&&!quoted){cells.push(field);field="";}
    else if((c==="\r"||c==="\n")&&!quoted){
      if(c==="\r"&&text[i+1]==="\n")i++;
      cells.push(field);field="";onRow(cells);cells=[];
    }else field+=c;
  }
  if(quoted)throw new Error("Malformed catalogue CSV");
  if(cells.length||field){cells.push(field);onRow(cells);}
}
export function parseAozoraCsv(csv:string):CatalogRow[]{
  const works=new Map<number,CatalogRow>();let columns:Record<string,number>|null=null;
  parseCsv(csv.replace(/^\uFEFF/,""),r=>{
    if(!columns){columns=Object.fromEntries(r.map((s,i)=>[s,i]));return;}
    const col=columns;
    const get=(name:string)=>r[col[name]??-1]||"";
    const id=Number(get("作品ID"));
    if(!Number.isSafeInteger(id)||id<=0||id>999999||get("作品著作権フラグ")!=="なし"||
      get("人物著作権フラグ")!=="なし"||get("役割フラグ")!=="著者")return;
    const rawUrl=get("XHTML/HTMLファイルURL");
    let parsed:URL;
    try{parsed=new URL(rawUrl.replace(/^http:/,"https:"));}catch{return;}
    if(parsed.protocol!=="https:"||parsed.hostname!=="www.aozora.gr.jp"||parsed.search||parsed.hash||
      !/^\/cards\/\d{6}\/files\/\d+_[\w-]+\.html$/.test(parsed.pathname))return;
    let card:string;
    try {
      const raw=new URL(get("図書カードURL").replace(/^http:/,"https:"));
      if(raw.hostname!=="www.aozora.gr.jp"||raw.protocol!=="https:"||
        !/^\/cards\/\d{6}\/card\d+\.html$/.test(raw.pathname))return;
      card=raw.origin+raw.pathname;
    } catch { return; }
    const title=get("作品名").trim(),author=get("姓名").trim()||[get("姓"),get("名")].filter(Boolean).join(" ");
    if(!title||!author||works.has(id))return;
    works.set(id,{id,title:title.slice(0,180),author:author.slice(0,100),url:parsed.href,card});
  });
  return [...works.values()];
}
async function catalogue(context:Context):Promise<CatalogRow[]>{
  const api=new URL(context.request.url);
  const cache=(globalThis as unknown as {caches?:{default?:Cache}}).caches?.default;
  const key=new Request(api.origin+"/api/books/aozora/catalogue-cache-v1");
  if(cache){try{const hit=await cache.match(key);if(hit){const rows=await hit.json() as CatalogRow[];if(Array.isArray(rows))return rows;}}catch{}}
  const response=await fetch(CATALOG_URL,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)return Promise.reject(new Error("Aozora catalogue unavailable"));
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength>MAX_ZIP)throw new Error("Aozora catalogue ZIP too large");
  const csv=await unzipCsv(bytes);
  const rows=parseAozoraCsv(csv);
  if(!rows.length)throw new Error("No public-domain Aozora XHTML works found");
  if(cache){
    const payload=new Response(JSON.stringify(rows),{headers:{"Content-Type":"application/json","Cache-Control":"public, s-maxage=86400"}});
    const stored=cache.put(key,payload).catch(()=>{});
    if(context.waitUntil)context.waitUntil(stored);
  }
  return rows;
}
export async function onRequestGet(context:Context):Promise<Response>{
  const input=new URL(context.request.url),q=(input.searchParams.get("q")||"").trim().toLowerCase();
  const page=input.searchParams.get("page")||"1";
  if(!q||q.length>100||!/^[1-9]\d?$/.test(page)||Number(page)>100)return output({error:"Invalid Aozora search"},400);
  try{
    const rows=(await catalogue(context)).filter(x=>(x.title+" "+x.author).toLowerCase().includes(q));
    const start=(Number(page)-1)*20;
    return output({books:rows.slice(start,start+20).map(x=>({
      id:"aozora:"+x.id,title:x.title,authors:[x.author],language:"ja",epubUrl:x.url,sourceUrl:x.card,downloads:0
    })),hasNext:start+20<rows.length});
  }catch{return output({error:"Aozora catalogue unavailable"},502);}
}