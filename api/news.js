// api/news.js
// Vercel serverless function — runs on the server, no CORS issues
// Fetches multiple F1 RSS feeds, parses them, returns clean JSON
// Called by the app as: fetch('/api/news')

export default async function handler(req, res) {
  // Allow the browser to cache for 5 minutes
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const FEEDS = [
    { url: 'https://www.autosport.com/rss/f1/news/',          source: 'Autosport',       icon: '🏎' },
    { url: 'https://www.motorsport.com/rss/f1/news/',         source: 'Motorsport.com',  icon: '🏁' },
    { url: 'https://feeds.skysports.com/skysports/f1/news',   source: 'Sky Sports F1',   icon: '📺' },
    { url: 'https://the-race.com/category/formula-1/feed/',   source: 'The Race',        icon: '⚡' },
  ];

  async function fetchFeed(feed) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(feed.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'F1Hub/1.0 RSS Reader' },
      });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const xml = await res.text();
      return parseRSS(xml, feed);
    } catch {
      clearTimeout(timeout);
      return [];
    }
  }

  function parseRSS(xml, feed) {
    const items = [];
    // Extract <item> blocks
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title   = extractTag(block, 'title');
      const link    = extractTag(block, 'link') || extractTag(block, 'guid');
      const pubDate = extractTag(block, 'pubDate');
      const desc    = extractTag(block, 'description') || extractTag(block, 'content:encoded') || '';

      if (!title || !link) continue;

      const ts = pubDate ? new Date(pubDate).getTime() : 0;
      if (isNaN(ts) || ts === 0) continue;

      items.push({
        title:   cleanText(title),
        url:     cleanText(link),
        summary: cleanText(desc).slice(0, 180),
        source:  feed.source,
        icon:    feed.icon,
        tag:     categorise(title),
        pubDate: pubDate,
        ts,
      });
    }
    return items;
  }

  function extractTag(xml, tag) {
    // Handle CDATA and plain text
    const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
    const m  = xml.match(re);
    return m ? m[1].trim() : '';
  }

  function cleanText(str) {
    return str
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g,  ' ')
      .replace(/&amp;/g,   '&')
      .replace(/&lt;/g,    '<')
      .replace(/&gt;/g,    '>')
      .replace(/&quot;/g,  '"')
      .replace(/&#39;/g,   "'")
      .replace(/\s+/g,     ' ')
      .trim();
  }

  function categorise(title) {
    const t = title.toLowerCase();
    if (t.includes('race result') || t.includes('wins') || t.includes('victory'))  return 'RACE';
    if (t.includes('qualify') || t.includes('pole'))          return 'QUALIFYING';
    if (t.includes('sprint'))                                  return 'SPRINT';
    if (t.includes('practice') || t.includes(' fp1') || t.includes(' fp2') || t.includes(' fp3')) return 'PRACTICE';
    if (t.includes('contract') || t.includes('sign') || t.includes(' joins '))     return 'TRANSFER';
    if (t.includes('crash') || t.includes('incident') || t.includes('collision'))  return 'INCIDENT';
    if (t.includes('engine') || t.includes('power unit') || t.includes('upgrade')) return 'TECHNICAL';
    if (t.includes('champion') || t.includes('standings'))    return 'CHAMPIONSHIP';
    if (t.includes('penalty') || t.includes('steward') || t.includes('banned'))    return 'RULING';
    if (t.includes('preview') || t.includes('preview'))       return 'PREVIEW';
    return 'F1';
  }

  try {
    // Fetch all feeds in parallel
    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    const all     = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

    if (!all.length) {
      return res.status(503).json({ error: 'All feeds failed', articles: [] });
    }

    // Deduplicate by URL, sort newest first
    const seen    = new Set();
    const articles = all
      .filter(a => {
        if (seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 40);

    res.status(200).json({ articles, fetchedAt: Date.now() });

  } catch (err) {
    res.status(500).json({ error: err.message, articles: [] });
  }
}
