/**
 * GG-SHOT Strategy Config (ggshot_1h_config.py exact replication)
 * Custom optimization configs for tracked Binance Futures pairs
 */

export interface CoinConfig {
  bbPeriod: number;
  bbDev: number;
  tp: [number, number, number, number];
  sl: number;
  alloc: [number, number, number, number];
  risk: number;
}

export const DEFAULT_CONFIG: CoinConfig = {
  bbPeriod: 140,
  bbDev: 2.5,
  tp: [4, 7, 10, 15],
  sl: 4,
  alloc: [40, 30, 20, 10],
  risk: 0.8
};

export const COIN_CONFIGS: Record<string, CoinConfig> = {
  APE: {
    bbPeriod: 180,
    bbDev: 3.0,
    tp: [5, 9, 13, 18],
    sl: 4,
    alloc: [40, 30, 20, 10],
    risk: 1.0
  },
  BTC: {
    bbPeriod: 100,
    bbDev: 2.0,
    tp: [2, 4, 7, 12],
    sl: 3,
    alloc: [50, 25, 15, 10],
    risk: 0.5
  },
  ETH: {
    bbPeriod: 120,
    bbDev: 2.0,
    tp: [3, 5, 8, 12],
    sl: 4,
    alloc: [40, 30, 20, 10],
    risk: 0.6
  },
  SOL: {
    bbPeriod: 140,
    bbDev: 2.5,
    tp: [4, 7, 10, 15],
    sl: 4,
    alloc: [70, 15, 10, 5],
    risk: 0.8
  },
  DOGE: {
    bbPeriod: 160,
    bbDev: 2.5,
    tp: [5, 9, 13, 18],
    sl: 5,
    alloc: [50, 25, 15, 10],
    risk: 0.7
  },
  PEPE: {
    bbPeriod: 60,
    bbDev: 3.0,
    tp: [6, 11, 16, 22],
    sl: 6,
    alloc: [40, 30, 20, 10],
    risk: 0.9
  },
  WIF: {
    bbPeriod: 80,
    bbDev: 3.0,
    tp: [5, 10, 15, 20],
    sl: 4,
    alloc: [25, 25, 25, 25],
    risk: 0.75
  },
  SUI: {
    bbPeriod: 120,
    bbDev: 2.5,
    tp: [4, 8, 12, 18],
    sl: 4,
    alloc: [50, 25, 15, 10],
    risk: 0.8
  },
  XRP: {
    bbPeriod: 140,
    bbDev: 2.0,
    tp: [3, 5, 8, 12],
    sl: 3,
    alloc: [40, 30, 20, 10],
    risk: 0.6
  },
  ADA: {
    bbPeriod: 150,
    bbDev: 2.2,
    tp: [3, 6, 9, 14],
    sl: 3,
    alloc: [50, 25, 15, 10],
    risk: 0.7
  }
};
