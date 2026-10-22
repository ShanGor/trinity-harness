import { createHash } from 'node:crypto';
import {
  browserInteractionSchema,
  type BrowserSurface,
  type BrowserInteraction,
} from '@trinity-harness/contracts';
import { canonicalBrowserJson } from './browser-artifacts.js';

export { browserSurfaceSchema, type BrowserSurface } from '@trinity-harness/contracts';
export function interactionFromSurface(surface: BrowserSurface): BrowserInteraction {
  const { privacyDenied: _privacy, ...payload } = surface;
  void _privacy;
  return browserInteractionSchema.parse({
    ...payload,
    fingerprint: createHash('sha256').update(canonicalBrowserJson(payload)).digest('hex'),
  });
}
/** Fixed visible DOM accessibility projection. No values or executable page metadata are returned. */
export function browserSurfaceScript(
  filter: 'interactive' | 'all' = 'all',
  scopePath?: number[],
): string {
  return `(() => {
    const scopePath = ${JSON.stringify(scopePath ?? null)};
    const visible = el => {
      for(let p=el;p;p=p.parentElement) { const s=getComputedStyle(p); if(p.hidden || p.getAttribute('aria-hidden')==='true' || s.display==='none' || s.visibility==='hidden' || s.opacity==='0' || (p.tagName==='DETAILS'&&!p.open&&el.closest('summary')?.parentElement!==p)) return false; }
      return el.getClientRects().length>0;
    };
    const path = el => { const result=[]; while(el!==document.documentElement&&el.parentElement) { result.unshift(Array.from(el.parentElement.children).indexOf(el)); el=el.parentElement; } return result; };
    let root=document.documentElement;
    if(scopePath) for(const index of scopePath) root=root?.children[index];
    if(!root || !visible(root)) throw Error('scope unavailable');
    const targets=[]; let visited=0, truncated=false, privacyDenied=false;
    const sensitive=el=>el.matches('input[type=password],input[type=file]') || /password|secret|token|credit|card|cvc|ssn|one-time-code/i.test([el.name,el.id,el.autocomplete,el.getAttribute('aria-label')].join(' '));
    let privateNodes=0;
    for(const el of document.querySelectorAll('input,textarea,[contenteditable=true]')) {
      if(++privateNodes>5000){privacyDenied=true;break;}
      if(visible(el) && (el.getAttribute('contenteditable')==='true' || (sensitive(el) && (el.value || el.type==='file')))) privacyDenied=true;
    }
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);
    for(let el=root;el;el=walker.nextNode()) {
      if(++visited>5000) {truncated=true;break;}
      if(!visible(el)) continue;
      const tag=el.tagName;
      let role=el.getAttribute('role') || ({A:el.hasAttribute('href')?'link':'',BUTTON:'button',INPUT:el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':el.type==='button'||el.type==='submit'?'button':'textbox',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button',MAIN:'main',ARTICLE:'article',SECTION:'region',FORM:'form',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading'}[tag]||'');
      if(!role || (${JSON.stringify(filter)}==='interactive' && !['button','link','textbox','checkbox','radio','combobox','tab','menuitem','switch'].includes(role))) continue;
      if(targets.length>=100) {truncated=true;break;}
      const secret=sensitive(el);
      const labelled=(el.getAttribute('aria-labelledby')||'').split(/\\s+/).slice(0,10).map(id=>document.getElementById(id)?.innerText||'').join(' ');
      const name=secret?'[sensitive control]':(el.getAttribute('aria-label')||labelled.trim()||Array.from(el.labels||[]).map(l=>l.innerText).join(' ')||el.getAttribute('alt')||el.getAttribute('placeholder')||el.innerText||'');
      const r=el.getBoundingClientRect();
      const elementPath=path(el); if(elementPath.length>80){truncated=true;continue;}
      targets.push({ref:'r'+targets.length,role:role.slice(0,100),name:Array.from(name.replace(/\\s+/g,' ').trim()).slice(0,150).join(''),path:elementPath,disabled:Boolean(el.disabled)||el.getAttribute('aria-disabled')==='true',sensitive:secret,activation:tag==='BUTTON'||(tag==='A'&&el.hasAttribute('href'))||(tag==='INPUT'&&['button','submit','reset'].includes(el.type))?'dom':tag==='INPUT'&&['checkbox','radio'].includes(el.type)?'dom':'pointer',box:{x:r.x,y:r.y,width:r.width,height:r.height}});
    }
    return {context:{width:innerWidth,height:innerHeight,scrollX,scrollY,devicePixelRatio,locale:navigator.language.slice(0,100),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone.slice(0,100)},targets,truncated,privacyDenied};
  })()`;
}
export function browserReadinessScript(text: string, timeoutMs: number): string {
  return `(async () => {
    const expected=${JSON.stringify(text)}, timeout=${timeoutMs};
    const ready=()=>document.body?.innerText.includes(expected);
    if(ready()) return 'ready';
    return new Promise(resolve=>{
      const finish=value=>{observer.disconnect();clearTimeout(timer);resolve(value);};
      const observer=new MutationObserver(()=>{if(ready())finish('ready');});
      const timer=setTimeout(()=>finish('timed_out'),timeout);
      observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});
      if(ready())finish('ready');
    });
  })()`;
}
export function browserTargetSelector(path: readonly number[]): string {
  return 'html' + path.map((index) => ` > :nth-child(${index + 1})`).join('');
}
