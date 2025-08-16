import "dotenv/config";
import express from "express";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

// Middleware
app.use(express.json());

// Authorization middleware
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: "Authorization header required" });
  }
  
  const token = authHeader.startsWith("Bearer ") 
    ? authHeader.slice(7) 
    : authHeader;
  
  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    return res.status(403).json({ error: "Invalid authorization token" });
  }
  
  next();
};

/**
 * Scrapes tracking results from ParcelsApp
 * @param {string} trackingNumber - The tracking number to query
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} - The API response JSON
 */
async function scrapeResults(trackingNumber, options = {}) {
  if (!trackingNumber || typeof trackingNumber !== "string") {
    throw new Error("trackingNumber must be a non-empty string");
  }

  const { timeoutMs = 30_000, headless = "new" } = options;
  const apiUrlPrefix = "https://parcelsapp.com/api/v2/parcels";
  const url = `https://parcelsapp.com/en/tracking/${encodeURIComponent(
    trackingNumber
  )}`;

  const browser = await puppeteer.launch({
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Reasonable desktop UA
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 900 });

  let onResponse;
  const apiResponsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        if (onResponse) page.off("response", onResponse);
      } catch {}
      reject(new Error("Timed out waiting for Parcels API response"));
    }, timeoutMs);

    onResponse = async (response) => {
      try {
        const responseUrl = response.url();
        if (!responseUrl.startsWith(apiUrlPrefix)) return;

        // Capture first matching response
        const json = await response
          .json()
          .catch(() => ({ error: "Failed to parse JSON" }));

        clearTimeout(timer);
        page.off("response", onResponse);
        resolve(json);
      } catch (err) {
        clearTimeout(timer);
        page.off("response", onResponse);
        reject(err);
      }
    };

    page.on("response", onResponse);
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const json = await apiResponsePromise;
    return json;
  } finally {
    try {
      if (onResponse) page.off("response", onResponse);
    } catch {}
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// API Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/scrape", requireAuth, async (req, res) => {
  try {
    const { trackingNumber, options = {} } = req.body;
    
    if (!trackingNumber) {
      return res.status(400).json({ 
        error: "trackingNumber is required in request body" 
      });
    }

    console.log(`[API] Scraping tracking number: ${trackingNumber}`);
    const result = await scrapeResults(trackingNumber, options);
    
    res.json({
      success: true,
      trackingNumber,
      data: result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`[API] Error scraping ${req.body.trackingNumber}:`, error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
      timestamp: new Date().toISOString()
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoint: POST http://localhost:${PORT}/api/scrape`);
  if (!AUTH_TOKEN) {
    console.warn("Warning: AUTH_TOKEN not set. Authorization will accept any token.");
  }
});
