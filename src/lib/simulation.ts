import { ActiveTrade, TradeDirection } from '../types';
import { COIN_CONFIGS, DEFAULT_CONFIG } from './srade_1h_config';
import { Candle, getCoinBase24hVolume } from './indicators';

export interface CoinMetadata {
  name: string;
  price: number;
  winRate: number;
}

export const MONITORED_COINS: CoinMetadata[] = [
  { name: 'BTC', price: 69250, winRate: 0.55 }
];

let idCounter = 1;

/**
 * Generate highly realistic, non-empty initial candle history for any coin
 */
export function generateHistoryForCoin(symbol: string, basePrice: number, length = 150): Candle[] {
  const candles: Candle[] = [];
  let currentPrice = basePrice;
  const timeStep = 3600000; // 1 hour steps
  let currentTime = Date.now() - length * timeStep;
  const base24hVol = getCoinBase24hVolume(symbol);

  for (let i = 0; i < length; i++) {
    // Add subtle drift/vibrancy based on random walk
    const drift = (Math.random() - 0.49) * 0.008 * currentPrice; // 0.8% max movement
    const open = currentPrice;
    const close = currentPrice + drift;
    const maxVal = Math.max(open, close);
    const minVal = Math.min(open, close);
    const high = maxVal * (1 + Math.random() * 0.003);
    const low = minVal * (1 - Math.random() * 0.003);
    
    // Hourly average volume fluctuated
    const hourlyBaseVol = base24hVol / 24;
    const volume = hourlyBaseVol * (0.6 + Math.random() * 0.8);
    const quoteVolume = volume; // Approximated

    candles.push({
      time: currentTime,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume
    });

    currentPrice = close;
    currentTime += timeStep;
  }

  return candles;
}

/**
 * Perform realistic tick update on the last candle, simulating market movement
 */
export function tickCandle(candle: Candle, changePct = 0.0015): Candle {
  const diffPct = (Math.random() - 0.5) * 2 * changePct;
  const nextClose = candle.close * (1 + diffPct);
  
  return {
    ...candle,
    close: nextClose,
    high: Math.max(candle.high, nextClose),
    low: Math.min(candle.low, nextClose),
    // Tick updates keep the same volume or add slightly
    volume: candle.volume !== undefined ? candle.volume + (Math.random() * 50) : 1000
  };
}

/**
 * Create a new closed candle appending to the series
 */
export function appendNextCandle(candles: Candle[]): Candle {
  const last = candles[candles.length - 1];
  const nextTime = last.time + 3600000;
  const symbol = last.close ? 'FOCUS' : 'GENERIC'; // App provides correct base context
  
  // Minimal step change
  const open = last.close;
  const change = (Math.random() - 0.5) * 0.007 * open;
  const close = open + change;
  const high = Math.max(open, close) * (1 + Math.random() * 0.002);
  const low = Math.min(open, close) * (1 - Math.random() * 0.002);

  const baseVol = getCoinBase24hVolume(symbol) / 24;
  // Volume spike with 15% probability to simulate breakout volume triggers
  const volumeSpike = Math.random() < 0.15 ? 1.8 : 1.0;
  const volume = baseVol * (0.5 + Math.random() * 0.9) * volumeSpike;

  return {
    time: nextTime,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume: volume
  };
}

/**
 * Force an artificial crossover condition on the candle array to trigger trade signals
 */
export function forceSignalCrossover(candles: Candle[], direction: 'LONG' | 'SHORT', currentPrice: number): Candle[] {
  const cloned = [...candles];
  const n = cloned.length;
  if (n < 10) return cloned;

  const config = COIN_CONFIGS[cloned[0].close ? 'APE' : 'WAXP'] || { bbPeriod: 80 };
  const period = config.bbPeriod || 80;

  // We want to force a change. Let's shift prices!
  // Long trigger needs iTrend to flip from -1 to 1.
  // This happens when the TrendLine rises, meaning the low is higher or high is higher.
  // We can scale the last 3 close/high/low prices high or low to force an immediate flip
  const scale = direction === 'LONG' ? 1.12 : 0.88;
  
  for (let i = n - 3; i < n; i++) {
    cloned[i] = {
      ...cloned[i],
      open: cloned[i].open ? cloned[i].open * scale : currentPrice * scale,
      close: cloned[i].close * scale,
      high: cloned[i].high * scale,
      low: cloned[i].low * scale
    };
  }

  return cloned;
}

/**
 * Synthesize a perfect live trade based on matched indicators and config constraints
 */
export function spawnTradeOfCondition(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  entryPrice: number
): ActiveTrade {
  const config = COIN_CONFIGS[symbol] || DEFAULT_CONFIG;

  const p1 = config.tp[0];
  const p2 = config.tp[1];
  const p3 = config.tp[2];
  const p4 = config.tp[3];
  const slPct = config.sl;

  let tps: [number, number, number, number];
  let sl: number;

  if (direction === 'LONG') {
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

  // Final TP4 target boundary
  const tp = tps[0]; // TP1 target

  // Professional position sizing: 2% of simulated 10k portfolio
  const baseSize = 10000 * 0.02;

  return {
    id: `${(idCounter++).toString().padStart(3, '0')}`,
    symbol,
    direction,
    entry: entryPrice,
    tp,
    tps,
    sl,
    currentPrice: entryPrice,
    size: baseSize,
    risk: config.risk,
    realizedTps: [false, false, false, false],
    initialSize: baseSize,
    partialPnlRealized: 0
  };
}
