import { browserTargetSelector } from './browser-interactions.js';

export const browserPaintScript = `new Promise(resolve=>{const timer=setTimeout(()=>resolve('timed_out'),2000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve('ready');}));})`;
export const browserStateScript =
  '({url:location.href,documentRevision:String(performance.timeOrigin).replace(".","_"),browserVersion:(navigator.userAgent.match(/Chrome\\/[0-9.]+/)||["unknown"])[0]})';
export function browserFocusScript(key: string, seed: string): string {
  return `(() => {
    const key=${JSON.stringify(key)};
    if(!Object.hasOwn(globalThis,key)) {
      let revision=0, element=document.activeElement;
      const changed=()=>{revision++;element=document.activeElement;};
      document.addEventListener('focusin',changed,true);
      document.addEventListener('focusout',changed,true);
      Object.defineProperty(globalThis,key,{value:()=>{
        if(element!==document.activeElement)changed();
        return {revision:${JSON.stringify(seed)}+':'+revision,focused:Boolean(document.querySelector(':focus'))};
      }});
    }
    return globalThis[key]();
  })()`;
}
export function browserPointScript(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid coordinates');
  return `(() => {const el=document.elementFromPoint(${x},${y});const control=el?.closest('input,textarea,[contenteditable=true]');const secret=control && (/password|secret|token|credit|card|cvc|ssn|one-time-code/i.test([control.name,control.id,control.autocomplete,control.getAttribute('aria-label')].join(' ')) || control.matches('input[type=password],input[type=file],[contenteditable=true]'));return {allowed:Boolean(el && !secret && !el.closest('[aria-disabled=true],iframe') && !el.disabled)};})()`;
}
export function browserDomClickScript(path: number[]): string {
  return `(() => {const el=document.querySelector(${JSON.stringify(browserTargetSelector(path))});if(!el || el.disabled || el.getAttribute('aria-disabled')==='true')throw Error('target unavailable');const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!hit || !(hit===el || el.contains(hit)))throw Error('target occluded');el.click();return {applied:true};})()`;
}
