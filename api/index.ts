import express from "express";
import path from "path";
import dns from "dns";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import mongoose from "mongoose";
import WebSocket from "ws";
import { calculateGGShot, getCoinFundingRate, getCoinBase24hVolume, aggregateTo4Hour, calculateITrendOnly } from "../src/lib/indicators.js";
import { COIN_CONFIGS, DEFAULT_CONFIG } from "../src/lib/ggshot_1h_config.js";

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
    // Start WebSocket Screener once DB is connected!
    startWebSocketScreener();
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

const MAJOR_FUTURES = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'PEPE', 'WIF', 'SUI',
  'APT', 'ARB', 'OP', 'TIA', 'NOT', 'LTC', 'LINK', 'DOT', 'NEAR', 'AVAX'
];

// Sub-millisecond Live Price cache updated via WebSocket
const globalLivePrices: Record<string, number> = {};

// Keep a set of processed keys to strictly prevent double executions (idempotency)
const processedClosedKlines = new Set<string>();

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

  // 1. Check stop loss bound
  const slBound = trade.sl;
  const hitSL = isLong ? currentPrice <= slBound : currentPrice >= slBound;

  if (hitSL) {
    const remainingPnl = (currentSize * (isLong ? (slBound - entry) : (entry - slBound))) / entry;
    const totalPnl = partialPnlRealized + remainingPnl;
    const finalPercent = (totalPnl / initialSize) * 100;

    const closed = {
      ...trade,
      currentPrice,
      size: 0,
      exitPrice: slBound,
      pnl: totalPnl,
      pnlPercent: finalPercent,
      status: 'LOSS',
      timestamp: Date.now()
    };

    stats.balance += remainingPnl;
    stats.won += (totalPnl > 0 ? 1 : 0);
    stats.lost += (totalPnl <= 0 ? 1 : 0);
    stats.totalPnl += remainingPnl;

    loggedMsg = `[STOP LOSS HIT] ${trade.symbol} ${trade.direction} hit SL at ${formatPrice(slBound)}! Yield: ${finalPercent >= 0 ? '+' : ''}${finalPercent.toFixed(2)}%`;

    sendTelegramMessage(
      `🚨 <b>GG-SHOT Stop Loss Hit</b>\n\n` +
      `🆔 <b>trade id:</b> ${displayId}\n` +
      `🪙 <b>Asset:</b> #${trade.symbol}USDT [${trade.direction}]\n` +
      `📉 <b>Event:</b> Position hit Stop Loss bound\n` +
      `💵 <b>SL price:</b> ${formatPrice(slBound)}\n` +
      `📊 <b>Net Cycle Performance:</b> <b>${finalPercent >= 0 ? '+' : ''}${finalPercent.toFixed(2)}%</b>`
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
      `🔄 <b>GG-SHOT Trend Reversal Exit</b>\n\n` +
      `🆔 <b>trade id:</b> ${displayId}\n` +
      `🪙 <b>Asset:</b> #${trade.symbol}USDT [${trade.direction}]\n` +
      `⚠️ <b>Event:</b> Trend inverted. Safety scale-out executed.\n` +
      `💵 <b>Reversal Price:</b> ${formatPrice(currentPrice)}\n` +
      `📊 <b>Net Cycle Performance:</b> <b>${finalPercent >= 0 ? '+' : ''}${finalPercent.toFixed(2)}%</b>`
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
      
      sendTelegramMessage(
        `🎯 <b>GG-SHOT Take Profit Achieved!</b>\n\n` +
        `🆔 <b>trade id:</b> ${displayId}\n` +
        `🪙 <b>Asset:</b> #${trade.symbol}USDT [${trade.direction}]\n` +
        `📈 <b>Milestone:</b> Take Profit #${i+1} reached successfully! 🎉\n` +
        `📊 <b>Scale-out Weight:</b> ${alloc[i]}%\n` +
        `💵 <b>Price Targeted:</b> ${formatPrice(targetPrice)}\n` +
        `📊 <b>Target Status:</b> Achieved\n` +
        `💰 <b>Partial PnL Realized:</b> <b>+${(partPnl / initialSize * 100).toFixed(2)}%</b>`
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
      `🏆 <b>GG-SHOT Cycle Fully Achieved!</b>\n\n` +
      `🆔 <b>trade id:</b> ${displayId}\n` +
      `🪙 <b>Asset:</b> #${trade.symbol}USDT [${trade.direction}]\n` +
      `🏁 <b>Event:</b> Ultimate Take Profit #4 hit - full position realized!\n` +
      `💵 <b>Completion Price:</b> ${formatPrice(trade.tps[3])}\n` +
      `📊 <b>Total Net Cycle Performance:</b> <b>+${finalPercent.toFixed(2)}%</b>`
    ).catch(() => {});

    return { nextActive: null, closedTrade: closed, updatedStats: stats, loggedMsg };
  }

  // Otherwise, keep the active position alive but updated
  const nextActive = {
    ...trade,
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
  processedClosedKlines.add(eventKey);
  
  console.log(`[WEBSOCKET SCREENER] ${coin} hourly candle closed! Initiating low-latency technical assessment...`);
  
  try {
    const symbol = `${coin}USDT`;
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1000`, {
      signal: AbortSignal.timeout(6000)
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

    // Run technical indicators
    const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
    const resList = calculateGGShot(candles, config.bbPeriod, config.bbDev);
    
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

    // Parameters set
    const p1 = config.tp[0];
    const p2 = config.tp[1];
    const p3 = config.tp[2];
    const p4 = config.tp[3];
    const slPct = config.sl;

    let tps: [number, number, number, number];
    let sl: number;

    if (signal === 'LONG') {
      tps = [
        entryPrice * (1 + p1 / 100),
        entryPrice * (1 + p2 / 100),
        entryPrice * (1 + p3 / 100),
        entryPrice * (1 + p4 / 100)
      ];
      sl = entryPrice * (1 - slPct / 100);
    } else {
      tps = [
        entryPrice * (1 - p1 / 100),
        entryPrice * (1 - p2 / 100),
        entryPrice * (1 - p3 / 100),
        entryPrice * (1 - p4 / 100)
      ];
      sl = entryPrice * (1 + slPct / 100);
    }

    const baseSize = 10000 * 0.02 * config.risk * 3;
    const now = new Date();
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dateKey = `${dd}${mm}`;

    // Update Counter
    const counter = await DailyCounterModel.findOneAndUpdate(
      { dateKey },
      { $inc: { count: 1 } },
      { new: true, upsert: true }
    );
    const paddedSeq = String(counter.count).padStart(2, '0');
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
      `🤖 <b>New Automated Trade Signal</b>\n\n` +
      `🆔 <b>trade id:</b> ${tradeId}\n` +
      `🪙 <b>symbol:</b> #${coin}USDT\n` +
      `📈 <b>direction:</b> ${signal}\n` +
      `🎯 <b>tps:</b>\n` +
      `  TP1: $${formatPrice(tps[0])}\n` +
      `  TP2: $${formatPrice(tps[1])}\n` +
      `  TP3: $${formatPrice(tps[2])}\n` +
      `  TP4: $${formatPrice(tps[3])}\n` +
      `🛑 <b>sl:</b> $${formatPrice(sl)}\n\n` +
      `⚡ <i>Processed in sub-millisecond network latency from closed kline.</i>`,
      signal
    ).catch(() => {});

  } catch (error: any) {
    console.error(`[WEBSOCKET SCREENER] Error processing closed kline for ${coin}:`, error);
  }
}

// self-healing WebSocket Manager
let binanceWs: WebSocket | null = null;
let reconnectDelay = 2000;

function startWebSocketScreener() {
  const wsStreams = MAJOR_FUTURES.map(coin => `${coin.toLowerCase()}usdt@kline_1h`).join("/");
  const wsUrl = `wss://fstream.binance.com/stream?streams=${wsStreams}`;

  console.log("[WEBSOCKET SCREENER] Connecting to live Binance Futures WebSockets...");
  
  const ws = new WebSocket(wsUrl);
  binanceWs = ws;

  ws.on("open", () => {
    console.log("[WEBSOCKET SCREENER] Connection established on 1H kline streams! Low latency monitoring active.");
    reconnectDelay = 2000;
  });

  ws.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      if (payload && payload.data) {
        const data = payload.data;
        if (data.e === "kline") {
          const coin = data.s.replace("USDT", "");
          const k = data.k;
          
          globalLivePrices[coin] = parseFloat(k.c);
          
          if (k.x === true) {
            processCoinKlineClose(coin, parseInt(k.t));
          }
        }
      }
    } catch (e: any) {
      console.error("[WEBSOCKET SCREENER] Parse error on raw packet:", e.message);
    }
  });

  ws.on("error", (err) => {
    console.error("[WEBSOCKET SCREENER] WebSocket encountered error:", err.message);
  });

  ws.on("close", (code, reason) => {
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
    const { 
      activeTrades, 
      closedTrades, 
      stats, 
      logs,
      filterAdx,
      filterMtf,
      filterEma,
      filterVolume,
      filterFunding,
      filterLiquidity
    } = req.body;
    await db.collection("system_state").updateOne(
      { id: "main" },
      { 
        $set: { 
          activeTrades, 
          closedTrades, 
          stats, 
          logs, 
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
        const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
        const resList = calculateGGShot(candles, config.bbPeriod, config.bbDev);
        
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
    // If cached WebSocket prices exist, return them instantly in under 1ms!
    if (Object.keys(globalLivePrices).length > 0) {
      return res.json({
        success: true,
        source: "Live WebSocket Cache",
        prices: { ...globalLivePrices }
      });
    }

    const baseUrl = "https://fapi.binance.com";
    const response = await fetch(`${baseUrl}/fapi/v1/ticker/price`, {
      signal: AbortSignal.timeout(4000)
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
