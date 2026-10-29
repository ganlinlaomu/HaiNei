/** Search Chinese Wikisource in the main namespace using public MediaWiki API. */
type Context={request:Request;waitUntil?:(p:Promise<unknown>)=>void};
function json(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":status===200?"public, max-age=60, s-maxage=1800":"no-store","X-Content-Type-Options":"nosniff"}});}
type WikiHit={pageid?:number;ns?:number;title?:string};
export async function onRequestGet(context:Context):Promise<Response>{
  const input=new URL(context.request.url);
  const q=(input.searchParams.get("q")||"").trim().replace(/\s+/g," ");
  const p=input.searchParams.get("page")||"1";
  if(!q||q.length>100||!/^[1-9]\d?$/.test(p)||Number(p)>30)return json({error:"Invalid Wikisource search"},400);
  const params=new URLSearchParams({action:"query",list:"search",srsearch:q,srnamespace:"0",srlimit:"20",sroffset:String((Number(p)-1)*20),srprop:"",format:"json",formatversion:"2"});
  const cache=(globalThis as unknown as {caches?:{default?:Cache}}).caches?.default;
  const key=new Request(input.origin+input.pathname+"?"+new URLSearchParams({q,page:p}));
  if(cache){try{const hit=await cache.match(key);if(hit)return hit;}catch{}}
  try{
    const response=await fetch("https://zh.wikisource.org/w/api.php?"+params,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(12000)});
    if(!response.ok)return json({error:"Wikisource unavailable"},502);
    const data=await response.json() as {query?:{search?:WikiHit[]};continue?:{sroffset?:number}};
    if(!Array.isArray(data.query?.search))return json({error:"Invalid Wikisource data"},502);
    const results=data.query!.search!.filter(x=>x.ns===0&&typeof x.title==="string"&&typeof x.pageid==="number"&&
      x.title.length>0&&x.title.length<=180&&!x.title.includes(":")).map(x=>({id:"wikisource:"+x.pageid,title:x.title!,authors:[],language:"zh",
      sourceUrl:"https://zh.wikisource.org/wiki/"+encodeURIComponent(x.title!.replace(/ /g,"_")),
      epubUrl:"https://ws-export-app.wmcloud.org/?"+new URLSearchParams({lang:"zh",page:x.title!,format:"epub-3",credits:"false"}),
      downloads:0}));
    const output=json({books:results,hasNext:Number.isInteger(data.continue?.sroffset)});
    if(cache){const saved=cache.put(key,output.clone()).catch(()=>{});if(context.waitUntil)context.waitUntil(saved);}
    return output;
  }catch{return json({error:"Wikisource search timed out or unavailable"},502);}
}