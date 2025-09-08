const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS
app.use(cors());

// Wikipedia API base URL
const WIKIPEDIA_API_BASE_URL = 'https://en.wikipedia.org/w/api.php';

// Initialize cache (TTL: 10 minutes, Check every 15 minutes)
const cache = new NodeCache({ stdTTL: 600, checkperiod: 900 });

// Reuse connections with keep-alive
const agent = new https.Agent({ keepAlive: true });

app.get('/api/wikipedia', async (req, res) => {
  try {
    // Get all query parameters from the incoming request
    const params = req.query;

    // Generate a unique cache key based on the query string
    const cacheKey = JSON.stringify(params);

    // Check cache first
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      console.log(`✅ Cache hit for: ${cacheKey}`);
      return res.json(cachedData);
    }

    console.log(`⏳ Cache miss, fetching from Wikipedia: ${cacheKey}`);

    // Add a User-Agent header for Wikipedia API requests
    const headers = {
      'User-Agent':
        'FanBoxAppProxy/1.0 (https://example.com/fanbox; your_email@example.com)',
    };

    // Make the request to the Wikipedia API with keep-alive
    const response = await axios.get(WIKIPEDIA_API_BASE_URL, {
      params,
      headers,
      httpsAgent: agent, // ✅ keeps the connection alive
      timeout: 15000, // 15 seconds timeout
    });

    // Store in cache before sending to client
    cache.set(cacheKey, response.data);

    // Return the Wikipedia API's response directly
    res.json(response.data);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        return res
          .status(504)
          .json({ error: 'Request to Wikipedia API timed out.' });
      }
      if (error.response) {
        return res.status(error.response.status).json({
          error: `Error fetching from Wikipedia API: ${error.response.statusText}`,
          details: error.response.data,
        });
      }
    }
    console.error('An unexpected error occurred:', error);
    res
      .status(500)
      .json({ error: `An unexpected error occurred: ${error.message}` });
  }
});

// Root route for sanity check
app.get('/', (req, res) => {
  res.send(
    '✅ Wikipedia Proxy is running. Use /api/wikipedia with query params.',
  );
});

app.listen(PORT, () => {
  console.log(`Node.js Express proxy server listening on port ${PORT}`);
  console.log(`Access it at http://localhost:${PORT}/api/wikipedia`);
});
