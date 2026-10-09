// prettier-ignore
(() => {
  const cleanUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  };
  const eligible = element => !element.closest("aside,nav,footer,.comment,.comments,[role=comment],[id^=comment-]");
  const longest = elements => Array.from(elements).filter(eligible).sort((a, b) => (b.textContent || "").length - (a.textContent || "").length)[0];
  const explicit = longest(document.querySelectorAll("[itemprop=articleBody],.entry-content,.post-content"));
  const article = longest(document.querySelectorAll("article"));
  const primaryArticle = article?.querySelector("h1") ? article : null;
  const root = explicit || primaryArticle || document.querySelector("main") || document.querySelector("[role=main]") || article || document.body;
  const content = root.cloneNode(true);
  content.querySelectorAll("script,style,noscript,nav,aside,footer,form,button,.comment,.comments,[role=comment],[hidden],[aria-hidden=true]").forEach(element => element.remove());
  content.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,section,div,br,tr").forEach(element => element.append(document.createTextNode(" ")));
  const text = (content.textContent || "").replace(/\s+/g, " ").trim();
  const metadata = document.querySelector("meta[property=\"article:published_time\"],meta[name=\"datePublished\"],meta[itemprop=\"datePublished\"]");
  const time = root.querySelector("time[itemprop=datePublished],time.published,time.entry-date,[itemprop=datePublished]");
  const date = metadata?.getAttribute("content") || time?.getAttribute("datetime") || time?.getAttribute("content") || time?.textContent?.trim() || null;
  const seen = new Set();
  const links = [];
  for (const anchor of content.querySelectorAll("a[href]")) {
    const url = cleanUrl(anchor.getAttribute("href"));
    const title = (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!url || url === cleanUrl(location.href) || !title || seen.has(url)) continue;
    seen.add(url);
    links.push({title, url});
    if (links.length === 40) break;
  }
  return {
    kind: "trinity-research-page-v1",
    url: cleanUrl(location.href),
    title: (document.title || root.querySelector("h1")?.textContent || "").trim().slice(0, 1000),
    publishedAt: date?.slice(0, 200) || null,
    text: text.slice(0, 24000),
    truncated: text.length > 24000,
    links
  };
})()
