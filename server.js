import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';
import Parser from 'rss-parser';
import fs from 'fs';

dotenv.config(); // Load .env file

const app = express();
const parser = new Parser();

app.use(cors());
app.use(bodyParser.json());

// 🔹 Load RSS feeds from feeds.json
const feedsConfig = JSON.parse(fs.readFileSync('./feeds.json', 'utf-8'));
const feedUrls = feedsConfig.feeds || [];

// 🔹 Cache system (per type) with TTL
const cache = new Map();
const TTL = { wiki: 60 * 60 * 1000, rss: 10 * 60 * 1000 };
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

// 🔹 Fetch full Wikipedia summary (long version)
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
      exintro: false, // ✅ fetch full extract, not just intro
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

    // ✅ Do NOT trim → return full text
    setCache(cacheKey, extract, 'wiki');
    return extract;
  } catch (err) {
    console.error('Wikipedia fetch error:', err.message);
    return 'Error fetching Wikipedia.';
  }
}
// 🔹 Fetch RSS feeds
async function fetchRSS(feedUrl) {
  const cacheKey = `rss:${feedUrl}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const feed = await parser.parseURL(feedUrl);
    const headlines = feed.items
      .slice(0, 5)
      .map((item) => `- ${item.title} (${item.link})`)
      .join('\n');
    setCache(cacheKey, headlines, 'rss');
    return headlines;
  } catch (err) {
    console.error(`RSS fetch error [${feedUrl}]:`, err.message);
    return `Error fetching RSS from ${feedUrl}`;
  }
}

// 🔹 Preload RSS feeds
async function preloadFeeds() {
  console.log('⏳ Preloading RSS feeds...');
  await Promise.all(feedUrls.map((url) => fetchRSS(url)));
  console.log('✅ Preloading done');
}
preloadFeeds();
setInterval(preloadFeeds, 10 * 60 * 1000);

// 🔹 Modified /generate endpoint to return Wikipedia and RSS data
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // Fetch Wikipedia and RSS data
    const wikiText = await fetchWikipedia(prompt);
    const rssResults = await Promise.all(feedUrls.map((url) => fetchRSS(url)));
    const rssText = feedUrls
      .map((url, i) => `Feed: ${url}\n${rssResults[i]}`)
      .join('\n\n');

    // Return JSON with Wikipedia and RSS data
    res.json({
      wikipedia: wikiText,
      rss: rssText,
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
  res.send('✅ Unified AI Proxy running. Use /generate or /api/wikipedia');
});

// 🔹 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Unified AI Proxy listening on http://localhost:${PORT}`),
);
