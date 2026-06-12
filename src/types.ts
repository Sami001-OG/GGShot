export type TradeDirection = 'LONG' | 'SHORT';
export type TradeStatus = 'ACTIVE' | 'WIN' | 'LOSS';

export interface ActiveTrade {
  id: string;
  symbol: string;
  direction: TradeDirection;
  entry: number;
  tp: number;
  tps: [number, number, number, number];
  sl: number;
  currentPrice: number;
  size: number;
  risk: number;
  destiny?: 'WIN' | 'LOSS';
  realizedTps?: boolean[];
  initialSize?: number;
  partialPnlRealized?: number;
}

export interface ClosedTrade extends ActiveTrade {
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  status: TradeStatus;
  timestamp: number;
}
