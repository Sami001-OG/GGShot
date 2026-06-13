import express from "express";
import path from "path";
import dns from "dns";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import mongoose from "mongoose";

dotenv.config();

// MongoDB setup
let mongoUri = process.env.MONGODB_URI;
// Correct encoding of the @ in the URI password if requested by the user previously
if (mongoUri && mongoUri.includes("123sami@gg-shot")) {
  mongoUri = "mongodb+srv://Sami:sami%40123sami@gg-shot.ybpg66p.mongodb.net/?appName=GG-Shot";
}

let db: any = null;

const TradeSchema = new mongoose.Schema({
  tradeId: { type: String, required: true, unique: true },
  symbol: String,
  direction: String,
  entryPrice: Number,
  exitPrice: Number,
  pnlPercent: Number,
  status: String,
  timestamp: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: "daily_trades" });

const TradeModel = mongoose.model("Trade", TradeSchema);

const DailyCounterSchema = new mongoose.Schema({
  dateKey: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 }
}, { collection: "daily_counters" });

const DailyCounterModel = mongoose.model("DailyCounter", DailyCounterSchema);

if (mongoUri) {
  // Original DB setup
  const client = new MongoClient(mongoUri);
  client.connect().then(() => {
    db = client.db("GG-Shot");
    console.log("Connected to MongoDB successfully via standard driver.");
  }).catch((err) => {
    console.error("MongoDB connection failed:", err);
  });

  // Mongoose setup
  mongoose.connect(mongoUri, { dbName: "GG-Shot" }).then(() => {
    console.log("Connected to Mongoose successfully for Trades tracking.");
  }).catch(err => {
    console.error("Mongoose connection failed:", err);
  });
}

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

function ema(data: number[], period: number): (number | null)[] {
  if (data.length < period) return Array(data.length).fill(null);
  const result: (number | null)[] = Array(period - 1).fill(null);
  const k = 2 / (period + 1);
  let smaSum = 0;
  for (let i = 0; i < period; i++) {
    smaSum += data[i];
  }
  let prevEma = smaSum / period;
  result.push(prevEma);
  
  for (let i = period; i < data.length; i++) {
    prevEma = (data[i] - prevEma) * k + prevEma;
    result.push(prevEma);
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
  const ema200_4h = ema(close, 800);

  return { mid, upper, lower, bbSignals, trendLine, iTrend, signals, adx, ema200_4h };
}

const telegramQueue: { message: string, imageType?: "LONG"|"SHORT", resolve: Function, reject: Function }[] = [];
let isProcessingTelegramQueue = false;

async function processTelegramQueue() {
  if (isProcessingTelegramQueue) return;
  isProcessingTelegramQueue = true;
  
  while (telegramQueue.length > 0) {
    const item = telegramQueue[0];
    try {
      const activeToken = process.env.TELEGRAM_BOT_TOKEN;
      const activeChatId = process.env.TELEGRAM_CHAT_ID;
      if (!activeToken || !activeChatId) {
        throw new Error("Telegram credentials are not configured on the server.");
      }

      let telegramUrl = `https://api.telegram.org/bot${activeToken}/sendMessage`;
      let fetchOptions: any = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: activeChatId, text: item.message, parse_mode: "HTML", disable_web_page_preview: true })
      };

      if (item.imageType === "LONG" || item.imageType === "SHORT") {
        const fs = typeof require !== 'undefined' ? require('fs') : await import('fs');
        const imagePath = path.join(process.cwd(), "src/assets/images", item.imageType === "LONG" ? "long.jpg" : "short.jpg");
        
        if (fs.existsSync(imagePath)) {
          telegramUrl = `https://api.telegram.org/bot${activeToken}/sendPhoto`;
          const form = new FormData();
          form.append("chat_id", activeChatId);
          form.append("caption", item.message);
          form.append("parse_mode", "HTML");
          const buffer = fs.readFileSync(imagePath);
          form.append("photo", new Blob([buffer], { type: "image/jpeg" }), `${item.imageType.toLowerCase()}.jpg`);
          fetchOptions = { method: "POST", body: form };
        }
      }

      const response = await fetch(telegramUrl, fetchOptions);
      const telegramData = await response.json() as any;

      if (!response.ok || !telegramData.ok) {
        if (telegramData.error_code === 429 && telegramData.parameters?.retry_after) {
          const retryAfter = telegramData.parameters.retry_after;
          console.warn(`[TELEGRAM RATE LIMIT] 429 Too Many Requests. Waiting ${retryAfter}s before retry...`);
          await new Promise(r => setTimeout(r, retryAfter * 1000 + 500));
          continue; // Retry this item
        } else {
          console.error("Telegram API Error:", telegramData);
          throw new Error(telegramData.description || `Telegram response status ${response.status}`);
        }
      }
      
      item.resolve(telegramData);
    } catch (e: any) {
      item.reject(e);
    }

    telegramQueue.shift(); // Remove completed/failed
    await new Promise(r => setTimeout(r, 2000)); // Enforce global rate limiting (1.5 - 2s)
  }
  
  isProcessingTelegramQueue = false;
}

function sendTelegramMessage(message: string, imageType?: "LONG"|"SHORT"): Promise<any> {
  return new Promise((resolve, reject) => {
    telegramQueue.push({ message, imageType, resolve, reject });
    processTelegramQueue();
  });
}

dotenv.config();

// Ensure Node standardizes to IPv4 first to avoid localhost lookup latency
dns.setDefaultResultOrder("ipv4first");

const app = express();
app.use(express.json());

// --- MONGODB STATE APIS ---
app.post("/api/trades/record", async (req, res) => {
  if (mongoose.connection.readyState !== 1) return res.status(500).json({ error: "DB not ready" });
  try {
    const { localId, symbol, direction, entryPrice, exitPrice, pnlPercent, status } = req.body;
    
    const now = new Date();
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dateKey = `${dd}${mm}`;

    // If it's a new trade (OPEN status), we generate a trade ID using the counter
    let tradeRecord = undefined;
    if (status === "OPEN" && localId) {
       // Only increment the counter and create new if it doesn't already exist with this localId as a fallback logic
       // Actually, to keep it simple, we generate a formal DB ID and return it
       const counter = await DailyCounterModel.findOneAndUpdate(
         { dateKey },
         { $inc: { count: 1 } },
         { new: true, upsert: true }
       );
       const paddedSeq = String(counter.count).padStart(2, '0');
       const tradeId = `${dateKey}${paddedSeq}`;

       tradeRecord = new TradeModel({
         tradeId,
         symbol,
         direction,
         entryPrice,
         status,
         pnlPercent: 0
       });
       await tradeRecord.save();
       return res.json({ success: true, tradeId });
    } else {
       // Update an existing trade (for TP/SL closed trades)
       // Expects the client to pass the assigned `dbId` in `req.body.dbId`
       const dbId = req.body.dbId;
       if (!dbId) return res.status(400).json({ error: "Missing dbId for update" });
       
       tradeRecord = await TradeModel.findOneAndUpdate(
         { tradeId: dbId },
         { 
           status, 
           exitPrice, 
           pnlPercent, 
           updatedAt: new Date() 
         },
         { new: true }
       );
       return res.json({ success: true, trade: tradeRecord });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to manually trigger the daily 24h cron
app.post("/api/trades/daily-report", async (req, res) => {
  try {
    const success = await processDailyReport();
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function processDailyReport() {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    const trades = await TradeModel.find({});
    if (trades.length === 0) {
      await sendTelegramMessage("📊 <b>Daily Report:</b>\nNo trades were recorded in the last 24h.");
      return true;
    }

    const won = trades.filter(t => t.pnlPercent > 0).length;
    const lost = trades.filter(t => t.pnlPercent < 0).length;
    const breakevenOrOpen = trades.length - won - lost;
    
    let totalPnl = 0;
    trades.forEach(t => totalPnl += (t.pnlPercent || 0));

    const msg = `📊 <b>Daily 24h Trade Report</b> 📊\n\n` +
      `Total Signals/Trades: ${trades.length}\n` +
      `✅ Win: ${won}\n` +
      `❌ Loss: ${lost}\n` +
      `⚪ Open/Breakeven: ${breakevenOrOpen}\n` +
      `💰 Total Net PnL: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)}%\n\n` +
      `<i>Database has been wiped for the next 24h cycle.</i>`;
      
    await sendTelegramMessage(msg);

    // After 24h, a report from db will go through telegram and the db will be blank
    await TradeModel.deleteMany({});
    
    return true;
  } catch (error) {
    console.error("Daily report failed", error);
    return false;
  }
}

// 24H cron interval
setInterval(() => {
  processDailyReport();
}, 24 * 60 * 60 * 1000);

app.get("/api/db/state", async (req, res) => {
  if (!db) return res.json({ error: "Database not connected" });
  try {
    const stateRecord = await db.collection("system_state").findOne({ id: "main" });
    if (stateRecord) {
      res.json(stateRecord);
    } else {
      res.json({ activeTrades: [], closedTrades: [], stats: { balance: 10000, won: 0, lost: 0, totalPnl: 0 }, logs: [] });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch state from DB" });
  }
});

app.post("/api/db/state", async (req, res) => {
  if (!db) return res.json({ error: "Database not connected" });
  try {
    const { activeTrades, closedTrades, stats, logs } = req.body;
    await db.collection("system_state").updateOne(
      { id: "main" },
      { $set: { activeTrades, closedTrades, stats, logs, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to save state to DB" });
  }
});

// Removed test-mongoose


// --- AUTONOMOUS BACKEND CRON SCANNER TASK ---
async function runMarketScan() {
  console.log("[CRON] Starting background market scan...");
  try {
    let triggeredSignals = 0;
    
    // We only process the top 15 to avoid API limits on free tiers, or run concurrently
    // Using MAJOR_FUTURES slice, processing all in parallel
    const processPromises = MAJOR_FUTURES.slice(0, 15).map(async (coin) => {
      try {
        const symbol = `${coin}USDT`;
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1000`, {
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
        const ema200val = resList.ema200_4h[targetIdx] ?? candles[targetIdx].close;

        if (signal) {
          // Strong filter rejection: ADX must be > 25 for strong trend
          if (adxVal > 25) {
            const closePrice = candles[targetIdx].close;
            // 4H EMA 200 filter check
            if ((signal === 'LONG' && closePrice > ema200val) || (signal === 'SHORT' && closePrice < ema200val)) {
              triggeredSignals++;
              const msg = `⚡ <b>SYSTEM SCANNER (Autonomous Engine)</b>\n\n🎯 <b>${coin}USDT</b> | <b>${signal} TRIGGERED</b>\n\n💰 Entry Price: ${closePrice}\n📊 ADX: ${adxVal.toFixed(1)}${adxVal > 25 ? ' (STRONG TREND)' : ''}\n📈 4H EMA 200 Trend Check: PASS\n\n<i>This signal was processed securely via background task without frontend.</i>`;
              await sendTelegramMessage(msg, signal);
            }
          }
        }
      } catch(e) {}
    });

    await Promise.all(processPromises);
    console.log(`[CRON] Background market scan complete. Triggered ${triggeredSignals} valid signals.`);
    return triggeredSignals;
  } catch(e) {
    console.error("[CRON] Background scan failed:", e);
    return 0;
  }
}

// Start the autonomous looping engine running every 15 minutes (900000 ms)
const AUTONOMOUS_SCAN_INTERVAL = 15 * 60 * 1000;
setInterval(() => {
  runMarketScan();
}, AUTONOMOUS_SCAN_INTERVAL);
// Initial scan on startup
setTimeout(() => {
  runMarketScan();
}, 10000); // 10 seconds after boot!

// Keep the external route available just in case they want a manual external trigger (Cron-job.org)
app.get("/api/cron", async (req, res) => {
  try {
    const triggered = await runMarketScan();
    res.json({ success: true, message: `Cron cycle complete. Generated ${triggered} valid signals.` });
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
    res.json({
      success: false,
      message: error.message || "Failed to contact Binance Futures API"
    });
  }
});

// 3. API: Fetch 1h klines for a specific coin and calculate state
app.get("/api/binance/metrics/:coin", async (req, res) => {
  try {
    const coin = (req.params.coin || "BTC").toUpperCase();
    const symbol = `${coin}USDT`;
    const baseUrl = "https://fapi.binance.com";

    const r = await fetch(`${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1000`, {
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
    await sendTelegramMessage(message, imageType);
    res.json({
      success: true,
      message: "Telegram notification queued successfully!"
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to queue Telegram notification."
    });
  }
});

export default app;
