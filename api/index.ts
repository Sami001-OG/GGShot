import express from "express";
import path from "path";
import dns from "dns";
import dotenv from "dotenv";

// Provide backend fallback exports matching what indicators.ts does
const MAJOR_FUTURES = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'PEPE', 'WIF', 'SUI',
  'APT', 'ARB', 'OP', 'TIA', 'NOT', 'LTC', 'LINK', 'DOT', 'NEAR', 'AVAX'
];

function sma(data: number[], period: number): (number | null)[] {
  if (data.length < period) return Array(data.length).fill(null);
  const result: (number | null)[] = Array(period - 1).fill(null);
  let s = 0;
  for (let i = 0; i < period; i++) s += data[i];
  result.push(s / period);
  for (let i = period; i < data.length; i++) {
    s += data[i] - data[i - period];
    result.push(s / period);
  }
  return result;
}

function stdev(data: number[], period: number): (number | null)[] {
  if (data.length < period) return Array(data.length).fill(null);
  const result: (number | null)[] = Array(period - 1).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    result.push(Math.sqrt(variance));
  }
  return result;
}

function tr(high: number[], low: number[], close: number[]): number[] {
  const trArr: number[] = [high[0] - low[0]];
  for (let i = 1; i < high.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    trArr.push(Math.max(hl, hc, lc));
  }
  return trArr;
}

function calculateADX(candles: any[], period = 14) {
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const close = candles.map(c => c.close);
  const trArr = tr(high, low, close);
  
  let plusDM = [0], minusDM = [0];
  for (let i = 1; i < candles.length; i++) {
    const upMove = high[i] - high[i-1];
    const downMove = low[i-1] - low[i];
    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
      minusDM.push(0);
    } else if (downMove > upMove && downMove > 0) {
      plusDM.push(0);
      minusDM.push(downMove);
    } else {
      plusDM.push(0);
      minusDM.push(0);
    }
  }

  const smooth = (data: number[], period: number) => {
    const res = [data[0]];
    for (let i = 1; i < data.length; i++) res.push(res[i-1] - (res[i-1]/period) + data[i]);
    return res;
  };

  const trSmoothed = smooth(trArr, period);
  const plusDMSmoothed = smooth(plusDM, period);
  const minusDMSmoothed = smooth(minusDM, period);

  const plusDI = [], minusDI = [], dx = [];
  for (let i = 0; i < candles.length; i++) {
    if (trSmoothed[i] === 0) {
      plusDI.push(0); minusDI.push(0); dx.push(0);
    } else {
      const pDI = 100 * (plusDMSmoothed[i] / trSmoothed[i]);
      const mDI = 100 * (minusDMSmoothed[i] / trSmoothed[i]);
      plusDI.push(pDI);
      minusDI.push(mDI);
      dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
    }
  }

  const adx = sma(dx, period).map(v => v === null ? 0 : v) as number[];
  return { adx, plusDI, minusDI };
}

function calculateGGShotServer(candles: any[], bbPeriod: number, bbDev: number) {
  const close = candles.map(c => c.close);
  const mid = sma(close, bbPeriod);
  const std = stdev(close, bbPeriod);
  
  const upper = mid.map((m, i) => m !== null && std[i] !== null ? m + bbDev * std[i]! : null);
  const lower = mid.map((m, i) => m !== null && std[i] !== null ? m - bbDev * std[i]! : null);

  const bbSignals = [];
  const trendLine = [];
  const iTrend = [];
  const signals = [];

  let currentTrend = 1;
  let lastTrendLine = close[0] || 0;

  for (let i = 0; i < candles.length; i++) {
    const c = close[i];
    const u = upper[i];
    const l = lower[i];
    let bbSignal = 0;

    if (u !== null && l !== null && c) {
      if (c > u) bbSignal = 1;
      else if (c < l) bbSignal = -1;
    }
    bbSignals.push(bbSignal);

    if (i === 0) {
      trendLine.push(lastTrendLine);
      iTrend.push(currentTrend);
      signals.push(null);
      continue;
    }

    if (currentTrend === 1) {
      lastTrendLine = Math.max(lastTrendLine, l !== null ? l : lastTrendLine);
      if (c < lastTrendLine) currentTrend = -1;
    } else {
      lastTrendLine = Math.min(lastTrendLine, u !== null ? u : lastTrendLine);
      if (c > lastTrendLine) currentTrend = 1;
    }

    trendLine.push(lastTrendLine);
    iTrend.push(currentTrend);

    let signal: 'LONG'|'SHORT'|null = null;
    if (iTrend[i] === 1 && iTrend[i - 1] === -1) signal = 'LONG';
    else if (iTrend[i] === -1 && iTrend[i - 1] === 1) signal = 'SHORT';
    signals.push(signal);
  }

  const { adx } = calculateADX(candles);

  return { mid, upper, lower, bbSignals, trendLine, iTrend, signals, adx };
}

async function sendTelegramMessage(message: string, imageType?: "LONG"|"SHORT") {
  const activeToken = process.env.TELEGRAM_BOT_TOKEN;
  const activeChatId = process.env.TELEGRAM_CHAT_ID;
  if (!activeToken || !activeChatId) return false;

  let telegramUrl = `https://api.telegram.org/bot${activeToken}/sendMessage`;
  let fetchOptions: any = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: activeChatId, text: message, parse_mode: "HTML", disable_web_page_preview: true })
  };

  if (imageType) {
    const fs = typeof require !== 'undefined' ? require('fs') : await import('fs');
    const imagePath = path.join(process.cwd(), "src/assets/images", imageType === "LONG" ? "long.jpg" : "short.jpg");
    
    if (fs.existsSync(imagePath)) {
      telegramUrl = `https://api.telegram.org/bot${activeToken}/sendPhoto`;
      const form = new FormData();
      form.append("chat_id", activeChatId);
      form.append("caption", message);
      form.append("parse_mode", "HTML");
      const buffer = fs.readFileSync(imagePath);
      form.append("photo", new Blob([buffer], { type: "image/jpeg" }), `${imageType.toLowerCase()}.jpg`);
      fetchOptions = { method: "POST", body: form };
    }
  }

  try {
    const response = await fetch(telegramUrl, fetchOptions);
    return response.ok;
  } catch (e) {
    return false;
  }
}

dotenv.config();

// Ensure Node standardizes to IPv4 first to avoid localhost lookup latency
dns.setDefaultResultOrder("ipv4first");

const app = express();
app.use(express.json());

// --- AUTONOMOUS BACKEND CRON SCANNER ---
app.get("/api/cron", async (req, res) => {
  try {
    let triggeredSignals = 0;
    
    // We only process the top 5 to avoid API limits on free tiers, or run concurrently
    // Using MAJOR_FUTURES slice, processing all in parallel
    const processPromises = MAJOR_FUTURES.slice(0, 15).map(async (coin) => {
      try {
        const symbol = `${coin}USDT`;
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=100`, {
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return;

        const rawCandles = await r.json() as any[];
        const candles = rawCandles.map(c => ({
          time: parseInt(c[0]),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        }));

        if (candles.length < 50) return;

        // Run technical analysis
        // Using config equivalents: Period=20, Dev=2.0
        const resList = calculateGGShotServer(candles, 20, 2.0);
        
        // The last closed candle is index length - 2 (since length - 1 is currently forming)
        // However, if the time is exactly at the hour mark, the length-1 might be newly opened
        // Using length - 2 is standard for the most recently completed timeframe.
        const targetIdx = candles.length - 2;
        const signal = resList.signals[targetIdx];
        const adxVal = resList.adx[targetIdx] ?? 0;

        if (signal) {
          // Strong filter rejection: ADX must be > 25 for strong trend
          if (adxVal > 25) {
            triggeredSignals++;
            const closePrice = candles[targetIdx].close;
            const msg = `⚡ <b>SYSTEM SCANNER (Autonomous Vercel Engine)</b>\n\n🎯 <b>${coin}USDT</b> | <b>${signal} TRIGGERED</b>\n\n💰 Entry Price: ${closePrice}\n📊 ADX: ${adxVal.toFixed(1)}${adxVal > 25 ? ' (STRONG TREND)' : ''}\n\n<i>This signal was processed securely via backend cron task without frontend dependency.</i>`;
            await sendTelegramMessage(msg, signal);
          }
        }
      } catch(e) {}
    });

    await Promise.all(processPromises);

    res.json({ success: true, message: `Cron cycle complete. Generated ${triggeredSignals} valid signals.` });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
