/** Compact EPUB ZIP-store writer for Aozora XHTML. Text only, no scripts. */
const encoder=new TextEncoder();
function u16(v:DataView,i:number,x:number){v.setUint16(i,x,true);}
function u32(v:DataView,i:number,x:number){v.setUint32(i,x>>>0,true);}
function crc32(data:Uint8Array){
  let n=0xffffffff;
  for(const byte of data){n^=byte;for(let j=0;j<8;j++)n=(n>>>1)^((n&1)?0xedb88320:0);}
  return (n^0xffffffff)>>>0;
}
export function zipEpub(entries:Array<[string,string]>):Blob{
  if(entries.length<3||entries.length>256||entries[0][0]!=="mimetype")throw new Error("无效 EPUB");
  const pieces:Uint8Array[]=[],dir:Uint8Array[]=[];let offset=0;
  for(const [path,value] of entries){
    const name=encoder.encode(path),data=encoder.encode(value);
    if(name.length>200||data.length>25*1024*1024||offset+data.length>25*1024*1024)throw new Error("EPUB 超过 25MB");
    const sum=crc32(data);
    const local=new Uint8Array(30+name.length),v=new DataView(local.buffer);
    u32(v,0,0x04034b50);u16(v,4,20);u16(v,6,0x0800);u32(v,14,sum);
    u32(v,18,data.length);u32(v,22,data.length);u16(v,26,name.length);
    local.set(name,30);
    const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);
    u32(cv,0,0x02014b50);u16(cv,4,20);u16(cv,6,20);u16(cv,8,0x0800);
    u32(cv,16,sum);u32(cv,20,data.length);u32(cv,24,data.length);u16(cv,28,name.length);
    u32(cv,42,offset);central.set(name,46);
    pieces.push(local,data);dir.push(central);offset+=local.length+data.length;
  }
  const end=new Uint8Array(22),ev=new DataView(end.buffer);
  u32(ev,0,0x06054b50);u16(ev,8,entries.length);u16(ev,10,entries.length);
  u32(ev,12,dir.reduce((n,x)=>n+x.length,0));u32(ev,16,offset);
  return new Blob([...pieces,...dir,end].map(x=>x.slice().buffer as ArrayBuffer),{type:"application/epub+zip"});
}
function escapeXml(s:string){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
const ALLOWED=new Set(["ruby","rt","rp","b","strong","em","i","u","small","sub","sup","br","span"]);
function render(node:Node):string{
  if(node.nodeType===3)return escapeXml(node.textContent||"");
  if(node.nodeType!==1)return "";
  const el=node as Element,tag=el.tagName.toLowerCase();
  if(["script","style","iframe","object","embed","form","svg","img","video","audio"].includes(tag))return "";
  const inside=Array.from(el.childNodes).map(render).join("");
  if(tag==="br")return "<br/>";
  return ALLOWED.has(tag)?"<"+tag+">"+inside+"</"+tag+">":inside;
}
/** Turn a sanctioned Aozora main_text into a small offline-readable EPUB. */
export function makeAozoraEpub(html:string,title:string,author:string):Blob{
  if(html.length>5*1024*1024)throw new Error("青空文库正文过大");
  const document=new DOMParser().parseFromString(html,"text/html");
  const main=document.querySelector(".main_text")||document.querySelector("#main_text")||document.body;
  if(!main)throw new Error("青空文库缺少正文");
  let paras=Array.from(main.querySelectorAll("p,h1,h2,h3")).filter(el=>!!el.textContent?.trim());
  if(!paras.length)paras=Array.from(main.children).filter(el=>!!el.textContent?.trim());
  const list=paras.map(el=>{
    const tag=/^H[123]$/.test(el.tagName)?el.tagName.toLowerCase():"p";
    return "<"+tag+">"+Array.from(el.childNodes).map(render).join("")+"</"+tag+">";
  }).filter(s=>s.length>9);
  if(!list.length||list.join("").length<50)throw new Error("无法提取青空文库正文，请尝试其他作品");
  const sections:string[][]=[[]];let count=0;
  for(const para of list){
    if(count+para.length>56000&&sections[sections.length-1].length){sections.push([]);count=0;}
    sections[sections.length-1].push(para);count+=para.length;
  }
  const t=escapeXml(title.slice(0,180)),a=escapeXml(author.slice(0,100));
  const chapters=sections.map((parts,i)=>{
    const titleText=t+(sections.length===1?"":" · "+(i+1));
    return '<?xml version="1.0" encoding="UTF-8"?>'+
      '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja"><head><title>'+titleText+'</title></head>'+
      '<body><h1>'+titleText+'</h1>'+parts.join("")+'</body></html>';
  });
  const navItems=chapters.map((_,i)=>'<li><a href="chapter'+(i+1)+'.xhtml">'+(i+1)+'</a></li>').join("");
  const nav='<?xml version="1.0" encoding="UTF-8"?>'+
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'+
    '<head><title>目次</title></head><body><nav epub:type="toc"><ol>'+navItems+'</ol></nav></body></html>';
  const manifest=chapters.map((_,i)=>'<item id="c'+i+'" href="chapter'+(i+1)+'.xhtml" media-type="application/xhtml+xml"/>').join("");
  const spine=chapters.map((_,i)=>'<itemref idref="c'+i+'"/>').join("");
  const opf='<?xml version="1.0" encoding="UTF-8"?>'+
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">'+
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:hainei:aozora:'+Date.now()+
    '</dc:identifier><dc:title>'+t+'</dc:title><dc:creator>'+a+'</dc:creator><dc:language>ja</dc:language>'+
    '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest>'+
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'+manifest+
    '</manifest><spine>'+spine+'</spine></package>';
  const entries:Array<[string,string]>=[
    ["mimetype","application/epub+zip"],
    ["META-INF/container.xml",'<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ["OEBPS/content.opf",opf],["OEBPS/nav.xhtml",nav],
    ...chapters.map((body,i)=>["OEBPS/chapter"+(i+1)+".xhtml",body] as [string,string])
  ];
  return zipEpub(entries);
}


/** Convert only a trusted, bounded text archive into safe EPUB paragraphs.
 * Soranoha markdown contains ruby HTML, whereas Aozorahack provides the
 * original Shift-JIS Aozora notation. No external content is embedded.
 */
export function makeAozoraFallbackEpub(
  text: string, format: "markdown" | "plain", title: string, author: string,
): Blob {
  if (new TextEncoder().encode(text).byteLength > 5 * 1024 * 1024) {
    throw new Error("青空文库正文过大");
  }
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (format === "plain") {
    // Strip the explanatory preface between Aozora's two dashed separators.
    const boundaries = lines.flatMap((line, i) => /^-{20,}\s*$/.test(line) ? [i] : []);
    if (boundaries.length >= 2 && boundaries[0] < 120 && boundaries[1] < 240) {
      lines = lines.slice(boundaries[1] + 1);
    }
  }
  const markup = lines.map(line => {
    let value = line.trim();
    if (!value) return "";
    if (format === "plain") {
      value = escapeXml(value.replace(/［＃[^］\n]{1,160}］/g, ""));
      // Render Aozora's standard inline reading annotations as EPUB ruby.
      value = value.replace(/｜([^｜《》]{1,60})《([^《》]{1,60})》/g, "<ruby>$1<rt>$2</rt></ruby>");
      value = value.replace(/([\p{Script=Han}々]{1,40})《([^《》]{1,60})》/gu, "<ruby>$1<rt>$2</rt></ruby>");
    } else {
      // Escape markdown's ordinary text, allowing only ruby structural tags.
      value = escapeXml(value).replace(/&lt;(\/?)(ruby|rt|rp)&gt;/gi, "<$1$2>");
    }
    const heading = format === "markdown" ? /^(#{1,3})\s+(.+)$/.exec(value) : null;
    if (heading) return "<h" + heading[1].length + ">" + heading[2] +
      "</h" + heading[1].length + ">";
    return "<p>" + value + "</p>";
  }).filter(Boolean);
  return makeAozoraEpub('<div class="main_text">' + markup.join("") + "</div>", title, author);
}
