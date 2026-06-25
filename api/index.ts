import express from "express";
import path from "path";
import dns from "dns";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import mongoose from "mongoose";
import WebSocket from "ws";
import { calculateSrade, getCoinFundingRate, getCoinBase24hVolume, aggregateTo4Hour, calculateITrendOnly } from "../src/lib/indicators.js";
import { COIN_CONFIGS, DEFAULT_CONFIG } from "../src/lib/srade_1h_config.js";

dotenv.config();

// MongoDB setup
let mongoUri = process.env.MONGODB_URI;
// Correct encoding of the @ in the URI password if requested by the user previously
if (mongoUri && mongoUri.includes("123sami@gg-shot")) {
  mongoUri = "mongodb+srv://Sami:sami%40123sami@gg-shot.ybpg66p.mongodb.net/?appName=GG-Shot";
}

// Fallback In-Memory DB
let memoryDbState: any = {
  id: "main",
  activeTrades: [],
  closedTrades: [],
  stats: { balance: 10000, won: 0, lost: 0, totalPnl: 0 },
  logs: [],
  filterAdx: true,
  filterMtf: true,
  filterEma: true,
  filterVolume: true,
  filterFunding: true,
  filterLiquidity: true,
};

const memoryDb = {
  collection: (name: string) => {
    return {
      findOne: async (query: any) => {
        if (name === "system_state") {
          return { ...memoryDbState };
        }
        return null;
      },
      updateOne: async (query: any, update: any, options?: any) => {
        if (name === "system_state") {
          if (update.$set) {
            memoryDbState = { ...memoryDbState, ...update.$set };
          }
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      }
    };
  }
};

let db: any = memoryDb; // Default to memoryDb

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

// Simple in-memory fallback counters
const inMemoryCounters = new Map<string, number>();

async function getNextTradeCount(dateKey: string): Promise<number> {
  if (mongoose.connection.readyState === 1) {
    try {
      const counter = await DailyCounterModel.findOneAndUpdate(
        { dateKey },
        { $inc: { count: 1 } },
        { new: true, upsert: true }
      );
      if (counter && typeof counter.count === 'number') {
        return counter.count;
      }
    } catch (err) {
      console.warn("[DB] Counter update failed, using in-memory:", err);
    }
  }
  const current = inMemoryCounters.get(dateKey) || 0;
  const next = current + 1;
  inMemoryCounters.set(dateKey, next);
  return next;
}

async function healExistingTradesInDatabase() {
  try {
    console.log("[DATABASE HEALER] Initiating healing of existing trade records to fix calculation formula...");
    
    let targetDb = db;
    if ((!targetDb || targetDb === memoryDb) && mongoUri) {
      console.log("[DATABASE HEALER] DB connection not fully ready. Establishing temporary MongoClient...");
      const tempClient = new MongoClient(mongoUri);
      await tempClient.connect();
      targetDb = tempClient.db("Srade");
      if (db === memoryDb) {
        db = targetDb;
      }
    }

    // 1. Heal individual TradeModel documents
    const trades = await TradeModel.find({});
    console.log(`[DATABASE HEALER] Found ${trades.length} trades to scan in database...`);
    
    for (const doc of trades) {
      const coin = doc.symbol;
      const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
      const direction = doc.direction;
      const entryPrice = doc.entryPrice;
      if (!entryPrice || !direction || !coin) continue;
      
      const p1 = config.tp[0];
      const p2 = config.tp[1];
      const p3 = config.tp[2];
      const p4 = config.tp[3];
      const slPct = config.sl;
      
      let correctSl: number;
      let correctTps: [number, number, number, number];
      
      if (direction === 'LONG') {
        correctSl = entryPrice * (1 - slPct / 100);
        correctTps = [
          entryPrice * (1 + p1 / 100),
          entryPrice * (1 + p2 / 100),
          entryPrice * (1 + p3 / 100),
          entryPrice * (1 + p4 / 100)
        ];
      } else {
        correctSl = entryPrice * (1 + slPct / 100);
        correctTps = [
          entryPrice * (1 - p1 / 100),
          entryPrice * (1 - p2 / 100),
          entryPrice * (1 - p3 / 100),
          entryPrice * (1 - p4 / 100)
        ];
      }
      
      if (doc.status !== "OPEN") {
        const exitPrice = doc.exitPrice || correctTps[3];
        const correctPnlPercent = direction === 'LONG'
          ? ((exitPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - exitPrice) / entryPrice) * 100;
          
        doc.pnlPercent = correctPnlPercent;
      }
      
      await doc.save();
    }
    
    // 2. Heal system_state collection
    if (targetDb && targetDb !== memoryDb) {
      const stateDoc = await targetDb.collection("system_state").findOne({ id: "main" });
      if (stateDoc) {
        let stateChanged = false;
        const activeTrades = stateDoc.activeTrades || [];
        const closedTrades = stateDoc.closedTrades || [];
        
        for (const t of activeTrades) {
          const coin = t.symbol;
          const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
          const direction = t.direction;
          const entryPrice = t.entry;
          if (!entryPrice || !direction || !coin) continue;
          
          const p1 = config.tp[0];
          const p2 = config.tp[1];
          const p3 = config.tp[2];
          const p4 = config.tp[3];
          const slPct = config.sl;
          
          if (direction === 'LONG') {
            t.sl = entryPrice * (1 - slPct / 100);
            t.tps = [
              entryPrice * (1 + p1 / 100),
              entryPrice * (1 + p2 / 100),
              entryPrice * (1 + p3 / 100),
              entryPrice * (1 + p4 / 100)
            ];
          } else {
            t.sl = entryPrice * (1 + slPct / 100);
            t.tps = [
              entryPrice * (1 - p1 / 100),
              entryPrice * (1 - p2 / 100),
              entryPrice * (1 - p3 / 100),
              entryPrice * (1 - p4 / 100)
            ];
          }
          t.tp = t.tps[0];
          stateChanged = true;
        }
        
        for (const t of closedTrades) {
          const coin = t.symbol;
          const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
          const direction = t.direction;
          const entryPrice = t.entry;
          if (!entryPrice || !direction || !coin) continue;
          
          const p1 = config.tp[0];
          const p2 = config.tp[1];
          const p3 = config.tp[2];
          const p4 = config.tp[3];
          const slPct = config.sl;
          
          if (direction === 'LONG') {
            t.sl = entryPrice * (1 - slPct / 100);
            t.tps = [
              entryPrice * (1 + p1 / 100),
              entryPrice * (1 + p2 / 100),
              entryPrice * (1 + p3 / 100),
              entryPrice * (1 + p4 / 100)
            ];
          } else {
            t.sl = entryPrice * (1 + slPct / 100);
            t.tps = [
              entryPrice * (1 - p1 / 100),
              entryPrice * (1 - p2 / 100),
              entryPrice * (1 - p3 / 100),
              entryPrice * (1 - p4 / 100)
            ];
          }
          t.tp = t.tps[0];
          
          const exitPrice = t.exitPrice || t.tps[3];
          const correctPnlPercent = direction === 'LONG'
            ? ((exitPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - exitPrice) / entryPrice) * 100;
            
          t.pnlPercent = correctPnlPercent;
          t.pnl = (t.initialSize || t.size) * (correctPnlPercent / 100);
          stateChanged = true;
        }

        // Recalculate global stats from closedTrades
        let calculatedWon = 0;
        let calculatedLost = 0;
        let calculatedTotalPnl = 0;
        for (const t of closedTrades) {
          const tradePnl = t.pnl || 0;
          calculatedTotalPnl += tradePnl;
          if (tradePnl > 0) {
            calculatedWon++;
            t.status = "WIN";
          } else {
            calculatedLost++;
            t.status = "LOSS";
          }
        }
        const calculatedBalance = 10000 + calculatedTotalPnl;
        const correctStats = {
          balance: calculatedBalance,
          won: calculatedWon,
          lost: calculatedLost,
          totalPnl: calculatedTotalPnl
        };
        
        if (stateChanged) {
          await targetDb.collection("system_state").updateOne(
            { id: "main" },
            { $set: { activeTrades, closedTrades, stats: correctStats } }
          );
          console.log("[DATABASE HEALER] Completed system_state and stats healing successfully!");
        }
      }
    }
  } catch (err: any) {
    console.error("[DATABASE HEALER] Error during healing:", err.message);
  }
}

if (mongoUri) {
  // Original DB setup
  const client = new MongoClient(mongoUri);
  client.connect().then(() => {
    db = client.db("Srade");
    console.log("Connected to MongoDB successfully via standard driver.");
    loadProcessedKeysFromDB().then(() => {
      // Start WebSocket Screener once DB is connected!
      startWebSocketScreener();
    }).catch(() => {
      startWebSocketScreener();
    });
  }).catch((err) => {
    console.error("MongoDB connection failed, using memory DB:", err);
    db = memoryDb;
    startWebSocketScreener();
  });

  // Mongoose setup
  mongoose.connect(mongoUri, { dbName: "Srade" }).then(() => {
    console.log("Connected to Mongoose successfully for Trades tracking.");
    healExistingTradesInDatabase().catch(e => console.error("[DATABASE HEALER ERROR]:", e.message));
  }).catch(err => {
    console.error("Mongoose connection failed:", err);
  });
} else {
  console.warn("No MONGODB_URI environment variable detected. Running with In-Memory State DB fallbacks.");
  db = memoryDb;
  setTimeout(() => {
    startWebSocketScreener();
  }, 100);
}

const MAJOR_FUTURES = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'PEPE', 'WIF', 'SUI',
  'APT', 'ARB', 'OP', 'TIA', 'NOT', 'LTC', 'LINK', 'DOT', 'NEAR', 'AVAX'
];

// Sub-millisecond Live Price cache updated via WebSocket
let globalLivePrices: Record<string, number> = {};

// Keep a set of processed keys to strictly prevent double executions (idempotency)
const processedClosedKlines = new Set<string>();

async function loadProcessedKeysFromDB() {
  try {
    const state = await getSystemState();
    if (state && Array.isArray(state.processedKeys)) {
      state.processedKeys.forEach((k: string) => processedClosedKlines.add(k));
      console.log(`[IDEMPOTENCY] Loaded ${processedClosedKlines.size} processed kline keys from MongoDB.`);
    }
  } catch (err) {
    console.error("[IDEMPOTENCY] Error loading processed keys from DB:", err);
  }
}

async function markKeyProcessed(key: string) {
  processedClosedKlines.add(key);
  try {
    const state = await getSystemState();
    if (state) {
      const keys = Array.isArray(state.processedKeys) ? state.processedKeys : [];
      if (!keys.includes(key)) {
        keys.push(key);
        // Clean up old keys if the array grows too large (keep last 500 keys)
        if (keys.length > 500) {
          keys.shift();
        }
        state.processedKeys = keys;
        await saveSystemState(state);
        console.log(`[IDEMPOTENCY] Persisted processed key "${key}" to MongoDB.`);
      }
    }
  } catch (err) {
    console.error("[IDEMPOTENCY] Error marking key as processed in DB:", err);
  }
}

// In-memory low-latency candle cache and hourly signal tracking
let serverCoinsCandles: Record<string, any[]> = {};
const lastTradeCandleTime = new Map<string, number>();

async function getOrFetchCandles(coin: string): Promise<any[] | null> {
  if (serverCoinsCandles[coin] && serverCoinsCandles[coin].length > 0) {
    return serverCoinsCandles[coin];
  }
  
  try {
    const symbol = `${coin.toUpperCase()}USDT`;
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1000`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data)) return null;
    
    const candles = data.map((c: any) => ({
      time: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
    if (candles.length > 0) {
      serverCoinsCandles[coin] = candles;
      return candles;
    }
  } catch (err) {
    console.error(`[CANDLE CACHE] Error seeding history for ${coin}:`, err);
  }
  return null;
}

async function updateCoinCandleCacheAndCheck(coin: string, k: any) {
  const candles = await getOrFetchCandles(coin);
  if (!candles || candles.length === 0) return;

  const candleStartTime = parseInt(k.t);
  const price = parseFloat(k.c);
  const high = parseFloat(k.h);
  const low = parseFloat(k.l);
  const volume = parseFloat(k.v);

  const lastIndex = candles.length - 1;
  const lastCandle = candles[lastIndex];

  if (candleStartTime > lastCandle.time) {
    candles.push({
      time: candleStartTime,
      open: parseFloat(k.o),
      high,
      low,
      close: price,
      volume
    });
    if (candles.length > 1000) {
      candles.shift();
    }
    console.log(`[CANDLE CACHE] ${coin} New candle initiated: ${new Date(candleStartTime).toISOString()}`);
  } else if (candleStartTime === lastCandle.time) {
    lastCandle.close = price;
    lastCandle.high = Math.max(lastCandle.high, high);
    lastCandle.low = Math.min(lastCandle.low, low);
    lastCandle.volume = volume;
  } else {
    return;
  }

  const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
  const resList = calculateSrade(candles, config.bbPeriod, config.bbDev, coin);

  const targetIdx = candles.length - 1;
  const signal = resList.signals[targetIdx];

  if (!signal) {
    return;
  }

  if (lastTradeCandleTime.get(coin) === candleStartTime) {
    return;
  }

  const entryPrice = price;
  const adxVal = resList.adx[targetIdx] ?? 0;
  const ema200val = resList.ema200_4h[targetIdx] ?? entryPrice;

  console.log(`[LOW-LATENCY RUNTIME] DETECTED ${coin} ${signal} crossover on current 1H candle at $${entryPrice}! Checking Confluence Gates...`);

  const state = await getSystemState();
  if (!state) return;

  const existingIndex = (state.activeTrades || []).findIndex((t: any) => t.symbol === coin);
  let activeTrades = [...(state.activeTrades || [])];
  const closedTrades = [...(state.closedTrades || [])];
  let stats = state.stats || { balance: 10000, won: 0, lost: 0, totalPnl: 0 };
  let logs = state.logs || [];

  if (existingIndex !== -1) {
    const existingTrade = activeTrades[existingIndex];
    if (existingTrade.direction === signal) {
      return;
    } else {
      console.log(`[LOW-LATENCY RUNTIME] ${coin} reversal detected! Exiting existing ${existingTrade.direction} before entering ${signal}`);
      const { closedTrade, updatedStats, loggedMsg } = processTradeUpdateServerLogic(existingTrade, entryPrice, stats, true);
      if (closedTrade) {
        closedTrades.unshift(closedTrade);
        stats = updatedStats;
        if (loggedMsg) {
          logs.unshift(`[${new Date().toLocaleTimeString()}] ${loggedMsg}`);
        }
        try {
          await TradeModel.findOneAndUpdate(
            { tradeId: existingTrade.dbId },
            { 
              status: closedTrade.status, 
              exitPrice: closedTrade.exitPrice, 
              pnlPercent: closedTrade.pnlPercent, 
              updatedAt: new Date() 
            }
          );
        } catch(err) {}
      }
      activeTrades = activeTrades.filter((t: any) => t.id !== existingTrade.id);
    }
  }

  const filters = {
    filterAdx: state.filterAdx !== undefined ? state.filterAdx : true,
    filterMtf: state.filterMtf !== undefined ? state.filterMtf : true,
    filterEma: state.filterEma !== undefined ? state.filterEma : true,
    filterVolume: state.filterVolume !== undefined ? state.filterVolume : true,
    filterFunding: state.filterFunding !== undefined ? state.filterFunding : true,
    filterLiquidity: state.filterLiquidity !== undefined ? state.filterLiquidity : true,
  };

  if (filters.filterAdx && adxVal <= 20) {
    const log = `[CONFLUENCE REJECT] ${coin} ${signal} @ $${entryPrice} blocked: ADX sideways (${adxVal.toFixed(1)} <= 20)`;
    logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
    state.logs = logs.slice(0, 40);
    await saveSystemState(state);
    lastTradeCandleTime.set(coin, candleStartTime);
    return;
  }

  const mtfTrend = resList.mtf4hITrend;
  if (filters.filterMtf) {
    if (signal === 'LONG' && mtfTrend !== 1) {
      const log = `[CONFLUENCE REJECT] ${coin} LONG @ $${entryPrice} blocked: 4H trend is bearish/neutral`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      lastTradeCandleTime.set(coin, candleStartTime);
      return;
    }
    if (signal === 'SHORT' && mtfTrend !== -1) {
      const log = `[CONFLUENCE REJECT] ${coin} SHORT @ $${entryPrice} blocked: 4H trend is bullish/neutral`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      lastTradeCandleTime.set(coin, candleStartTime);
      return;
    }
  }

  if (filters.filterEma) {
    if (signal === 'LONG' && entryPrice <= ema200val) {
      const log = `[CONFLUENCE REJECT] ${coin} LONG @ $${entryPrice} blocked: price below 4H EMA 200 ($${formatPrice(ema200val)})`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      lastTradeCandleTime.set(coin, candleStartTime);
      return;
    }
    if (signal === 'SHORT' && entryPrice >= ema200val) {
      const log = `[CONFLUENCE REJECT] ${coin} SHORT @ $${entryPrice} blocked: price above 4H EMA 200 ($${formatPrice(ema200val)})`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      lastTradeCandleTime.set(coin, candleStartTime);
      return;
    }
  }

  const volumeRatio = resList.volumeRatio;
  if (filters.filterVolume && volumeRatio <= 1.5) {
    const log = `[CONFLUENCE REJECT] ${coin} ${signal} @ $${entryPrice} blocked: Volume participation ${volumeRatio.toFixed(2)}x <= 1.5x`;
    logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
    state.logs = logs.slice(0, 40);
    await saveSystemState(state);
    lastTradeCandleTime.set(coin, candleStartTime);
    return;
  }

  const funding = resList.fundingRate;
  if (filters.filterFunding) {
    const fundingPct = funding * 100;
    if (signal === 'LONG' && funding >= 0.05) {
      const log = `[CONFLUENCE REJECT] ${coin} LONG @ $${entryPrice} blocked: Funding rate too high (${fundingPct.toFixed(4)}%)`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      lastTradeCandleTime.set(coin, candleStartTime);
      return;
    }
    if (signal === 'SHORT' && funding <= -0.05) {
      const log = `[CONFLUENCE REJECT] ${coin} SHORT @ $${entryPrice} blocked: Funding rate too low (${fundingPct.toFixed(4)}%)`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      lastTradeCandleTime.set(coin, candleStartTime);
      return;
    }
  }

  const liquidity = resList.volume24hUsdt;
  if (filters.filterLiquidity && liquidity < 30000000) {
    const log = `[CONFLUENCE REJECT] ${coin} ${signal} @ $${entryPrice} blocked: Liquidity $${(liquidity/1000000).toFixed(1)}M < $30M limit`;
    logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
    state.logs = logs.slice(0, 40);
    await saveSystemState(state);
    lastTradeCandleTime.set(coin, candleStartTime);
    return;
  }

  lastTradeCandleTime.set(coin, candleStartTime);

  let tps: [number, number, number, number];
  let sl: number;

  const p1 = config.tp[0];
  const p2 = config.tp[1];
  const p3 = config.tp[2];
  const p4 = config.tp[3];
  const slPct = config.sl;

  if (signal === 'LONG') {
    sl = entryPrice * (1 - slPct / 100);
    tps = [
      entryPrice * (1 + p1 / 100),
      entryPrice * (1 + p2 / 100),
      entryPrice * (1 + p3 / 100),
      entryPrice * (1 + p4 / 100)
    ];
  } else {
    sl = entryPrice * (1 + slPct / 100);
    tps = [
      entryPrice * (1 - p1 / 100),
      entryPrice * (1 - p2 / 100),
      entryPrice * (1 - p3 / 100),
      entryPrice * (1 - p4 / 100)
    ];
  }

  const baseSize = 10000 * 0.02 * config.risk * 3;
  const now = new Date();
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dateKey = `${dd}${mm}`;

  const count = await getNextTradeCount(dateKey);
  const paddedSeq = String(count).padStart(2, '0');
  const tradeId = `${dateKey}${paddedSeq}`;

  const tradeRecord = new TradeModel({
    tradeId,
    symbol: coin,
    direction: signal,
    entryPrice,
    status: "OPEN",
    pnlPercent: 0
  });
  await tradeRecord.save();

  const newTrade: any = {
    id: Math.random().toString(36).substring(2, 7).toUpperCase(),
    dbId: tradeId,
    symbol: coin,
    direction: signal,
    entry: entryPrice,
    tp: tps[0],
    tps,
    sl,
    currentPrice: entryPrice,
    size: baseSize,
    risk: config.risk,
    realizedTps: [false, false, false, false],
    initialSize: baseSize,
    partialPnlRealized: 0
  };

  activeTrades.push(newTrade);

  const successMsg = `>>> WEBSOCKET TRIGGER: ${coin} ${signal} @ $${formatPrice(entryPrice)} generated! Trade ${tradeId} recorded.`;
  logs.unshift(`[${new Date().toLocaleTimeString()}] ${successMsg}`);

  state.activeTrades = activeTrades;
  state.closedTrades = closedTrades.slice(0, 40);
  state.stats = stats;
  state.logs = logs.slice(0, 40);

  await saveSystemState(state);

  console.log(`[LOW-LATENCY RUNTIME] Successfully executed and stored trade: ${tradeId}`);

  sendTelegramMessage(
    `Symbol: ${coin}\n` +
    `Direction: ${signal}\n` +
    `TP Levels: ${formatPrice(tps[0])}, ${formatPrice(tps[1])}, ${formatPrice(tps[2])}, ${formatPrice(tps[3])}\n` +
    `SL Level: ${formatPrice(sl)}`,
    signal
  ).catch(() => {});
}

// DB State helpers
async function getSystemState() {
  if (!db) return null;
  try {
    return await db.collection("system_state").findOne({ id: "main" });
  } catch (e) {
    console.error("[RECONCILER] Error reading system state from DB:", e);
    return null;
  }
}

async function saveSystemState(state: any) {
  if (!db) return false;
  try {
    await db.collection("system_state").updateOne(
      { id: "main" },
      { $set: state },
      { upsert: true }
    );
    return true;
  } catch (e) {
    console.error("[RECONCILER] Error writing system state to DB:", e);
    return false;
  }
}

function formatPrice(val: number): string {
  if (val === undefined || isNaN(val)) return "0.00";
  if (val < 0.00001) return val.toFixed(8);
  if (val < 0.001) return val.toFixed(6);
  if (val < 0.1) return val.toFixed(4);
  if (val < 1) return val.toFixed(3);
  if (val < 10) return val.toFixed(2);
  return val.toFixed(2);
}

// Replicate identical exit logic as React Client Front-End ProcessTradeUpdate including support for custom scale out variables
function processTradeUpdateServerLogic(
  trade: any, 
  currentPrice: number, 
  currentStats: any,
  reversalTriggered?: boolean
): { nextActive: any | null; closedTrade: any | null; updatedStats: any; loggedMsg: string | null } {
  const isLong = trade.direction === 'LONG';
  const entry = trade.entry;
  const initialSize = trade.initialSize ?? trade.size;
  let currentSize = trade.size;
  let realizedTps = [...(trade.realizedTps ?? [false, false, false, false])];
  let partialPnlRealized = trade.partialPnlRealized ?? 0;
  const displayId = trade.dbId || trade.id;

  const config = COIN_CONFIGS[trade.symbol] || DEFAULT_CONFIG;
  const alloc = config.alloc;

  const stats = { ...currentStats };
  let loggedMsg: string | null = null;

  // Trailing Stop Loss Logic
  let slBound = trade.sl;
  if (realizedTps[2]) slBound = trade.tps[1];      // TP3 hit -> SL to TP2
  else if (realizedTps[1]) slBound = trade.tps[0]; // TP2 hit -> SL to TP1
  else if (realizedTps[0]) slBound = entry;        // TP1 hit -> SL to BE

  // 1. Check stop loss bound
  const hitSL = isLong ? currentPrice <= slBound : currentPrice >= slBound;

  if (hitSL) {
    const remainingPnl = (currentSize * (isLong ? (slBound - entry) : (entry - slBound))) / entry;
    const totalPnl = partialPnlRealized + remainingPnl;
    const finalPercent = (totalPnl / initialSize) * 100;
    const isTrailingStop = finalPercent > 0;

    const closed = {
      ...trade,
      currentPrice,
      size: 0,
      exitPrice: slBound,
      pnl: totalPnl,
      pnlPercent: finalPercent,
      status: isTrailingStop ? 'WIN' : 'LOSS',
      timestamp: Date.now()
    };

    stats.balance += remainingPnl;
    stats.won += (totalPnl > 0 ? 1 : 0);
    stats.lost += (totalPnl <= 0 ? 1 : 0);
    stats.totalPnl += remainingPnl;

    loggedMsg = `[${isTrailingStop ? 'TRAILING STOP' : 'STOP LOSS'} HIT] ${trade.symbol} ${trade.direction} hit SL at ${formatPrice(slBound)}! Yield: ${finalPercent >= 0 ? '+' : ''}${finalPercent.toFixed(2)}%`;

    sendTelegramMessage(
      `${trade.symbol} hit SL`
    ).catch(() => {});

    return { nextActive: null, closedTrade: closed, updatedStats: stats, loggedMsg };
  }

  // 2. Check reversal exit
  if (reversalTriggered) {
    const remainingPnl = (currentSize * (isLong ? (currentPrice - entry) : (entry - currentPrice))) / entry;
    const totalPnl = partialPnlRealized + remainingPnl;
    const finalPercent = (totalPnl / initialSize) * 100;
    const status = totalPnl > 0 ? 'WIN' : 'LOSS';

    const closed = {
      ...trade,
      currentPrice,
      size: 0,
      exitPrice: currentPrice,
      pnl: totalPnl,
      pnlPercent: finalPercent,
      status: status,
      timestamp: Date.now()
    };

    stats.balance += remainingPnl;
    stats.won += (totalPnl > 0 ? 1 : 0);
    stats.lost += (totalPnl <= 0 ? 1 : 0);
    stats.totalPnl += remainingPnl;

    loggedMsg = `[REVERSAL EXIT] ${trade.symbol} ${trade.direction} trend flipped! Exited remaining at ${formatPrice(currentPrice)}. Yield: ${finalPercent >= 0 ? '+' : ''}${finalPercent.toFixed(2)}%`;

    sendTelegramMessage(
      `${trade.symbol} hit SL`
    ).catch(() => {});

    return { nextActive: null, closedTrade: closed, updatedStats: stats, loggedMsg };
  }

  // 3. Scan take-profit levels sequentially
  let immediateCompleteClose = false;
  let actualDeltaPnl = 0;

  for (let i = 0; i < 4; i++) {
    if (realizedTps[i]) continue;

    const targetPrice = trade.tps[i];
    const hitTarget = isLong ? currentPrice >= targetPrice : currentPrice <= targetPrice;
    
    // Require price to genuinely advance into profit
    const isValidMove = isLong ? currentPrice > entry * 1.0005 : currentPrice < entry * 0.9995;

    if (hitTarget && isValidMove) {
      realizedTps[i] = true;
      const partShare = alloc[i] / 100;
      const partSize = initialSize * partShare;
      
      const partPnl = (partSize * (isLong ? (targetPrice - entry) : (entry - targetPrice))) / entry;
      
      actualDeltaPnl += partPnl;
      loggedMsg = `[PARTIAL TP${i+1} HIT] ${trade.symbol} scaled out ${alloc[i]}% of units at ${formatPrice(targetPrice)}!`;
      
      let nextSlText = '';
      if (i === 0) nextSlText = 'breakeven';
      else if (i === 1) nextSlText = 'TP1';
      else if (i === 2) nextSlText = 'TP2';
      else if (i === 3) nextSlText = 'TP3';

      sendTelegramMessage(
        `${trade.symbol} hit TP${i+1}\n` +
        `SL to ${nextSlText}`
      ).catch(() => {});
      
      partialPnlRealized += partPnl;

      // Shrink active size
      currentSize = Math.max(0, currentSize - partSize);

      if (i === 3) {
        immediateCompleteClose = true;
      }
    }
  }

  if (actualDeltaPnl !== 0) {
    stats.balance += actualDeltaPnl;
    stats.totalPnl += actualDeltaPnl;
  }

  if (immediateCompleteClose || currentSize <= 0.01) {
    const finalPercent = (partialPnlRealized / initialSize) * 100;
    const closed = {
      ...trade,
      currentPrice,
      size: 0,
      exitPrice: trade.tps[3],
      pnl: partialPnlRealized,
      pnlPercent: finalPercent,
      status: 'WIN',
      timestamp: Date.now()
    };

    stats.won += 1;

    loggedMsg = `[TP4 COMPLETED] ${trade.symbol} target cycle achieved! Net PnL: +${finalPercent.toFixed(2)}%`;

    sendTelegramMessage(
      `${trade.symbol} hit TP4\n` +
      `SL to TP3`
    ).catch(() => {});

    return { nextActive: null, closedTrade: closed, updatedStats: stats, loggedMsg };
  }

  // Otherwise, keep the active position alive but updated
  const nextActive = {
    ...trade,
    sl: slBound,
    currentPrice,
    size: currentSize,
    realizedTps,
    partialPnlRealized
  };

  return { nextActive, closedTrade: null, updatedStats: stats, loggedMsg };
}

// Low-latency Live position checker checking limits down to milliseconds of feed ticks
async function checkRealPriceExitsServer() {
  if (!db) return;
  try {
    const state = await getSystemState();
    if (!state || !state.activeTrades || state.activeTrades.length === 0) return;

    const activeTrades = state.activeTrades as any[];
    const remaining: any[] = [];
    const closed: any[] = state.closedTrades || [];
    let stats = state.stats || { balance: 10000, won: 0, lost: 0, totalPnl: 0 };
    let logs = state.logs || [];
    let stateChanged = false;

    for (const trade of activeTrades) {
      const currentPrice = globalLivePrices[trade.symbol];
      if (currentPrice === undefined) {
        remaining.push(trade);
        continue;
      }

      // Process trade tick check
      const { nextActive, closedTrade, updatedStats, loggedMsg } = processTradeUpdateServerLogic(trade, currentPrice, stats);
      
      if (closedTrade) {
        stateChanged = true;
        closed.unshift(closedTrade);
        stats = updatedStats;
        if (loggedMsg) {
          const timestamp = new Date().toLocaleTimeString();
          logs.unshift(`[${timestamp}] ${loggedMsg}`);
        }
        
        // Update database trade collection
        try {
          await TradeModel.findOneAndUpdate(
            { tradeId: trade.dbId },
            { 
              status: closedTrade.status, 
              exitPrice: closedTrade.exitPrice, 
              pnlPercent: closedTrade.pnlPercent, 
              updatedAt: new Date() 
            }
          );
        } catch (err) {
          console.error("[RECONCILER] Error updating DB trade record:", err);
        }
      } else if (nextActive) {
        const didPartialTp = JSON.stringify(nextActive.realizedTps) !== JSON.stringify(trade.realizedTps);
        if (didPartialTp) {
          stateChanged = true;
          stats = updatedStats;
          if (loggedMsg) {
            const timestamp = new Date().toLocaleTimeString();
            logs.unshift(`[${timestamp}] ${loggedMsg}`);
          }
          remaining.push(nextActive);
        } else {
          remaining.push(trade);
        }
      }
    }

    if (stateChanged) {
      state.activeTrades = remaining;
      state.closedTrades = closed.slice(0, 40);
      state.stats = stats;
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      console.log("[RECONCILER] System state updated and saved to MongoDB via live tick.");
    }
  } catch (error) {
    console.error("[RECONCILER] Error in checkRealPriceExitsServer:", error);
  }
}

// Low-latency scan and signal generator triggered on candle close events
async function processCoinKlineClose(coin: string, candleStartTime: number) {
  const eventKey = `${coin}-${candleStartTime}`;
  if (processedClosedKlines.has(eventKey)) return;
  await markKeyProcessed(eventKey);
  
  console.log(`[WEBSOCKET SCREENER] ${coin} hourly candle closed! Initiating low-latency technical assessment...`);
  
  try {
    const symbol = `${coin.toUpperCase()}USDT`;
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1000`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return;

    const data = await r.json();
    if (!Array.isArray(data)) return;

    const candles = data.map(c => ({
      time: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));

    if (candles.length < 50) return;

    // Run technical indicators
    const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
    const resList = calculateSrade(candles, config.bbPeriod, config.bbDev, coin);
    
    // Match closed candle
    let targetIdx = candles.length - 2;
    if (candles[candles.length - 1].time === candleStartTime) {
      targetIdx = candles.length - 1;
    }
    
    const signal = resList.signals[targetIdx];
    const adxVal = resList.adx[targetIdx] ?? 0;
    const ema200val = resList.ema200_4h[targetIdx] ?? candles[targetIdx].close;
    const entryPrice = candles[targetIdx].close;

    if (!signal) {
      console.log(`[WEBSOCKET SCREENER] No breakout trend signals detected for ${coin} on close.`);
      return;
    }

    console.log(`[WEBSOCKET SCREENER] SECONDS BREAKOUT: ${coin} ${signal} signal encountered @ $${entryPrice}`);

    // Fetch system state
    const state = await getSystemState();
    if (!state) return;

    // Reject duplicates on active symbols
    const existingIndex = (state.activeTrades || []).findIndex((t: any) => t.symbol === coin);
    let activeTrades = [...(state.activeTrades || [])];
    const closedTrades = [...(state.closedTrades || [])];
    let stats = state.stats || { balance: 10000, won: 0, lost: 0, totalPnl: 0 };
    let logs = state.logs || [];

    if (existingIndex !== -1) {
      const existingTrade = activeTrades[existingIndex];
      if (existingTrade.direction === signal) {
        console.log(`[WEBSOCKET SCREENER] Ignored duplicate ${signal} signal for ${coin}.`);
        return;
      } else {
        // Trend Reversal Exit: Exit counter trade first
        const { closedTrade, updatedStats, loggedMsg } = processTradeUpdateServerLogic(existingTrade, entryPrice, stats, true);
        if (closedTrade) {
          closedTrades.unshift(closedTrade);
          stats = updatedStats;
          if (loggedMsg) {
            logs.unshift(`[${new Date().toLocaleTimeString()}] ${loggedMsg}`);
          }
          try {
            await TradeModel.findOneAndUpdate(
              { tradeId: existingTrade.dbId },
              { 
                status: closedTrade.status, 
                exitPrice: closedTrade.exitPrice, 
                pnlPercent: closedTrade.pnlPercent, 
                updatedAt: new Date() 
              }
            );
          } catch(err) {}
        }
        activeTrades = activeTrades.filter((t: any) => t.id !== existingTrade.id);
      }
    }

    // Filter validation constraints
    const filters = {
      filterAdx: state.filterAdx !== undefined ? state.filterAdx : true,
      filterMtf: state.filterMtf !== undefined ? state.filterMtf : true,
      filterEma: state.filterEma !== undefined ? state.filterEma : true,
      filterVolume: state.filterVolume !== undefined ? state.filterVolume : true,
      filterFunding: state.filterFunding !== undefined ? state.filterFunding : true,
      filterLiquidity: state.filterLiquidity !== undefined ? state.filterLiquidity : true,
    };

    // Calculate volume ratio
    const volumes = candles.map(c => c.volume);
    let volumeRatio = 1.0;
    if (volumes.length >= 20) {
      const lastVol = volumes[volumes.length - 2] || volumes[volumes.length - 1] || 1.0;
      const volSmaSum = volumes.slice(-21, -1).reduce((sum, v) => sum + (v || 0), 0) / 20;
      volumeRatio = lastVol / (volSmaSum || 1);
    }

    const funding = getCoinFundingRate(coin, signal === 'LONG' ? 1 : -1);
    const liquidity = getCoinBase24hVolume(coin);

    // ADX gate
    if (filters.filterAdx && adxVal <= 25) {
      const log = `[FILTER EXCLUSION] ${coin} ${signal} Signal at $${formatPrice(entryPrice)} rejected: ADX sideways (${adxVal.toFixed(1)} <= 25)`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      return;
    }

    // MTF gate
    const candles4h = aggregateTo4Hour(candles);
    const bbPeriod4h = Math.max(10, Math.round(config.bbPeriod / 4));
    const iTrend4h = calculateITrendOnly(candles4h, bbPeriod4h, config.bbDev);
    const mtfTrend = iTrend4h.length > 0 ? iTrend4h[iTrend4h.length - 1] : 0;
    if (filters.filterMtf) {
      if (signal === 'LONG' && mtfTrend !== 1) {
        const log = `[FILTER EXCLUSION] ${coin} LONG at $${formatPrice(entryPrice)} rejected: 4H trend direction bearish/neutral`;
        logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
        state.logs = logs.slice(0, 40);
        await saveSystemState(state);
        return;
      }
      if (signal === 'SHORT' && mtfTrend !== -1) {
        const log = `[FILTER EXCLUSION] ${coin} SHORT at $${formatPrice(entryPrice)} rejected: 4H trend direction bullish/neutral`;
        logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
        state.logs = logs.slice(0, 40);
        await saveSystemState(state);
        return;
      }
    }

    // EMA gate
    if (filters.filterEma) {
      if (signal === 'LONG' && entryPrice <= ema200val) {
        const log = `[FILTER EXCLUSION] ${coin} LONG at $${formatPrice(entryPrice)} rejected: price below 4H EMA 200 (${formatPrice(ema200val)})`;
        logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
        state.logs = logs.slice(0, 40);
        await saveSystemState(state);
        return;
      }
      if (signal === 'SHORT' && entryPrice >= ema200val) {
        const log = `[FILTER EXCLUSION] ${coin} SHORT at $${formatPrice(entryPrice)} rejected: price above 4H EMA 200 (${formatPrice(ema200val)})`;
        logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
        state.logs = logs.slice(0, 40);
        await saveSystemState(state);
        return;
      }
    }

    // Volume gate
    if (filters.filterVolume && volumeRatio <= 1.5) {
      const log = `[FILTER EXCLUSION] ${coin} ${signal} rejected: breakout volume ratio ${volumeRatio.toFixed(2)}x <= 1.5x`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      return;
    }

    // Funding gate
    if (filters.filterFunding) {
      const fundingPct = funding * 100;
      if (signal === 'LONG' && funding >= 0.05) {
        const log = `[FILTER EXCLUSION] ${coin} LONG rejected: funding rate too high (${fundingPct.toFixed(4)}%)`;
        logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
        state.logs = logs.slice(0, 40);
        await saveSystemState(state);
        return;
      }
      if (signal === 'SHORT' && funding <= -0.05) {
        const log = `[FILTER EXCLUSION] ${coin} SHORT rejected: funding rate too low (${fundingPct.toFixed(4)}%)`;
        logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
        state.logs = logs.slice(0, 40);
        await saveSystemState(state);
        return;
      }
    }

    // Liquidity gate
    if (filters.filterLiquidity && liquidity < 30000000) {
      const log = `[FILTER EXCLUSION] ${coin} ${signal} rejected: Liquidity $${(liquidity/1000000).toFixed(1)}M < $30M limit`;
      logs.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
      state.logs = logs.slice(0, 40);
      await saveSystemState(state);
      return;
    }

    let tps: [number, number, number, number];
    let sl: number;

    const p1 = config.tp[0];
    const p2 = config.tp[1];
    const p3 = config.tp[2];
    const p4 = config.tp[3];
    const slPct = config.sl;

    if (signal === 'LONG') {
      sl = entryPrice * (1 - slPct / 100);
      tps = [
        entryPrice * (1 + p1 / 100),
        entryPrice * (1 + p2 / 100),
        entryPrice * (1 + p3 / 100),
        entryPrice * (1 + p4 / 100)
      ];
    } else {
      sl = entryPrice * (1 + slPct / 100);
      tps = [
        entryPrice * (1 - p1 / 100),
        entryPrice * (1 - p2 / 100),
        entryPrice * (1 - p3 / 100),
        entryPrice * (1 - p4 / 100)
      ];
    }

    const baseSize = 10000 * 0.02 * config.risk * 3;
    const now = new Date();
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dateKey = `${dd}${mm}`;

    // Update Counter
    const count = await getNextTradeCount(dateKey);
    const paddedSeq = String(count).padStart(2, '0');
    const tradeId = `${dateKey}${paddedSeq}`;

    // Record trade
    const tradeRecord = new TradeModel({
      tradeId,
      symbol: coin,
      direction: signal,
      entryPrice,
      status: "OPEN",
      pnlPercent: 0
    });
    await tradeRecord.save();

    const newTrade: any = {
      id: Math.random().toString(36).substring(2, 7).toUpperCase(),
      dbId: tradeId,
      symbol: coin,
      direction: signal,
      entry: entryPrice,
      tp: tps[0],
      tps,
      sl,
      currentPrice: entryPrice,
      size: baseSize,
      risk: config.risk,
      realizedTps: [false, false, false, false],
      initialSize: baseSize,
      partialPnlRealized: 0
    };

    activeTrades.push(newTrade);
    
    const successMsg = `>>> WEBSOCKET TRIGGER: ${coin} ${signal} @ $${formatPrice(entryPrice)} generated! Trade ${tradeId} recorded.`;
    logs.unshift(`[${new Date().toLocaleTimeString()}] ${successMsg}`);

    state.activeTrades = activeTrades;
    state.closedTrades = closedTrades.slice(0, 40);
    state.stats = stats;
    state.logs = logs.slice(0, 40);
    await saveSystemState(state);

    console.log(`[WEBSOCKET SCREENER] Successfully executed and stored trade: ${tradeId}`);

    // Notify Telegram with rich, professional layout
    sendTelegramMessage(
      `Symbol: ${coin}\n` +
      `Direction: ${signal}\n` +
      `TP Levels: ${formatPrice(tps[0])}, ${formatPrice(tps[1])}, ${formatPrice(tps[2])}, ${formatPrice(tps[3])}\n` +
      `SL Level: ${formatPrice(sl)}`,
      signal
    ).catch(() => {});

  } catch (error: any) {
    console.error(`[WEBSOCKET SCREENER] Error processing closed kline for ${coin}:`, error);
  }
}

// self-healing WebSocket Manager
let binanceWs: WebSocket | null = null;
let reconnectDelay = 2000;

let pingInterval: NodeJS.Timeout | null = null;

function startWebSocketScreener() {
  const wsUrl = "wss://fstream.binance.com/ws";

  console.log("[WEBSOCKET SCREENER] Connecting to live Binance Futures WebSockets...");
  
  const ws = new WebSocket(wsUrl);
  binanceWs = ws;

  ws.on("open", () => {
    console.log("[WEBSOCKET SCREENER] Connection established on 1H Binance kline streams! Low latency monitoring active.");
    reconnectDelay = 2000;
    
    // Subscribe to klines
    const params = MAJOR_FUTURES.map(coin => `${coin.toLowerCase()}usdt@kline_1h`);
    ws.send(JSON.stringify({
      method: "SUBSCRIBE",
      params,
      id: 1
    }));
    
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping(); // Send standard websocket ping frame
      }
    }, 30000);
  });

  ws.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      if (payload.e === "kline" && payload.k) {
        const symbol = payload.s; // e.g., "BTCUSDT"
        const coin = symbol.toUpperCase().replace("USDT", "");
        const k = payload.k;
        const currentClose = parseFloat(k.c);
        
        globalLivePrices[coin] = currentClose;
        
        const binanceLikeK = {
          t: k.t,
          o: k.o,
          c: k.c,
          h: k.h,
          l: k.l,
          v: k.v,
          x: k.x
        };
        
        updateCoinCandleCacheAndCheck(coin, binanceLikeK).catch(err => {
          console.error(`[LOW-LATENCY RUNTIME] Error in cache check for ${coin}:`, err.message);
        });
      }
    } catch (e: any) {
      console.error("[WEBSOCKET SCREENER] Parse error on raw packet:", e.message);
    }
  });

  ws.on("ping", () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.pong();
    }
  });

  ws.on("error", (err) => {
    console.error("[WEBSOCKET SCREENER] WebSocket encountered error:", err.message);
  });

  ws.on("close", (code, reason) => {
    if (pingInterval) clearInterval(pingInterval);
    console.warn(`[WEBSOCKET SCREENER] Socket disconnected (Code: ${code}). Re-establishing connection in ${reconnectDelay}ms...`);
    binanceWs = null;
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      startWebSocketScreener();
    }, reconnectDelay);
  });
}

// Start fast reconciler loop (every 2 seconds) to track prices against limits
setInterval(() => {
  checkRealPriceExitsServer();
}, 2000);

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
        // Temporarily disabled photo sending for Render compatibility
        // It falls back to standard text message.
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
          console.error("[TELEGRAM API ERROR]", telegramData);
          throw new Error(telegramData.description || `Telegram response status ${response.status}`);
        }
      }
      
      item.resolve(telegramData);
    } catch (e: any) {
      console.error("[TELEGRAM GATEWAY EXCEPTION]", e.message || e);
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
       const count = await getNextTradeCount(dateKey);
       const paddedSeq = String(count).padStart(2, '0');
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

// Daily report removed as per user instruction.

app.get("/api/admin/heal", async (req, res) => {
  try {
    await healExistingTradesInDatabase();
    res.json({ success: true, message: "Manual database healing executed successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
    const { 
      logs,
      filterAdx,
      filterMtf,
      filterEma,
      filterVolume,
      filterFunding,
      filterLiquidity
    } = req.body;

    const currentState = await db.collection("system_state").findOne({ id: "main" });
    let mergedLogs = logs || [];
    
    let activeTrades = [];
    let closedTrades = [];
    let stats = { balance: 10000, won: 0, lost: 0, totalPnl: 0 };

    if (currentState) {
      activeTrades = currentState.activeTrades || [];
      closedTrades = currentState.closedTrades || [];
      stats = currentState.stats || stats;

      if (currentState.logs) {
         const frontendLogsSet = new Set(logs || []);
         const unseenBackendLogs = currentState.logs.filter((l: string) => !frontendLogsSet.has(l));
         mergedLogs = [...unseenBackendLogs, ...mergedLogs].slice(0, 40);
      }
    }

    await db.collection("system_state").updateOne(
      { id: "main" },
      { 
        $set: { 
          activeTrades, 
          closedTrades, 
          stats, 
          logs: mergedLogs, 
          filterAdx,
          filterMtf,
          filterEma,
          filterVolume,
          filterFunding,
          filterLiquidity,
          updatedAt: new Date() 
        } 
      },
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
  console.log("[CRON] Starting background market scan Fallback...");
  try {
    let triggeredSignals = 0;
    
    // We only process the top 15 to avoid API limits on free tiers, or run concurrently
    // Using MAJOR_FUTURES, processing all in parallel
    const processPromises = MAJOR_FUTURES.map(async (coin) => {
      try {
        const symbol = `${coin.toUpperCase()}USDT`;
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1000`, {
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return;

        const data = await r.json();
        if (!Array.isArray(data)) return;
        const candles = data.map(c => ({
          time: parseInt(c[0]),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        }));

        if (candles.length < 50) return;

        // Run technical analysis
        const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
        const resList = calculateSrade(candles, config.bbPeriod, config.bbDev, coin);
        
        const volumes = candles.map(c => c.volume);
        for (let offset = 2; offset <= 3; offset++) {
          const targetIdx = candles.length - offset;
          if (targetIdx < 0) continue;
          
          const candleTime = candles[targetIdx].time;
          const processedKey = `${coin}-${candleTime}`;
          if (processedClosedKlines.has(processedKey)) continue;

          const signal = resList.signals[targetIdx];
          const adxVal = resList.adx[targetIdx] ?? 0;
          const ema200val = resList.ema200_4h[targetIdx] ?? candles[targetIdx].close;

          await markKeyProcessed(processedKey);

          if (signal) {
            const state = await getSystemState();
            if (!state) continue;

            const filters = {
              filterAdx: state.filterAdx !== undefined ? state.filterAdx : true,
              filterMtf: state.filterMtf !== undefined ? state.filterMtf : true,
              filterEma: state.filterEma !== undefined ? state.filterEma : true,
              filterVolume: state.filterVolume !== undefined ? state.filterVolume : true,
              filterFunding: state.filterFunding !== undefined ? state.filterFunding : true,
              filterLiquidity: state.filterLiquidity !== undefined ? state.filterLiquidity : true,
            };

            const closePrice = candles[targetIdx].close;

            // Volume Ratio Calculation
            let volumeRatio = 1.0;
            if (volumes.length >= 20) {
              const lastVol = volumes[targetIdx] || 1.0;
              const startSlice = Math.max(0, targetIdx - 20);
              const prevVols = volumes.slice(startSlice, targetIdx);
              if (prevVols.length > 0) {
                const volSmaSum = prevVols.reduce((sum, v) => sum + (v || 0), 0) / prevVols.length;
                volumeRatio = lastVol / (volSmaSum || 1);
              }
            }

            const funding = getCoinFundingRate(coin, signal === 'LONG' ? 1 : -1);
            const liquidity = getCoinBase24hVolume(coin);

            // ADX gate
            if (filters.filterAdx && adxVal <= 25) {
              const log = `[CRON FILTER] ${coin} ${signal} at $${formatPrice(closePrice)} rejected: ADX sideways (${adxVal.toFixed(1)} <= 25)`;
              state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
              await saveSystemState(state);
              continue;
            }

            // MTF gate
            const candles4h = aggregateTo4Hour(candles.slice(0, targetIdx + 1));
            const bbPeriod4h = Math.max(10, Math.round(config.bbPeriod / 4));
            const iTrend4h = calculateITrendOnly(candles4h, bbPeriod4h, config.bbDev);
            const mtfTrend = iTrend4h.length > 0 ? iTrend4h[iTrend4h.length - 1] : 0;
            if (filters.filterMtf) {
              if (signal === 'LONG' && mtfTrend !== 1) {
                const log = `[CRON FILTER] ${coin} LONG at $${formatPrice(closePrice)} rejected: 4H trend direction bearish/neutral`;
                state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
                await saveSystemState(state);
                continue;
              }
              if (signal === 'SHORT' && mtfTrend !== -1) {
                const log = `[CRON FILTER] ${coin} SHORT at $${formatPrice(closePrice)} rejected: 4H trend direction bullish/neutral`;
                state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
                await saveSystemState(state);
                continue;
              }
            }

            // EMA gate
            if (filters.filterEma) {
              if (signal === 'LONG' && closePrice <= ema200val) {
                const log = `[CRON FILTER] ${coin} LONG at $${formatPrice(closePrice)} rejected: price below 4H EMA 200 (${formatPrice(ema200val)})`;
                state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
                await saveSystemState(state);
                continue;
              }
              if (signal === 'SHORT' && closePrice >= ema200val) {
                const log = `[CRON FILTER] ${coin} SHORT at $${formatPrice(closePrice)} rejected: price above 4H EMA 200 (${formatPrice(ema200val)})`;
                state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
                await saveSystemState(state);
                continue;
              }
            }

            // Volume gate
            if (filters.filterVolume && volumeRatio <= 1.5) {
              const log = `[CRON FILTER] ${coin} ${signal} rejected: breakout volume ratio ${volumeRatio.toFixed(2)}x <= 1.5x`;
              state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
              await saveSystemState(state);
              continue;
            }

            // Funding gate
            if (filters.filterFunding) {
              const fundingPct = funding * 100;
              if (signal === 'LONG' && funding >= 0.05) {
                const log = `[CRON FILTER] ${coin} LONG rejected: funding rate too high (${fundingPct.toFixed(4)}%)`;
                state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
                await saveSystemState(state);
                continue;
              }
              if (signal === 'SHORT' && funding <= -0.05) {
                const log = `[CRON FILTER] ${coin} SHORT rejected: funding rate too low (${fundingPct.toFixed(4)}%)`;
                state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
                await saveSystemState(state);
                continue;
              }
            }

            // Liquidity gate
            if (filters.filterLiquidity && liquidity < 30000000) {
              const log = `[CRON FILTER] ${coin} ${signal} rejected: Liquidity $${(liquidity/1000000).toFixed(1)}M < $30M limit`;
              state.logs = [`[${new Date().toLocaleTimeString()}] ${log}`, ...(state.logs || [])].slice(0, 40);
              await saveSystemState(state);
              continue;
            }

            // Reject duplicates on active symbols or handle Trend Reversal
            let activeTrades = [...(state.activeTrades || [])];
            const closedTrades = [...(state.closedTrades || [])];
            let stats = state.stats || { balance: 10000, won: 0, lost: 0, totalPnl: 0 };
            let logs = state.logs || [];

            const existingIndex = activeTrades.findIndex((t: any) => t.symbol === coin);
            if (existingIndex !== -1) {
              const existingTrade = activeTrades[existingIndex];
              if (existingTrade.direction === signal) {
                console.log(`[CRON SCANNER] Ignored duplicate ${signal} signal for ${coin}.`);
                continue;
              } else {
                // Trend Reversal Exit: Exit counter trade first
                const { closedTrade, updatedStats, loggedMsg } = processTradeUpdateServerLogic(existingTrade, closePrice, stats, true);
                if (closedTrade) {
                  closedTrades.unshift(closedTrade);
                  stats = updatedStats;
                  if (loggedMsg) {
                    logs.unshift(`[${new Date().toLocaleTimeString()}] ${loggedMsg}`);
                  }
                  try {
                    await TradeModel.findOneAndUpdate(
                      { tradeId: existingTrade.dbId },
                      { 
                        status: closedTrade.status, 
                        exitPrice: closedTrade.exitPrice, 
                        pnlPercent: closedTrade.pnlPercent, 
                        updatedAt: new Date() 
                      }
                    );
                  } catch(err) {}
                }
                activeTrades = activeTrades.filter((t: any) => t.id !== existingTrade.id);
              }
            }

            triggeredSignals++;
            let tps: [number, number, number, number];
            let sl: number;

            const p1 = config.tp[0];
            const p2 = config.tp[1];
            const p3 = config.tp[2];
            const p4 = config.tp[3];
            const slPct = config.sl;

            if (signal === 'LONG') {
              sl = closePrice * (1 - slPct / 100);
              tps = [
                closePrice * (1 + p1 / 100),
                closePrice * (1 + p2 / 100),
                closePrice * (1 + p3 / 100),
                closePrice * (1 + p4 / 100)
              ];
            } else {
              sl = closePrice * (1 + slPct / 100);
              tps = [
                closePrice * (1 - p1 / 100),
                closePrice * (1 - p2 / 100),
                closePrice * (1 - p3 / 100),
                closePrice * (1 - p4 / 100)
              ];
            }

            const baseSize = 10000 * 0.02 * config.risk * 3;
            const now = new Date();
            const dateKey = `${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
            const count = await getNextTradeCount(dateKey);
            const tradeId = `${dateKey}${String(count).padStart(2, '0')}`;

            const tradeRecord = new TradeModel({
              tradeId, symbol: coin, direction: signal, entryPrice: closePrice, status: "OPEN", pnlPercent: 0
            });
            await tradeRecord.save();

            const newTrade: any = {
              id: Math.random().toString(36).substring(2, 7).toUpperCase(),
              dbId: tradeId, symbol: coin, direction: signal, entry: closePrice, tp: tps[0], tps, sl, currentPrice: closePrice,
              size: baseSize, risk: config.risk, realizedTps: [false, false, false, false], initialSize: baseSize, partialPnlRealized: 0
            };

            activeTrades.push(newTrade);
            state.activeTrades = activeTrades;
            state.closedTrades = closedTrades;
            state.stats = stats;
            
            const successMsg = `>>> SYSTEM SCANNER TRIGGER: ${coin} ${signal} @ $${formatPrice(closePrice)} generated! Trade ${tradeId} recorded.`;
            logs.unshift(`[${new Date().toLocaleTimeString()}] ${successMsg}`);
            state.logs = logs.slice(0, 40);

            await saveSystemState(state);

            const msg = `[CRON TRIGGERED] Symbol: ${coin}\n` +
              `Direction: ${signal}\n` +
              `TP Levels: ${formatPrice(tps[0])}, ${formatPrice(tps[1])}, ${formatPrice(tps[2])}, ${formatPrice(tps[3])}\n` +
              `SL Level: ${formatPrice(sl)}`;
            await sendTelegramMessage(msg, signal);
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

app.post("/api/db/reset", async (req, res) => {
  try {
    if (db && db !== memoryDb) {
      await db.collection("system_state").deleteMany({});
      await TradeModel.deleteMany({});
      await DailyCounterModel.deleteMany({});
    }
    
    // Also reset global server memory state
    globalLivePrices = {};
    serverCoinsCandles = {};
    telegramQueue.length = 0;
    
    // Re-init default state in db
    const initialState = { 
      id: "main",
      stats: { balance: 0, won: 0, lost: 0, totalPnl: 0 },
      activeTrades: [],
      closedTrades: [],
      logs: [],
      updatedAt: Date.now()
    };
    if (db && db !== memoryDb) {
      await db.collection("system_state").updateOne(
        { id: "main" },
        { $set: initialState },
        { upsert: true }
      );
    } else {
      memoryDbState = { ...initialState };
    }
    
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 2. API: Fetch Live Binance Futures perpetual prices
app.get("/api/binance/prices", async (req, res) => {
  try {
    // If cached WebSocket prices exist, return them instantly in under 1ms!
    if (Object.keys(globalLivePrices).length > 0) {
      return res.json({
        success: true,
        source: "Live WebSocket Cache",
        prices: { ...globalLivePrices }
      });
    }

    const response = await fetch("https://fapi.binance.com/fapi/v1/ticker/price", {
      signal: AbortSignal.timeout(4000)
    });
    
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.statusText}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
       throw new Error(`Binance API data format error`);
    }

    // Filter for some USDT pairs
    const usdtPrices: Record<string, number> = {};
    data.forEach((item: any) => {
      if (item.symbol.endsWith("USDT")) {
        const coin = item.symbol.replace("USDT", "");
        const val = parseFloat(item.price);
        usdtPrices[coin] = val;
        globalLivePrices[coin] = val; // populate cache too
      }
    });

    res.json({
      success: true,
      source: "Binance Futures API (Fallback)",
      prices: usdtPrices
    });
  } catch (error: any) {
    if (Object.keys(globalLivePrices).length > 0) {
      return res.json({
        success: true,
        source: "Live WebSocket Cache (Offline API)",
        prices: { ...globalLivePrices }
      });
    }
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

    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1000`, {
      signal: AbortSignal.timeout(6000)
    });

    if (!r.ok) {
      throw new Error(`Failed to fetch candles: ${r.statusText}`);
    }

    const data = await r.json();
    if (!Array.isArray(data)) {
        throw new Error(`Failed to parse candles`);
    }
    // Parse as open, high, low, close, volume, closeTime, quoteVolume
    const candles = data.map(c => ({
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
