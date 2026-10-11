/** Fixed read-only script. Visibility is evaluated on live nodes before cloning.
 * No model-authored selectors or JavaScript enter this source. */
export function browserExtractor(mode: 'article' | 'documentation', scopePath?: number[]): string {
  return `(() => {
    const mode = ${JSON.stringify(mode)};
    const visible = (el) => {
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
            style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.contentVisibility === 'hidden' ||
            (node.tagName === 'DETAILS' && !node.open && el.closest('summary')?.parentElement !== node)) return false;
      }
      return el.getClientRects().length > 0;
    };
    const excluded = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','NAV','ASIDE','FOOTER','INPUT','TEXTAREA','SELECT']);
    let visited = 0, truncated = false;
    const clean = (live) => {
      if (++visited > 20000) { truncated = true; return null; }
      if (live.nodeType === 3) return live.cloneNode();
      if (live.nodeType !== 1 || excluded.has(live.tagName) || live.getAttribute('contenteditable') === 'true' || live.getAttribute('role') === 'textbox' || !visible(live)) return null;
      if (live.tagName === 'BR') return document.createTextNode('\\n');
      const clone = live.cloneNode(false);
      for (const child of live.childNodes) { const copied = clean(child); if (copied) clone.appendChild(copied); if (truncated) break; }
      return clone;
    };
    const http = (href) => { try { const u = new URL(href, location.href); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };
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
    const walk = (node) => {
      if (++nodes > 20000 || blocks.length >= 1000) { truncated = true; return; }
      if (!node || node.nodeType !== 1 || excluded.has(node.tagName) || !visible(node)) return;
      const tag = node.tagName;
      if (/^H[1-6]$/.test(tag) || ['P','LI','PRE','TABLE'].includes(tag)) {
        const clone = clean(node); if (!clone) return;
        if (tag === 'LI') clone.querySelectorAll('ul,ol').forEach(list => list.remove());
        const raw = tag === 'PRE' ? clone.textContent : clone.textContent.replace(/\\s+/g, ' ').trim();
        let text = Array.from(raw).slice(0, 16000).join('');
        if (text.length !== raw.length) truncated = true;
        if (!text) return;
        const id = 'b' + blocks.length;
        const kind = /^H/.test(tag) ? 'heading' : tag === 'LI' ? 'list_item' : tag === 'PRE' ? 'code' : tag === 'TABLE' ? 'table' : 'paragraph';
        if (kind === 'heading') sectionId = id;
        const links = Array.from(clone.querySelectorAll('a[href]')).slice(0,20).flatMap(a => { const url = http(a.getAttribute('href')); return url ? [{title: Array.from(a.textContent).slice(0,100).join(''),url}] : []; });
        const block = {id,kind,text,sectionId,links};
        if (tag === 'TABLE') {
          block.rows = Array.from(clone.querySelectorAll('tr')).slice(0,100).map(row => Array.from(row.children).filter(c => ['TD','TH'].includes(c.tagName)).slice(0,40).map(c => ({text: Array.from(c.textContent.trim()).slice(0,2000).join(''), header: c.tagName === 'TH'})));
          block.text = block.rows.map(row => row.map(c => c.text).join(' | ')).join('\\n');
        }
        const size = encoder.encode(JSON.stringify(block)).length;
        if (bytes + size > 180000) { truncated = true; return; }
        bytes += size; blocks.push(block);
        if (tag === 'LI') for (const child of node.children) if (['UL','OL'].includes(child.tagName)) walk(child);
        return;
      }
      for (const child of node.children) { walk(child); if (truncated) break; }
    };
    walk(root);
    const metadata = document.querySelector('meta[property="article:published_time"],meta[name="datePublished"],meta[itemprop="datePublished"]');
    const date = metadata?.getAttribute('content');
    return {schemaVersion:1,extractorVersion:'semantic-v1',url:location.href,title:document.title.slice(0,500),publishedAt:date ? {value:date.slice(0,200),origin:metadata.getAttribute('property') || metadata.getAttribute('name') || metadata.getAttribute('itemprop')} : null,
      readiness:document.readyState === 'loading' ? 'partial':'ready',representation:mode,scope:selected ? selected.tagName.toLowerCase():'body-fallback',exclusions:['hidden/collapsed','navigation','form values','scripts/styles','cross-origin frames'],blocks,captureTruncated:truncated};
  })()`;
}
