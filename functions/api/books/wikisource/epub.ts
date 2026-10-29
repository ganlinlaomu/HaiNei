/** Narrow, size-limited WS Export EPUB gateway: user supplies a page title, never a URL. */
const MAX_BYTES=25*1024*1024;
const EXPORT_HOSTS=new Set(["ws-export-app.wmcloud.org","ws-export.wmcloud.org"]);
export async function onRequestGet(context:{request:Request}):Promise<Response>{
  const input=new URL(context.request.url);
  const title=(input.searchParams.get("page")||"").trim();
  if(!title||title.length>180||/[\x00-\x1f\x7f]/.test(title)||title.includes(":"))return new Response("Invalid page title",{status:400});
  let target=new URL("https://ws-export-app.wmcloud.org/?"+new URLSearchParams({format:"epub-3",lang:"zh",page:title,credits:"false",images:"false"}));
  try{
    for(let i=0;i<5;i++){
      const res=await fetch(target.href,{redirect:"manual",headers:{Accept:"application/epub+zip,application/octet-stream;q=0.9"},signal:AbortSignal.timeout(45000)});
      if([301,302,303,307,308].includes(res.status)){
        const location=res.headers.get("Location");
        if(!location)return new Response("No export redirect",{status:502});
        const next=new URL(location,target);
        if(next.protocol!=="https:"||!EXPORT_HOSTS.has(next.hostname)||next.username||next.password)return new Response("Unexpected export redirect",{status:502});
        target=next;continue;
      }
      if(!res.ok)return new Response("Wikisource export failed ("+res.status+")",{status:502});
      const expected=Number(res.headers.get("Content-Length")||0);
      if(expected>MAX_BYTES)return new Response("EPUB exceeds 25 MB",{status:413});
      const reader=res.body?.getReader();
      if(!reader)return new Response("Empty export",{status:502});
      const chunks:Uint8Array[]=[];let total=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BYTES){await reader.cancel();return new Response("EPUB exceeds 25 MB",{status:413});}chunks.push(value);}}
      catch{await reader.cancel().catch(()=>{});return new Response("Wikisource export interrupted",{status:502});}
      if(total<100)return new Response("Empty EPUB",{status:502});
      const data=new Uint8Array(total);let pos=0;for(const chunk of chunks){data.set(chunk,pos);pos+=chunk.length;}
      if(data[0]!==0x50||data[1]!==0x4b)return new Response("Wikisource did not return an EPUB. Try another completed work.",{status:502});
      return new Response(data,{headers:{"Content-Type":"application/epub+zip","Content-Length":String(total),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
    }
    return new Response("Too many export redirects",{status:502});
  }catch{return new Response("Wikisource export unavailable",{status:502});}
}