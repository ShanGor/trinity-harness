import {
  BROWSER_DOCUMENT_LIMITS as LIMITS,
  BROWSER_PRESENTATION_PROPERTIES,
  BROWSER_PRESENTATION_VALUE,
  BROWSER_PRESENTATION_FUNCTION,
  BROWSER_VECTOR_TAGS,
  BROWSER_VECTOR_ATTRIBUTES,
} from '@trinity-harness/contracts';
import { documentDigestScript } from './browser-document-digest.js';

/** Fixed isolated-world serializer. It never clones raw DOM or buffers unbounded outerHTML. */
export function documentCaptureScript(
  key: string,
  revision: string,
  assetLimit: number = LIMITS.assets,
): string {
  return `(() => {
    const key=${JSON.stringify(key)}, revision=${JSON.stringify(revision)}, limit=${LIMITS.documentBytes}-4096;
    const old=globalThis[key];if(old){old.observer.disconnect();old.expiry?.removeEventListener('abort',old.expire);delete globalThis[key];}
    const encoder=new TextEncoder(),nodes=[],resources=[],exclusions=new Set(['hidden','active-content','controls','closed-shadow','canvas-pixels','media-unavailable']);
    let bytes=0,visited=0,vectorInspected=0,truncated=false,mediaLimited=false;
    const visible=el=>{for(let p=el;p;p=p.parentElement||p.getRootNode()?.host){const s=getComputedStyle(p);if(p.hidden||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||s.opacity==='0'||s.contentVisibility==='hidden'||(p.tagName==='DETAILS'&&!p.open&&el.closest('summary')?.parentElement!==p))return false;}return (el.namespaceURI==='http://www.w3.org/2000/svg'&&el.localName!=='svg')||el.getClientRects().length>0; };
    const roots=[document];let inspected=0;
    for(let i=0;i<roots.length;i++){
      if(roots.length>100)return {denied:true};
      const walker=document.createTreeWalker(roots[i],NodeFilter.SHOW_ELEMENT);
      for(let el=walker.nextNode();el;el=walker.nextNode()){
        if(++inspected>${LIMITS.nodes})return {denied:true};
        if(el.shadowRoot)roots.push(el.shadowRoot);
        if(!visible(el))continue;
        const editable=(el.hasAttribute('contenteditable')&&el.getAttribute('contenteditable')!=='false')||el.getAttribute('role')==='textbox';
        const sensitive=el.matches('input[type=password],input[type=file]')||/password|secret|token|credit|card|cvc|ssn|one-time-code/i.test([el.name,el.id,el.autocomplete,el.getAttribute('aria-label')].join(' '));
        if((editable&&(el.textContent.trim()||el.querySelector('img,svg,video,audio,canvas,iframe,object,embed,input,textarea,select')))||(sensitive&&(el.value||el.type==='file')))return {denied:true};
      }
    }
    const http=value=>{try{if(typeof value!=='string'||!value.trim()||value.length>2000)return;const u=new URL(value,document.baseURI);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.href.length<=2000&&!Array.from(u.searchParams.keys()).some(k=>/token|secret|password|api[-_]?key|authorization|^code$/i.test(k)))return u.href;}catch{}};
    const url=http(location.href)||(location.href==='about:srcdoc'||location.href==='about:blank'?null:undefined);
    if(url===undefined)return {denied:true};
    const state={observer:null,dirty:false,revision,text:'',url,expiry:null,expire:null};
    const observer=new MutationObserver(()=>{state.dirty=true;});state.observer=observer;
    for(const root of roots)observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});
    state.expiry=AbortSignal.timeout(${LIMITS.deadlineMs});state.expire=()=>{observer.disconnect();if(globalThis[key]===state)delete globalThis[key];};state.expiry.addEventListener('abort',state.expire,{once:true});
    const properties=${JSON.stringify(BROWSER_PRESENTATION_PROPERTIES)},styleValue=new RegExp(${JSON.stringify(BROWSER_PRESENTATION_VALUE)}),styleFunction=new RegExp(${JSON.stringify(BROWSER_PRESENTATION_FUNCTION)},'i');
    const vectorTags=new Set(${JSON.stringify(BROWSER_VECTOR_TAGS)}),vectorAttributes=${JSON.stringify(BROWSER_VECTOR_ATTRIBUTES)};
    const allowed=new Set('html body div section article main header footer nav aside p span h1 h2 h3 h4 h5 h6 ul ol li pre code blockquote table thead tbody tfoot tr th td a strong em b i br hr img figure figcaption iframe svg canvas video audio picture source'.split(' '));
    const emit=node=>{const size=encoder.encode(JSON.stringify(node)).length;if(bytes+size>limit||nodes.length>=${LIMITS.nodes}){truncated=true;exclusions.add('byte-limit');return false;}bytes+=size;nodes.push(node);return true;};
    const media=(el,node,role,source)=>{
      if(resources.length>=${assetLimit}){mediaLimited=true;return;}
      const r={id:'a'+resources.length,nodeId:node.id,role,state:'unsupported'};
      const url=http(source);if(url){r.url=url;r.state='reference-only';}
      if(role==='image'){
        r.width=Math.min(100000,el.naturalWidth||0);r.height=Math.min(100000,el.naturalHeight||0);
        if(!el.complete||!el.naturalWidth)r.state='not-loaded';
        else if(el.naturalWidth<=2048&&el.naturalHeight<=2048){
          try{const c=document.createElement('canvas');c.width=el.naturalWidth;c.height=el.naturalHeight;c.getContext('2d').drawImage(el,0,0);const data=c.toDataURL('image/png');if(data.length<=120000&&bytes+data.length+2048<limit){r.data=data;r.mimeType='image/png';r.state='captured';}else r.state='limit-reached';}catch{r.state='blocked';}
        }else r.state='limit-reached';
      }
      if(['video','audio'].includes(role)&&el.readyState===0)r.state='not-loaded';
      const size=encoder.encode(JSON.stringify(r)).length;if(bytes+size+512>limit){truncated=true;return;}bytes+=size;resources.push(r);node.resourceId??=r.id;
    };
    const walk=(live,parentId,path,depth)=>{
      if(++visited>${LIMITS.nodes}||depth>70){truncated=true;exclusions.add('node-limit');return;}
      if(live.nodeType===3){const text=live.data;if(text.length>64000){truncated=true;exclusions.add('byte-limit');return;}if(text)emit({id:'n'+nodes.length,parentId,tag:'text',text,path});return;}
      if(live.nodeType!==1||!visible(live))return;
      const tag=live.tagName.toLowerCase(),isVector=live.namespaceURI==='http://www.w3.org/2000/svg',vectorTag=tag==='text'?'svg-text':tag;
      if(isVector&&!vectorTags.has(vectorTag)){exclusions.add('vector-omitted');return;}
      if(['script','style','noscript','template','input','textarea','select','option','button','object','embed'].includes(tag)||(live.hasAttribute('contenteditable')&&live.getAttribute('contenteditable')!=='false')||live.getAttribute('role')==='textbox')return;
      const node={id:'n'+nodes.length,parentId,tag:isVector?vectorTag:tag==='frame'?'iframe':allowed.has(tag)?tag:'div',path};
      const computed=getComputedStyle(live),presentation={};
      for(const name of properties){const value=computed.getPropertyValue(name).trim();if(!value)continue;if(value.length<=512&&styleValue.test(value)&&!styleFunction.test(value))presentation[name]=value;else exclusions.add('presentation-omitted');}
      if(Object.keys(presentation).length)node.presentation=presentation;
      if(isVector){node.vector={};for(const [name,pattern] of Object.entries(vectorAttributes)){const value=live.getAttribute(name);if(value===null)continue;if(value.length<=16000&&new RegExp(pattern).test(value))node.vector[name]=value;else exclusions.add('vector-omitted');}}
      if(tag==='td'||tag==='th'){if(live.colSpan>1)node.colSpan=live.colSpan;if(live.rowSpan>1)node.rowSpan=live.rowSpan;}
      const rect=live.getBoundingClientRect();if([rect.x,rect.y,rect.width,rect.height].every(v=>Number.isFinite(v)&&Math.abs(v)<=10000000))node.box={x:rect.x,y:rect.y,width:Math.max(0,rect.width),height:Math.max(0,rect.height)};
      if(tag==='ol'&&Number.isInteger(live.start)&&Math.abs(live.start)<=1000000)node.listStart=live.start;
      if(tag==='a'){const href=http(live.getAttribute('href'));if(href)node.href=href;}
      if(!emit(node))return;
      if(tag==='img'){node.alt=(live.getAttribute('alt')||'').slice(0,1000);media(live,node,'image',live.currentSrc||live.src);}
      else if(tag==='canvas')media(live,node,tag,null);
      else if(tag==='svg'){
        media(live,node,'svg',null);
        const resource=resources.find(r=>r.id===node.resourceId);
        // Unsupported descendants/references are inventoried even though they are never serialized.
        let supported=true;
        const inventory=document.createTreeWalker(live,NodeFilter.SHOW_ELEMENT);
        for(let el=live;el;el=inventory.nextNode()){
          if(++vectorInspected>${LIMITS.nodes}){supported=false;break;}
          const name=el.localName==='text'?'svg-text':el.localName;
          if(!vectorTags.has(name)||el.hasAttribute('href')||el.hasAttribute('xlink:href')||['filter','mask','clip-path','marker-start','marker-mid','marker-end'].some(a=>el.hasAttribute(a)||!['','none'].includes(getComputedStyle(el).getPropertyValue(a))))supported=false;
          for(const name of ['fill','stroke']){const value=getComputedStyle(el).getPropertyValue(name);if(value&&(!styleValue.test(value)||styleFunction.test(value)))supported=false;}
          for(const [attr,pattern] of Object.entries(vectorAttributes)){const value=el.getAttribute(attr);if(value!==null&&(value.length>16000||!new RegExp(pattern).test(value)))supported=false;}
        }
        if(resource&&supported)resource.state='inline';else exclusions.add('vector-omitted');
      }
      else if(tag==='video'||tag==='audio'){media(live,node,tag,live.currentSrc||live.src);if(tag==='video'&&live.poster)media(live,node,'poster',live.poster);}
      const background=getComputedStyle(live).backgroundImage;
      if(background&&background!=='none'){let found=false;if(background.length<=4096)for(const match of background.matchAll(/url\\(["']?(.*?)["']?\\)/g)){media(live,node,'background',match[1]);found=true;}if(!found)media(live,node,'background',null);}
      if(['iframe','frame','canvas','video','audio','img'].includes(tag))return;
      if(tag==='slot'){
        const assigned=live.assignedNodes({flatten:true});
        if(assigned.length){for(const child of assigned){if(truncated)break;let el=child,p=[];while(el!==document.documentElement){const parent=el.parentNode;if(!parent||p.length>=80){truncated=true;break;}if(parent.nodeType===11&&parent.host){p.unshift(Array.prototype.indexOf.call(parent.childNodes,el));p.unshift(-1);el=parent.host;}else{p.unshift(Array.prototype.indexOf.call(parent.childNodes,el));el=parent;}}if(!truncated)walk(child,node.id,p,depth+1);}return;}
      }
      if(live.shadowRoot){const shadow={id:'n'+nodes.length,parentId:node.id,tag:'shadow',path:[...path,-1]};if(emit(shadow)){let i=0;for(const child of live.shadowRoot.childNodes){if(truncated)break;walk(child,shadow.id,[...path,-1,i++],depth+1);}}return;}
      let i=0;for(const child of live.childNodes){if(truncated)break;walk(child,node.id,[...path,i++],depth+1);}
    };
    try{
      walk(document.documentElement,null,[],0);
      if(observer.takeRecords().length)state.dirty=true;
      const payload={presentationVersion:1,url,title:document.title.slice(0,1000),revision,nodes,resources,exclusions:[...exclusions],truncated:truncated||mediaLimited};
      state.text=JSON.stringify(payload);if(encoder.encode(state.text).length>${LIMITS.documentBytes}){observer.disconnect();state.expiry.removeEventListener('abort',state.expire);return {limit:true};}
      globalThis[key]=state;
      return {length:state.text.length,bytes:encoder.encode(state.text).length,hash:(${documentDigestScript})(state.text),revision};
    }catch{observer.disconnect();state.expiry.removeEventListener('abort',state.expire);throw Error('Capture serialization failed');}
  })()`;
}
export function documentChunkScript(key: string, revision: string, offset: number): string {
  // 8000 UTF-16 units are <= 48 KiB after JSON escaping; NDJSON stays bounded.
  return `(()=>{const s=globalThis[${JSON.stringify(key)}];if(!s||s.revision!==${JSON.stringify(revision)}||s.dirty||s.observer.takeRecords().length)return {stale:true};const text=s.text.slice(${offset},${offset}+8000);return {offset:${offset},revision:s.revision,bytes:new TextEncoder().encode(text).length,hash:(${documentDigestScript})(text),text};})()`;
}
export function documentReleaseScript(key: string, check: boolean): string {
  return `(()=>{const key=${JSON.stringify(key)},s=globalThis[key];if(!s)return {stale:true};const stale=s.dirty||s.observer.takeRecords().length>0;${check ? 'return {stale};' : 's.observer.disconnect();s.expiry?.removeEventListener("abort",s.expire);delete globalThis[key];return {stale};'}})()`;
}
