/**
 * Srade Strategy Indicators
 * Exact TypeScript implementation of PineScript v5 Core Logic
 */

export interface Candle {
  time: number;
  open?: number;
  high: number;
  low: number;
  close: number;
}

export interface Candle {
  time: number;
  open?: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  quoteVolume?: number;
}

export interface IndicatorResult {
  mid: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
  bbSignals: number[];
  trendLine: number[];
  iTrend: number[];
  signals: ('LONG' | 'SHORT' | null)[];
  
  // Custom Technical Filter Metrics
  adx: number[];
  volumeSma: (number | null)[];
  volumeRatio: number;      // Current Vol / SMA(Vol, 20)
  mtf4hITrend: number;       // Latest 4H trend direction (1 = BULL, -1 = BEAR, 0 = NEUTRAL)
  fundingRate: number;      // Current Funding Rate in % (e.g. 0.015%)
  volume24hUsdt: number;    // Simulated or actual 24H volume of asset in USDT
  ema200_4h: (number | null)[];

  // New Strategy Fields
  rsi: number[];
  macdLine: number[];
  signalLine: number[];
  macdHist: number[];
  macdColors: string[];
  atr: number[];
}

// 2b. Standard Deviation (STDEV)
export function stdev(data: number[], period: number): (number | null)[] {
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

// 2a. Simple Moving Average (SMA)
export function sma(data: number[], period: number): (number | null)[] {
  if (data.length < period) return Array(data.length).fill(null);
  const result: (number | null)[] = Array(period - 1).fill(null);
  let s = 0;
  for (let i = 0; i < period; i++) {
    s += data[i];
  }
  result.push(s / period);
  for (let i = period; i < data.length; i++) {
    s += data[i] - data[i - period];
    result.push(s / period);
  }
  return result;
}

// 2b. Exponential Moving Average (EMA)
export function ema(data: number[], period: number): (number | null)[] {
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

// 2c. Bollinger Bands (BB)
export function bollingerBands(
  data: number[],
  period: number,
  dev: number
): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(data, period);
  const std = stdev(data, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < data.length; i++) {
    const m = mid[i];
    const s = std[i];
    if (m !== null && s !== null) {
      upper.push(m + dev * s);
      lower.push(m - dev * s);
    } else {
      upper.push(null);
      lower.push(null);
    }
  }

  return { mid, upper, lower };
}

/**
 * Robust Wilder's ADX (Average Directional Index) 14-period implementation
 */
export function calculateADX(candles: Candle[], period: number = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = candles.length;
  const adxList = Array(n).fill(0);
  const plusDIList = Array(n).fill(0);
  const minusDIList = Array(n).fill(0);

  if (n < period * 2) return { adx: adxList, plusDI: plusDIList, minusDI: minusDIList };

  const tr = Array(n).fill(0);
  const plusDM = Array(n).fill(0);
  const minusDM = Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;
    const prevClose = candles[i - 1].close;

    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );

    plusDM[i] = (highDiff > lowDiff && highDiff > 0) ? highDiff : 0;
    minusDM[i] = (lowDiff > highDiff && lowDiff > 0) ? lowDiff : 0;
  }

  // Initial Smoothed values (Simple sum)
  let str = tr.slice(1, period + 1).reduce((sum, v) => sum + v, 0);
  let sPlusDM = plusDM.slice(1, period + 1).reduce((sum, v) => sum + v, 0);
  let sMinusDM = minusDM.slice(1, period + 1).reduce((sum, v) => sum + v, 0);

  const dxList = Array(n).fill(0);

  const calculateDIAndDX = (idx: number, sr: number, sp: number, sm: number) => {
    if (sr === 0) {
      plusDIList[idx] = 0;
      minusDIList[idx] = 0;
    } else {
      plusDIList[idx] = (sp / sr) * 100;
      minusDIList[idx] = (sm / sr) * 100;
    }
    const dip = plusDIList[idx];
    const dim = minusDIList[idx];
    const sum = dip + dim;
    dxList[idx] = sum === 0 ? 0 : (Math.abs(dip - dim) / sum) * 100;
  };

  calculateDIAndDX(period, str, sPlusDM, sMinusDM);

  // Wilder's Smoothing Technique
  for (let i = period + 1; i < n; i++) {
    str = str - (str / period) + tr[i];
    sPlusDM = sPlusDM - (sPlusDM / period) + plusDM[i];
    sMinusDM = sMinusDM - (sMinusDM / period) + minusDM[i];
    calculateDIAndDX(i, str, sPlusDM, sMinusDM);
  }

  // Calculate ADX (smoothed DX)
  let dxSum = dxList.slice(period, period * 2).reduce((sum, v) => sum + v, 0);
  adxList[period * 2 - 1] = dxSum / period;

  for (let i = period * 2; i < n; i++) {
    adxList[i] = (adxList[i - 1] * (period - 1) + dxList[i]) / period;
  }

  // Clean backfill
  for (let i = 0; i < period * 2 - 1; i++) {
    adxList[i] = adxList[period * 2 - 1] || 0;
    plusDIList[i] = plusDIList[period] || 0;
    minusDIList[i] = minusDIList[period] || 0;
  }

  return { adx: adxList, plusDI: plusDIList, minusDI: minusDIList };
}

/**
 * Downsamples 1H klines into standard 4H klines
 */
export function aggregateTo4Hour(candles: Candle[]): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i < candles.length; i += 4) {
    const chunk = candles.slice(i, i + 4);
    if (chunk.length === 0) continue;
    const open = chunk[0].open ?? chunk[0].close;
    const close = chunk[chunk.length - 1].close;
    const high = Math.max(...chunk.map(c => c.high));
    const low = Math.min(...chunk.map(c => c.low));
    
    // Sum volumes
    const volume = chunk.reduce((sum, c) => sum + (c.volume || 0), 0);
    const quoteVolume = chunk.reduce((sum, c) => sum + (c.quoteVolume || 0), 0);

    result.push({
      time: chunk[0].time,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume
    });
  }
  return result;
}

/**
 * Lightweight, non-recursive iTrend calculator for 4-hour trend checks (avoids Stack Overflow)
 */
export function calculateITrendOnly(candles: Candle[], period: number, dev: number): number[] {
  const n = candles.length;
  if (n === 0) return [];
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const { upper, lower } = bollingerBands(closes, period, dev);

  const bbSignals = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const up = upper[i];
    const lw = lower[i];
    if (up !== null && closes[i] > up) {
      bbSignals[i] = 1;
    } else if (lw !== null && closes[i] < lw) {
      bbSignals[i] = -1;
    }
  }

  const trendLine = Array(n).fill(0);
  const iTrend = Array(n).fill(0);

  if (n > 0) {
    trendLine[0] = closes[0];
    iTrend[0] = 0;
  }

  for (let i = 1; i < n; i++) {
    const s = bbSignals[i];
    let dir = iTrend[i - 1];
    if (s === 1) {
      dir = 1;
    } else if (s === -1) {
      dir = -1;
    }
    iTrend[i] = dir;

    if (dir === 1) {
      const prevTrendVal = trendLine[i - 1];
      const currentLow = lows[i];
      if (iTrend[i - 1] <= 0) {
        trendLine[i] = currentLow;
      } else {
        trendLine[i] = currentLow > prevTrendVal ? currentLow : prevTrendVal;
      }
    } else if (dir === -1) {
      const prevTrendVal = trendLine[i - 1];
      const currentHigh = highs[i];
      if (iTrend[i - 1] >= 0) {
        trendLine[i] = currentHigh;
      } else {
        trendLine[i] = currentHigh < prevTrendVal ? currentHigh : prevTrendVal;
      }
    } else {
      trendLine[i] = trendLine[i - 1];
    }
  }

  return iTrend;
}

export function getCoinBase24hVolume(symbol: string): number {
  const s = symbol.toUpperCase().replace("USDT", "");
  const volumes: Record<string, number> = {
    BTC: 890000000,
    ETH: 450000000,
    SOL: 290000000,
    BNB: 150000000,
    XRP: 58000000,
    ADA: 32000000,
    DOGE: 94000000,
    PEPE: 110000000,
    WIF: 54000000,
    SUI: 68000000,
    APT: 42000000,
    ARB: 38000000,
    OP: 29050000,
    TIA: 19500000, // Small cap < $20M for testing rejections
    NOT: 24000000,
    LTC: 45000000,
    LINK: 35000000,
    DOT: 22000000,
    NEAR: 28000000,
    AVAX: 34000000,
    APE: 8500000 // Small cap < $20M
  };
  return volumes[s] || 25000000;
}

export function getCoinFundingRate(symbol: string, currentBias: number): number {
  const hash = symbol.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  
  // Create a nice oscillator representing funding rate that shifts with bias
  // High variance occasionally triggers long/short rejections (>0.05% or <-0.05%)
  const wave = Math.sin(hash + Date.now() / 30000); // Oscillation
  
  if (currentBias === 1) {
    // Bullish LONG bias -> usually positive funding
    return hash % 4 === 0 
      ? 0.052 + wave * 0.008  // Overcrowded long (> +0.05%)
      : 0.015 + wave * 0.012; // Standard positive funding
  } else if (currentBias === -1) {
    // Bearish SHORT bias -> usually negative funding
    return hash % 5 === 0
      ? -0.054 + wave * 0.006 // Overcrowded short (< -0.05%)
      : -0.018 + wave * 0.015; // Standard negative funding
  }
  return 0.010 + wave * 0.005;
}

// Standard Relative Strength Index (RSI) calculation
export function calculateRSI(closes: number[], period: number = 14): number[] {
  const n = closes.length;
  const rsi = Array(n).fill(50);
  if (n <= period) return rsi;

  const gains = Array(n).fill(0);
  const losses = Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = diff > 0 ? diff : 0;
    losses[i] = diff < 0 ? -diff : 0;
  }

  let avgGain = gains.slice(1, period + 1).reduce((sum, val) => sum + val, 0) / period;
  let avgLoss = losses.slice(1, period + 1).reduce((sum, val) => sum + val, 0) / period;

  if (avgLoss === 0) {
    rsi[period] = 100;
  } else {
    rsi[period] = 100 - 100 / (1 + avgGain / avgLoss);
  }

  for (let i = period + 1; i < n; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    if (avgLoss === 0) {
      rsi[i] = 100;
    } else {
      rsi[i] = 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  for (let i = 0; i < period; i++) {
    rsi[i] = rsi[period];
  }

  return rsi;
}

// Moving Average Convergence Divergence (MACD) calculation with Histogram Colors
export function calculateMACD(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9
): { macdLine: number[]; signalLine: number[]; histogram: number[]; colors: string[] } {
  const n = closes.length;
  const macdLine = Array(n).fill(0);
  const signalLine = Array(n).fill(0);
  const histogram = Array(n).fill(0);
  const colors = Array(n).fill('neutral');

  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);

  for (let i = 0; i < n; i++) {
    const f = fastEma[i];
    const s = slowEma[i];
    if (f !== null && s !== null) {
      macdLine[i] = f - s;
    }
  }

  // Calculate Signal Line (EMA 9 of MACD Line)
  const sigEma = ema(macdLine, signal);
  for (let i = 0; i < n; i++) {
    const sig = sigEma[i];
    if (sig !== null) {
      signalLine[i] = sig;
      histogram[i] = macdLine[i] - sig;
    }
  }

  // Define MACD Histogram Colors
  for (let i = 1; i < n; i++) {
    const prevH = histogram[i - 1];
    const currH = histogram[i];
    if (currH > 0) {
      colors[i] = currH > prevH ? 'deep_green' : 'light_green';
    } else if (currH < 0) {
      colors[i] = currH < prevH ? 'deep_red' : 'light_red';
    } else {
      colors[i] = 'neutral';
    }
  }

  return { macdLine, signalLine, histogram, colors };
}

// Standard Average True Range (ATR) calculation
export function calculateATR(candles: Candle[], period: number = 14): number[] {
  const n = candles.length;
  const atr = Array(n).fill(0);
  if (n === 0) return atr;

  const tr = Array(n).fill(0);
  tr[0] = candles[0].high - candles[0].low;

  for (let i = 1; i < n; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
  }

  let atrSum = tr.slice(0, period).reduce((sum, v) => sum + v, 0);
  atr[period - 1] = atrSum / period;

  for (let i = period; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  for (let i = 0; i < period - 1; i++) {
    atr[i] = atr[period - 1];
  }

  return atr;
}

// 2d. TrendLine & iTrend & Signals Simulation
export function calculateSrade(
  candles: Candle[],
  period: number = 80,
  dev: number = 2.0,
  symbol: string = 'BTC'
): IndicatorResult {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const n = candles.length;

  const { mid, upper, lower } = bollingerBands(closes, period, dev);

  // 1a. BBSignal calculation
  const bbSignals = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const up = upper[i];
    const lw = lower[i];
    if (up !== null && closes[i] > up) {
      bbSignals[i] = 1;
    } else if (lw !== null && closes[i] < lw) {
      bbSignals[i] = -1;
    }
  }

  // 1b & 1c. TrendLine & iTrend calculation for backward compatibility
  const trendLine = Array(n).fill(0);
  const iTrend = Array(n).fill(0);

  if (n > 0) {
    trendLine[0] = closes[0];
    iTrend[0] = 0;
  }

  for (let i = 1; i < n; i++) {
    const s = bbSignals[i];
    let dir = iTrend[i - 1];
    if (s === 1) {
      dir = 1;
    } else if (s === -1) {
      dir = -1;
    }
    iTrend[i] = dir;

    if (dir === 1) {
      const prevTrendVal = trendLine[i - 1];
      const currentLow = lows[i];
      if (iTrend[i - 1] <= 0) {
        trendLine[i] = currentLow;
      } else {
        trendLine[i] = currentLow > prevTrendVal ? currentLow : prevTrendVal;
      }
    } else if (dir === -1) {
      const prevTrendVal = trendLine[i - 1];
      const currentHigh = highs[i];
      if (iTrend[i - 1] >= 0) {
        trendLine[i] = currentHigh;
      } else {
        trendLine[i] = currentHigh < prevTrendVal ? currentHigh : prevTrendVal;
      }
    } else {
      trendLine[i] = trendLine[i - 1];
    }
  }

  // ---- NEW STRATEGY CALCULATIONS ----
  const rsi = calculateRSI(closes, 14);
  const { macdLine, signalLine, histogram: macdHist, colors: macdColors } = calculateMACD(closes, 12, 26, 9);
  const atr = calculateATR(candles, 14);

  // 1d. Entry Signals matching:
  // - LONG: RSI < 30 & MACD shifts from deep red to light red
  // - SHORT: RSI > 70 (overbought) & MACD shifts from deep green to light green
  const signals: ('LONG' | 'SHORT' | null)[] = Array(n).fill(null);
  for (let i = 2; i < n; i++) {
    const currentRsi = rsi[i];
    
    // Check MACD shifts
    const prevColor = macdColors[i - 1];
    const currColor = macdColors[i];

    const isMacdBullishShift = (prevColor === 'deep_red' && currColor === 'light_red');
    const isMacdBearishShift = (prevColor === 'deep_green' && currColor === 'light_green');

    // Relaxed RSI conditions for higher frequency
    if (currentRsi <= 45 && isMacdBullishShift) {
      signals[i] = 'LONG';
    } else if (currentRsi >= 55 && isMacdBearishShift) {
      signals[i] = 'SHORT';
    }
  }

  // Adjust TrendLine or iTrend visualization to match the new strategy
  // Let iTrend trace the last active signal bias for chart visual purity
  let lastBias = 0;
  for (let i = 0; i < n; i++) {
    if (signals[i] === 'LONG') {
      lastBias = 1;
    } else if (signals[i] === 'SHORT') {
      lastBias = -1;
    }
    if (lastBias !== 0) {
      iTrend[i] = lastBias;
    }
  }

  // ----- CALCULATE NEW FILTER METRICS -----
  const { adx } = calculateADX(candles, 14);
  const baseVol24h = getCoinBase24hVolume(symbol);
  
  const volumes = candles.map((c, i) => {
    if (c.volume !== undefined && c.volume > 0) return c.volume;
    const cycle = Math.sin(i / 10) * 0.4 + 1.0;
    return (baseVol24h / 24) * cycle * (0.8 + Math.random() * 0.4);
  });

  const volumeSma = sma(volumes, 20);
  const latestVol = volumes[volumes.length - 1] || 1000;
  const latestVolSma = volumeSma[volumeSma.length - 1] || 1000;
  const volumeRatio = latestVol / latestVolSma;

  const candles4h = aggregateTo4Hour(candles);
  const bbPeriod4h = Math.max(10, Math.round(period / 4));
  const iTrend4h = calculateITrendOnly(candles4h, bbPeriod4h, dev);
  const mtf4hITrend = iTrend4h.length > 0 ? iTrend4h[iTrend4h.length - 1] : 0;

  const currentBias = iTrend[iTrend.length - 1] || 0;
  const fundingRate = getCoinFundingRate(symbol, currentBias);
  const volume24hUsdt = baseVol24h * (0.9 + Math.sin(Date.now() / 100000) * 0.1);

  const ema200_4h = ema(closes, 800);

  return {
    mid,
    upper,
    lower,
    bbSignals,
    trendLine,
    iTrend,
    signals,
    adx,
    volumeSma,
    volumeRatio,
    mtf4hITrend,
    fundingRate,
    volume24hUsdt,
    ema200_4h,
    rsi,
    macdLine,
    signalLine,
    macdHist,
    macdColors,
    atr,
  };
}
