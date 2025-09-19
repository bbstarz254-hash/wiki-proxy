import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';
import fs from 'fs';
import Parser from 'rss-parser';

dotenv.config();

const app = express();
const parser = new Parser();

app.use(cors());
app.use(bodyParser.json());

// 🔹 Load RSS feeds from feeds.json
const feedsConfig = JSON.parse(fs.readFileSync('./feeds.json', 'utf-8'));
const feedUrls = feedsConfig.rssFeeds || [];

// 🔹 Cache system with TTL
const cache = new Map();
const TTL = { wiki: 60 * 60 * 1000, rss: 10 * 60 * 1000, ddg: 15 * 60 * 1000 };
const wikiNodeCache = new Map();
const agent = new https.Agent({ keepAlive: true });

function setCache(key, data, type) {
  cache.set(key, { data, expiry: Date.now() + (TTL[type] || 300000) });
}

function getCache(key) {
  const cached = cache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.data;
  cache.delete(key);
  return null;
}

// 🔹 Fetch full Wikipedia summary
async function fetchWikipedia(query) {
  const cacheKey = `wiki:${query}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const params = {
      action: 'query',
      prop: 'extracts',
      explaintext: 'true',
      titles: query,
      format: 'json',
      exintro: false,
    };

    const headers = { 'User-Agent': 'FanBoxAppProxy/1.0' };
    const response = await axios.get('https://en.wikipedia.org/w/api.php', {
      params,
      headers,
      httpsAgent: agent,
      timeout: 15000,
    });

    const pages = response.data.query.pages;
    const pageId = Object.keys(pages)[0];
    const extract = pages[pageId].extract || 'No Wikipedia content found.';

    setCache(cacheKey, extract, 'wiki');
    return extract;
  } catch (err) {
    console.error('Wikipedia fetch error:', err.message);
    return 'Error fetching Wikipedia.';
  }
}

// 🔹 Fetch DuckDuckGo full search results (Unofficial Wrapper)
async function fetchDuckDuckGo(query) {
  const cacheKey = `ddg:${query}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get('https://ddg-api.herokuapp.com/search', {
      params: { query },
      timeout: 15000,
    });

    const results = response.data?.results || [];
    const formatted = results.slice(0, 10).map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    }));

    setCache(cacheKey, formatted, 'ddg');
    return formatted;
  } catch (err) {
    console.error('DuckDuckGo fetch error:', err.message);
    return [
      { title: 'Error fetching DuckDuckGo results', link: '', snippet: '' },
    ];
  }
}

// 🔹 Fetch & parse RSS feeds with rss-parser, filter by celebrity name
async function fetchRSSFeeds(feeds, prompt) {
  const results = [];

  for (const feed of feeds) {
    const cacheKey = `rss:${feed.url}`;
    const cached = getCache(cacheKey);

    let parsedFeed;
    try {
      parsedFeed = cached || (await parser.parseURL(feed.url));

      // 🔹 Filter items by prompt if provided
      let articles = parsedFeed.items.filter(
        (item) =>
          (item.title &&
            item.title.toLowerCase().includes(prompt.toLowerCase())) ||
          (item.contentSnippet &&
            item.contentSnippet.toLowerCase().includes(prompt.toLowerCase())),
      );

      if (articles.length === 0) {
        articles = [{ title: `No matching articles found for "${prompt}"` }];
      } else {
        articles = articles.slice(0, 5).map((item) => ({
          title: item.title || 'Untitled',
          description:
            item.contentSnippet || item.content || 'No description available.',
          link: item.link || 'No link available.',
        }));
      }

      const formatted = {
        feed: feed.name || feed.url,
        articles,
      };

      setCache(cacheKey, parsedFeed, 'rss'); // cache raw feed, not filtered
      results.push(formatted);
    } catch (error) {
      console.error(`RSS fetch error (${feed.url}):`, error.message);
      results.push({
        feed: feed.name || feed.url,
        error: `Error fetching feed`,
      });
    }
  }

  return results;
}

// 🔹 Preload RSS feeds
async function preloadFeeds() {
  console.log('⏳ Preloading RSS feeds...');
  await fetchRSSFeeds(feedUrls, ''); // preload with no filter
  console.log('✅ Preloading done');
}
preloadFeeds();
setInterval(preloadFeeds, 10 * 60 * 1000);

// 🔹 /generate endpoint
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const wikiText = await fetchWikipedia(prompt);
    const rssResults = await fetchRSSFeeds(feedUrls, prompt);
    const ddgResults = await fetchDuckDuckGo(prompt);

    res.json({
      wikipedia: wikiText,
      rss: rssResults,
      duckduckgo: ddgResults,
    });
  } catch (err) {
    console.error('Proxy /generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Wikipedia direct API endpoint
app.get('/api/wikipedia', async (req, res) => {
  try {
    const params = req.query;
    const cacheKey = JSON.stringify(params);
    const cached = wikiNodeCache.get(cacheKey);
    if (cached) return res.json(cached);

    const headers = { 'User-Agent': 'FanBoxAppProxy/1.0' };
    const response = await axios.get('https://en.wikipedia.org/w/api.php', {
      params,
      headers,
      httpsAgent: agent,
      timeout: 15000,
    });

    wikiNodeCache.set(cacheKey, response.data);
    res.json(response.data);
  } catch (err) {
    console.error('Wikipedia direct fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Root
app.get('/', (req, res) => {
  res.send('✅ Unified AI Proxy running. Use /generate, /api/wikipedia');
});

// 🔹 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Unified AI Proxy listening on http://localhost:${PORT}`),
);
