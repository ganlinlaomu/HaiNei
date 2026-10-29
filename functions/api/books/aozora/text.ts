/** Restrict downloads to an official Aozora XHTML page; decode Shift-JIS. */
const LIMIT=5*1024*1024;
export async function onRequestGet(context:{request:Request}):Promise<Response>{
  const params=new URL(context.request.url).searchParams;
  const url=params.get("url")||"";
  let target:URL;
  try{
    if(url.length>400)throw Error();
    target=new URL(url);
    if(target.protocol!=="https:"||target.hostname!=="www.aozora.gr.jp"||target.port||
       target.username||target.password||target.search||target.hash||
       !/^\/cards\/\d{6}\/files\/\d+_[\w-]+\.html$/.test(target.pathname))throw Error();
  }catch{return new Response("Invalid Aozora book URL",{status:400});}
  try{
    const r=await fetch(target.href,{redirect:"manual",signal:AbortSignal.timeout(20000)});
    if(!r.ok)return new Response("Aozora page unavailable",{status:502});
    const announced=Number(r.headers.get("Content-Length")||0);
    if(announced>LIMIT)return new Response("Aozora text exceeds limit",{status:413});
    const bytes=await r.arrayBuffer();
    if(bytes.byteLength>LIMIT)return new Response("Aozora text exceeds limit",{status:413});
    const html=new TextDecoder("shift_jis").decode(bytes);
    if(!html.includes("<")||!html.includes(">"))return new Response("Invalid XHTML page",{status:502});
    return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  }catch{return new Response("Aozora page timed out",{status:502});}
}