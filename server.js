import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fetch from 'node-fetch';
import Parser from 'rss-parser';
import fs from 'fs';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';

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

// 🔹 Fetch Wikipedia summary
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
    const trimmed = extract.split('\n').slice(0, 5).join('\n');
    setCache(cacheKey, trimmed, 'wiki');
    return trimmed;
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

// 🔹 Unified /generate endpoint with Gemini streaming & multiple API keys
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // Wikipedia + RSS background
    const wikiText = await fetchWikipedia(prompt);
    const rssResults = await Promise.all(feedUrls.map((url) => fetchRSS(url)));
    const rssText = feedUrls
      .map((url, i) => `Feed: ${url}\n${rssResults[i]}`)
      .join('\n\n');

    const finalPrompt = `
You are a news & trivia assistant. The user asked: "${prompt}"

🔹 Wikipedia background:
${wikiText}

🔹 Latest headlines from RSS feeds:
${rssText}

⚠️ Important: Use the info above. Summarize naturally. Include Wikipedia context.
`;

    console.log('Prompt sent to Gemini:\n', finalPrompt);

    // 🔹 Multiple API keys (from .env)
    const geminiKeys = [
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
    ].filter(Boolean);

    if (geminiKeys.length === 0)
      return res.status(500).json({ error: 'No Gemini API keys provided' });

    const models = ['gemini-2.0-flash', 'gemini-1.5-flash']; // fallback order
    let success = false;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    // Loop through keys and models
    outer: for (const key of geminiKeys) {
      for (const model of models) {
        try {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: finalPrompt }] }],
              generationConfig: {
                responseMimeType: 'text/plain',
                temperature: 0.3,
                maxOutputTokens: 500,
              },
            }),
          });

          if (!response.ok)
            throw new Error(
              `Gemini ${model} failed with status ${response.status}`,
            );

          // Streaming reader
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value).toString());
          }

          success = true;
          break outer; // exit both loops if successful
        } catch (err) {
          console.warn(`❌ Model ${model} with key failed:`, err.message);
        }
      }
    }

    if (!success) res.write('Error: All Gemini models and API keys failed.');
    res.end();
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
