// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 5000; // You can change this port if needed

app.use(cors()); // Enable CORS for all routes

// Wikipedia API base URL
const WIKIPEDIA_API_BASE_URL = 'https://en.wikipedia.org/w/api.php';

app.get('/api/wikipedia', async (req, res) => {
  try {
    // Get all query parameters from the incoming request
    const params = req.query;

    // Add a User-Agent header for Wikipedia API requests
    const headers = {
      'User-Agent':
        'FanBoxAppProxy/1.0 (https://example.com/fanbox; your_email@example.com)',
    };

    // Make the request to the Wikipedia API
    const response = await axios.get(WIKIPEDIA_API_BASE_URL, {
      params: params,
      headers: headers,
      timeout: 15000, // 15 seconds timeout
    });

    // Return the Wikipedia API's response directly
    res.json(response.data);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        return res
          .status(504)
          .json({ error: 'Request to Wikipedia API timed out.' });
      }
      // Forward Wikipedia API's status code and message if available
      if (error.response) {
        return res.status(error.response.status).json({
          error: `Error fetching from Wikipedia API: ${error.response.statusText}`,
          details: error.response.data,
        });
      }
    }
    // Handle other unexpected errors
    console.error('An unexpected error occurred:', error);
    res
      .status(500)
      .json({ error: `An unexpected error occurred: ${error.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Node.js Express proxy server listening on port ${PORT}`);
  console.log(`Access it at http://localhost:${PORT}/api/wikipedia`);
});
