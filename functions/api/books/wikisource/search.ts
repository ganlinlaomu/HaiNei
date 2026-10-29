/** Search Chinese Wikisource for downloadable works using the public MediaWiki API. */
import { searchWikisourceWorks } from "../../../../src/services/wikisourceWorks";
type Context={request:Request;waitUntil?:(p:Promise<unknown>)=>void};
function json(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":status===200?"public, max-age=60, s-maxage=1800":"no-store","X-Content-Type-Options":"nosniff"}});}
const AGENT="HaiNei-BookReader/1.0 (https://github.com/ganlinlaomu/HaiNei)";
class UpstreamError extends Error{constructor(readonly status:number){super("Wikisource upstream HTTP "+status);}}
async function wikiApi(params:Record<string,string>){
  const response=await fetch("https://zh.wikisource.org/w/api.php?"+new URLSearchParams(params),{
    headers:{Accept:"application/json","User-Agent":AGENT,"Api-User-Agent":AGENT},
    signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw new UpstreamError(response.status);
  return response.json();
}
export async function onRequestGet(context:Context):Promise<Response>{
  const input=new URL(context.request.url);
  const q=(input.searchParams.get("q")||"").trim().replace(/\s+/g," ");
  const p=input.searchParams.get("page")||"1";
  if(!q||q.length>100||!/^[1-9]\d?$/.test(p)||Number(p)>30)return json({error:"Invalid Wikisource search"},400);
  const cache=(globalThis as unknown as {caches?:{default?:Cache}}).caches?.default;
  // v2: results now resolve redirects, subpages and 版本页 into works.
  const key=new Request(input.origin+input.pathname+"?"+new URLSearchParams({q,page:p,v:"2"}));
  if(cache){try{const hit=await cache.match(key);if(hit)return hit;}catch{}}
  try{
    const output=json(await searchWikisourceWorks(q,Number(p),wikiApi));
    if(cache){const saved=cache.put(key,output.clone()).catch(()=>{});if(context.waitUntil)context.waitUntil(saved);}
    return output;
  }catch(error){
    if(error instanceof UpstreamError)return json({error:error.message},error.status===429?429:503);
    if(error instanceof Error&&error.message.includes("格式异常"))return json({error:"Invalid Wikisource data"},502);
    return json({error:"Wikisource search timed out or unavailable"},503);
  }
}
