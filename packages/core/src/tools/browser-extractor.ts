/** Fixed read-only script. Visibility is evaluated on live nodes before cloning.
 * No model-authored selectors or JavaScript enter this source. */
export function browserExtractor(
  mode: 'article' | 'documentation',
  scopePath?: number[],
  embedded = false,
): string {
  return `(function extract(document, depth = 0) {
    const mode = ${JSON.stringify(mode)};
    const visible = (el) => {
      for (let node = el; node && node.nodeType === 1; node = node.parentElement || node.getRootNode()?.host) {
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
            style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.contentVisibility === 'hidden' ||
            (node.tagName === 'DETAILS' && !node.open && el.closest('summary')?.parentElement !== node)) return false;
      }
      return el.getClientRects().length > 0;
    };
    const roots=[document];
    for(let i=0;i<roots.length;i++) {
      if(roots.length>100)return {privacyDenied:true};
      let count=0;
      for(const el of roots[i].querySelectorAll('*')) {if(++count>20000)return {privacyDenied:true};if(el.shadowRoot)roots.push(el.shadowRoot);}
    }
    const privateControls=roots.flatMap(root=>Array.from(root.querySelectorAll('input,textarea,[contenteditable]')));
    // Check every readable document before returning any of its content.
    if(depth > 0 || ${embedded}) for (const el of privateControls.slice(0,5001)) {
      const editable = el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false';
      const sensitive = el.matches('input[type=password],input[type=file]') || /password|secret|token|credit|card|cvc|ssn|one-time-code/i.test([el.name,el.id,el.autocomplete,el.getAttribute('aria-label')].join(' '));
      if (visible(el) && ((editable && (el.textContent.trim() || el.querySelector('img,svg,video,audio,canvas,iframe,object,embed,input,textarea,select'))) || (sensitive && (el.value || el.type === 'file')))) return {privacyDenied:true};
    }
    if((depth > 0 || ${embedded}) && privateControls.length > 5000) return {privacyDenied:true};
    const excluded = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','NAV','ASIDE','FOOTER','INPUT','TEXTAREA','SELECT']);
    let visited = 0, truncated = false;
    const clean = (live) => {
      if (++visited > 20000) { truncated = true; return null; }
      if (live.nodeType === 3) return live.cloneNode();
      if (live.nodeType !== 1 || excluded.has(live.tagName) || (live.hasAttribute('contenteditable') && live.getAttribute('contenteditable') !== 'false') || live.getAttribute('role') === 'textbox' || !visible(live)) return null;
      if (live.tagName === 'BR') return document.createTextNode('\\n');
      const clone = live.cloneNode(false);
      for (const child of (live.shadowRoot || live).childNodes) { const copied = clean(child); if (copied) clone.appendChild(copied); if (truncated) break; }
      return clone;
    };
    const http = (href) => { try { const u = new URL(href, document.baseURI); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password && u.href.length <= 2000 ? u.href : null; } catch { return null; } };
    const selected = mode === 'article' ? document.querySelector('article, [role="main"], main') : document.querySelector('main, [role="main"], article');
    let root = selected || document.body;
    const scopePath = ${JSON.stringify(scopePath ?? null)};
    if (scopePath) { root = document.documentElement; for (const index of scopePath) root = root?.children[index]; if (!root || !visible(root)) throw Error('scope unavailable'); }
    if (mode === 'article' && root && !scopePath) {
      const bodies = Array.from(root.querySelectorAll('[itemprop="articleBody"], .entry-content, .article-content, .post-content')).slice(0,100).filter(visible);
      if (bodies.length) root = bodies.sort((a,b) => Math.min(b.textContent.length,20000)-Math.min(a.textContent.length,20000))[0];
    }
    const blocks = []; let sectionId = null, bytes = 0, nodes = 0;
    const encoder = new TextEncoder();
    const semantic = tag => /^H[1-6]$/.test(tag) || ['P','LI','PRE','TABLE'].includes(tag);
    const emit = (clone, tag, enclosingHref) => {
        if (blocks.length >= 1000) { truncated = true; return; }
        if (tag === 'LI') clone.querySelectorAll('ul,ol').forEach(list => list.remove());
        const raw = tag === 'PRE' ? clone.textContent : clone.textContent.replace(/\\s+/g, ' ').trim();
        let text = Array.from(raw).slice(0, 16000).join('');
        if (text.length !== raw.length) truncated = true;
        if (!text) return;
        const id = 'b' + blocks.length;
        const kind = /^H/.test(tag) ? 'heading' : tag === 'LI' ? 'list_item' : tag === 'PRE' ? 'code' : tag === 'TABLE' ? 'table' : 'paragraph';
        if (kind === 'heading') sectionId = id;
        const enclosingUrl = enclosingHref == null ? null : http(enclosingHref);
        const anchors = [...(clone.matches('a[href]') ? [clone] : []), ...clone.querySelectorAll('a[href]')];
        const links = enclosingUrl ? [{title: Array.from(text).slice(0,100).join(''), url: enclosingUrl}] : [];
        for (const a of anchors.slice(0,20)) {
          const url = http(a.getAttribute('href'));
          if (url && !links.some(link => link.url === url) && links.length < 20)
            links.push({title: Array.from(a.textContent).slice(0,100).join(''), url});
        }
        const block = {id,kind,text,sectionId,links};
        if(kind==='heading')block.level=Number(tag.slice(1));
        if (tag === 'TABLE') {
          // Bound the aggregate too: individually bounded cells can still
          // exceed the block schema or consume the entire artifact allowance.
          block.rows = []; let tableChars = 0;
          const rows = Array.from(clone.querySelectorAll('tr'));
          if (rows.length > 100) truncated = true;
          for (const row of rows.slice(0,100)) {
            const cells = Array.from(row.children).filter(c => ['TD','TH'].includes(c.tagName));
            if (cells.length > 40) truncated = true;
            const values = [];
            for (const cell of cells.slice(0,40)) {
              const rawCell = cell.textContent.trim();
              const value = Array.from(rawCell).slice(0,2000).join('');
              if (value.length !== rawCell.length) truncated = true;
              const separator = values.length ? 3 : block.rows.length ? 1 : 0;
              const remaining = 16000 - tableChars - separator;
              if (remaining <= 0) { truncated = true; break; }
              const text = Array.from(value).slice(0,remaining).join('');
              values.push({text,header:cell.tagName==='TH'});
              tableChars += Array.from(text).length + separator;
              if (text.length !== value.length) { truncated = true; break; }
            }
            if (values.length) block.rows.push(values);
            if (tableChars >= 16000) { truncated = true; break; }
          }
          block.text = block.rows.map(row => row.map(c => c.text).join(' | ')).join('\\n');
        }
        const size = encoder.encode(JSON.stringify(block)).length;
        if (bytes + size > 180000) { truncated = true; return; }
        bytes += size; blocks.push(block);
    };
    const walk = (node) => {
      if (++nodes > 20000 || blocks.length >= 1000) { truncated = true; return; }
      if (!node || ![1,11].includes(node.nodeType) || (node.nodeType===1 && (excluded.has(node.tagName) || (node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false') || node.getAttribute('role') === 'textbox' || !visible(node)))) return;
      if(node.shadowRoot){walk(node.shadowRoot);return;}
      const tag = node.tagName;
      if(tag === 'IMG') {
        const url=http(node.currentSrc || node.getAttribute('src'));
        if(url && blocks.length<1000) {
          const alt=Array.from(node.getAttribute('alt') || '').slice(0,1000).join('');
          const block={id:'b'+blocks.length,kind:'paragraph',text:alt || 'Image',sectionId,links:[{title:alt || 'Image',url}],image:{url,alt}};
          // Use already decoded browser pixels only. Never fetch or change CORS.
          if(node.complete && node.naturalWidth>0 && node.naturalWidth<=2048 && node.naturalHeight<=2048) {
            try {
              const canvas=document.createElement('canvas');canvas.width=node.naturalWidth;canvas.height=node.naturalHeight;
              canvas.getContext('2d').drawImage(node,0,0);
              const data=canvas.toDataURL('image/png');
              if(data.length<=120000 && bytes+data.length<160000)block.image.data=data;
            } catch { /* Tainted or unavailable pixels retain the observed remote URL. */ }
          }
          const size=encoder.encode(JSON.stringify(block)).length;
          if(bytes+size>180000)truncated=true;else {bytes+=size;blocks.push(block);}
        }
        return;
      }
      if (semantic(tag)) {
        const clone = clean(node); if (!clone) return;
        emit(clone, tag, node.closest?.('a[href]')?.getAttribute('href'));
        for(const image of node.querySelectorAll('img'))walk(image);
        if (tag === 'LI') for (const child of node.children) if (['UL','OL'].includes(child.tagName)) walk(child);
        return;
      }
      // Preserve text between block containers, including SPA div/span content.
      // Inline runs share one block so links and adjacent text keep their order.
      let run = document.createElement('div');
      const flush = () => { if (run.childNodes.length) emit(run, 'DIV', node.closest?.('a[href]')?.getAttribute('href')); run = document.createElement('div'); };
      for (const child of node.childNodes) {
        if (++nodes > 20000) { truncated = true; break; }
        if (child.nodeType === 3) { const copied = clean(child); if (copied) run.appendChild(copied); }
        else if (child.nodeType === 1) {
          if (excluded.has(child.tagName) || (child.hasAttribute('contenteditable') && child.getAttribute('contenteditable') !== 'false') || child.getAttribute('role') === 'textbox' || !visible(child)) continue;
          const display = child.ownerDocument.defaultView.getComputedStyle(child).display;
          if (child.shadowRoot || child.tagName === 'IMG' || semantic(child.tagName) || /^(block|flow-root|flex|grid|table|list-item)/.test(display) || child.querySelector('h1,h2,h3,h4,h5,h6,p,li,pre,table,div,section,article')) {
            flush(); if (truncated) break; walk(child);
          } else { const copied = clean(child); if (copied) run.appendChild(copied); }
        }
        if (truncated) break;
      }
      flush();
    };
    walk(root);
    let embeddedFrames = 0, unavailableFrames = 0;
    if (!scopePath) for (const frame of Array.from(root.querySelectorAll('iframe,frame')).filter(visible).slice(0,20)) {
      if (${embedded}) {unavailableFrames++;continue;}
      if (depth >= 3) { unavailableFrames++; truncated=true; continue; }
      let child;
      try { child=frame.contentDocument; } catch { child=null; }
      if (!child?.body) { unavailableFrames++; continue; }
      if (Array.from(new URL(child.baseURI).searchParams.keys()).some(key=>/token|secret|password|api[-_]?key|authorization|^code$/i.test(key)))return {privacyDenied:true};
      const captured=extract(child, depth+1);
      if(captured.privacyDenied) return {privacyDenied:true};
      embeddedFrames++;
      unavailableFrames += captured.extraction.unavailableFrames;
      truncated ||= captured.captureTruncated;
      for(const block of captured.blocks) {
        const size=encoder.encode(JSON.stringify(block)).length;
        if(blocks.length>=1000 || bytes+size>180000){truncated=true;break;}
        bytes+=size;
        const id='b'+blocks.length;
        if(block.kind==='heading')sectionId=id;
        blocks.push({...block,id,sectionId});
      }
    }

    // Report bounded structural coverage independently of text delivery.
    // Managed frame evaluation uses adapter-owned identity and privacy checks.
    const extraction = {status: !blocks.length ? 'empty' : blocks.every(b => b.kind === 'heading') ? 'heading-only' : 'text-captured', visibleFrames:0,openShadowRoots:0,canvases:0,inspectionTruncated:false,scope:'top-document',embeddedFrames,unavailableFrames};
    const inspector = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let inspected = 0;
    for (let el=root; el; el=inspector.nextNode()) {
      if (++inspected > 5000) { extraction.inspectionTruncated=true; break; }
      if (!visible(el)) continue;
      const key = ['IFRAME','FRAME'].includes(el.tagName) ? 'visibleFrames' : el.shadowRoot ? 'openShadowRoots' : el.tagName === 'CANVAS' ? 'canvases' : null;
      if (key) { if(extraction[key] < 100) extraction[key]++; else extraction.inspectionTruncated=true; }
    }
    const metadata = document.querySelector('meta[property="article:published_time"],meta[name="datePublished"],meta[itemprop="datePublished"]');
    const date = metadata?.getAttribute('content');
    return {schemaVersion:1,extractorVersion:'semantic-v2',url:location.href,title:document.title.slice(0,500),publishedAt:date ? {value:date.slice(0,200),origin:metadata.getAttribute('property') || metadata.getAttribute('name') || metadata.getAttribute('itemprop')} : null,
      extraction,readiness:document.readyState === 'loading' || extraction.status !== 'text-captured' ? 'partial':'ready',representation:mode,scope:selected ? selected.tagName.toLowerCase():'body-fallback',exclusions:['hidden/collapsed','navigation','form values','scripts/styles','inaccessible embedded frames','closed shadow roots','canvas text'],blocks,captureTruncated:truncated};
  })(document)`;
}
