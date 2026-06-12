import express from "express";
import path from "path";
import dns from "dns";
import dotenv from "dotenv";

dotenv.config();

// Ensure Node standardizes to IPv4 first to avoid localhost lookup latency
dns.setDefaultResultOrder("ipv4first");

const app = express();
app.use(express.json());

// 1. API: Custom Binance Environment Variables Integration Status
app.get("/api/binance/status", (req, res) => {
  const keyPreset = !!process.env.BINANCE_API_KEY;
  const secretPreset = !!process.env.BINANCE_API_SECRET;
  
  res.json({
    configured: keyPreset && secretPreset,
    keyMask: keyPreset 
      ? `${process.env.BINANCE_API_KEY?.substring(0, 6)}...${process.env.BINANCE_API_KEY?.slice(-4)}` 
      : "Not Set",
    secretMask: secretPreset ? "********" : "Not Set",
    binanceUrl: "https://fapi.binance.com",
    serverTime: new Date().toISOString()
  });
});

// 2. API: Fetch Live Binance Futures perpetual prices
app.get("/api/binance/prices", async (req, res) => {
  try {
    const baseUrl = "https://fapi.binance.com";
    const response = await fetch(`${baseUrl}/fapi/v1/ticker/price`, {
      signal: AbortSignal.timeout(6000)
    });
    
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.statusText}`);
    }

    const rawPrices = await response.json() as Array<{ symbol: string; price: string }>;
    
    // Filter for some USDT pairs
    const usdtPrices: Record<string, number> = {};
    rawPrices.forEach(item => {
      if (item.symbol.endsWith("USDT")) {
        const coin = item.symbol.replace("USDT", "");
        usdtPrices[coin] = parseFloat(item.price);
      }
    });

    res.json({
      success: true,
      source: "Binance Futures API",
      prices: usdtPrices
    });
  } catch (error: any) {
    // Graceful fallback for networks with blocked access/CORS
    res.json({
      success: false,
      source: "Simulation Model (Binance API offline or restricted)",
      message: error.message || "Failed to contact Binance Futures API",
      prices: {
        BTC: 69250.40,
        ETH: 3740.15,
        SOL: 165.80,
        APE: 1.325,
        SUI: 1.8250,
        XRP: 0.5840,
        ADA: 0.4450,
        PEPE: 0.000012,
        DOGE: 0.1452,
        WIF: 2.89
      }
    });
  }
});

// 3. API: Fetch 1h klines for a specific coin and calculate state
app.get("/api/binance/metrics/:coin", async (req, res) => {
  try {
    const coin = (req.params.coin || "BTC").toUpperCase();
    const symbol = `${coin}USDT`;
    const baseUrl = "https://fapi.binance.com";

    const r = await fetch(`${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=300`, {
      signal: AbortSignal.timeout(6000)
    });

    if (!r.ok) {
      throw new Error(`Failed to fetch candles: ${r.statusText}`);
    }

    const rawCandles = await r.json() as any[];
    // Parse as open, high, low, close, volume, closeTime, quoteVolume
    const candles = rawCandles.map(c => ({
      time: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
      quoteVolume: parseFloat(c[7])
    }));

    res.json({
      success: true,
      coin,
      candlesCount: candles.length,
      candles: candles // Return all candles for technical analysis calculations
    });
  } catch (error: any) {
    res.json({
      success: false,
      coin: req.params.coin,
      message: error.message || "Could not fetch details"
    });
  }
});

// 4. API: Telegram Configuration Status
app.get("/api/telegram/status", (req, res) => {
  const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const hasChatId = !!process.env.TELEGRAM_CHAT_ID;
  res.json({
    configured: hasToken && hasChatId
  });
});

// 5. API: Securely relay notifications to Telegram API using server-side keys only
app.post("/api/telegram/notify", async (req, res) => {
  try {
    const { message, imageType } = req.body;
    const activeToken = process.env.TELEGRAM_BOT_TOKEN;
    const activeChatId = process.env.TELEGRAM_CHAT_ID;

    if (!activeToken || !activeChatId) {
      return res.status(400).json({
        success: false,
        message: "Telegram credentials are not configured on the server. Please define TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Environment Variables."
      });
    }

    let telegramUrl = `https://api.telegram.org/bot${activeToken}/sendMessage`;
    let fetchOptions: any = {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: activeChatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    };

    if (imageType === "LONG" || imageType === "SHORT") {
      telegramUrl = `https://api.telegram.org/bot${activeToken}/sendPhoto`;
      const fs = typeof require !== 'undefined' ? require('fs') : await import('fs');
      const imagePath = path.join(process.cwd(), "src/assets/images", imageType === "LONG" ? "long.jpg" : "short.jpg");
      
      if (fs.existsSync(imagePath)) {
        const form = new FormData();
        form.append("chat_id", activeChatId);
        form.append("caption", message);
        form.append("parse_mode", "HTML");
        
        const buffer = fs.readFileSync(imagePath);
        form.append("photo", new Blob([buffer], { type: "image/jpeg" }), `${imageType.toLowerCase()}.jpg`);
        
        fetchOptions = {
          method: "POST",
          body: form
        };
      }
    }

    const response = await fetch(telegramUrl, fetchOptions);
    const telegramData = await response.json() as any;

    if (!response.ok || !telegramData.ok) {
      console.error("Telegram API Error:", telegramData);
      throw new Error(telegramData.description || `Telegram response status ${response.status}`);
    }

    res.json({
      success: true,
      message: "Telegram notification relay succeeded!"
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to trigger Telegram notification."
    });
  }
});

export default app;
