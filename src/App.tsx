import { useEffect, useState, ReactNode, useMemo, useRef, Dispatch, SetStateAction } from 'react';
import { 
  Activity, 
  Wallet, 
  TrendingUp, 
  Trophy, 
  RefreshCw, 
  Coins, 
  Sliders, 
  AlertCircle,
  Clock,
  Play,
  Pause,
  FastForward,
  Terminal as TerminalIcon,
  Sparkles,
  ChevronRight,
  TrendingDown,
  Target,
  Send,
  Check,
  Bell,
  Search,
  Database
} from 'lucide-react';
import { ActiveTradeCard } from './components/ActiveTradeCard';
import { DailyPerformance } from './components/DailyPerformance';
import { ActiveTrade, ClosedTrade } from './types';
import { calculateSrade } from './lib/indicators';
import { COIN_CONFIGS, DEFAULT_CONFIG } from './lib/srade_1h_config';
import { 
  MONITORED_COINS
} from './lib/simulation';
import { cn, formatPrice } from './lib/utils';
import { AnimatePresence, motion } from 'motion/react';

const MAJOR_FUTURES = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'PEPE', 'WIF', 'SUI', 
  'APT', 'ARB', 'OP', 'TIA', 'NOT', 'LTC', 'LINK', 'DOT', 'NEAR', 'AVAX'
];

interface Stats {
  balance: number;
  won: number;
  lost: number;
  totalPnl: number;
}

interface BinanceStatus {
  configured: boolean;
  keyMask: string;
  secretMask: string;
  binanceUrl: string;
  serverTime: string;
}

function usePersistentState<T>(key: string, initialValue: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch (error) {
      console.warn(`Error setting localStorage key "${key}":`, error);
    }
  }, [key, state]);

  return [state, setState];
}

export default function App() {
  // Real-time market state for ALL 10 coins
  const [coinsCandles, setCoinsCandles] = useState<Record<string, any[]>>({});
  const [activeTrades, setActiveTrades] = useState<ActiveTrade[]>([]);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>([]);
  const [stats, setStats] = useState<Stats>({
    balance: 10000,
    won: 0,
    lost: 0,
    totalPnl: 0,
  });

  // Technical Algorithmic Defence Gates Toggles (Persisted via memory)
  const [filterAdx, setFilterAdx] = usePersistentState('srade_filterAdx', true);
  const [filterMtf, setFilterMtf] = usePersistentState('srade_filterMtf', true);
  const [filterEma, setFilterEma] = usePersistentState('srade_filterEma', true);
  const [filterVolume, setFilterVolume] = usePersistentState('srade_filterVolume', true);
  const [filterFunding, setFilterFunding] = usePersistentState('srade_filterFunding', true);
  const [filterLiquidity, setFilterLiquidity] = usePersistentState('srade_filterLiquidity', true);

  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [wsPackets, setWsPackets] = useState<string[]>([]);

  // Binance API Connection States
  const [binanceStatus, setBinanceStatus] = useState<BinanceStatus | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [apiError, setApiError] = useState<string | null>(null);

  const livePricesRef = useRef<Record<string, number>>({});
  useEffect(() => {
    livePricesRef.current = livePrices;
  }, [livePrices]);
  
  // Graph focus
  const [selectedCoin, setSelectedCoin] = useState<string>('SOL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Strict mode / double execution safeguard refs
  const processedEventKeys = useRef<Set<string>>(new Set());

  // Telegram Integration States (Environment Variables on backend only for 100% security)
  const [tgEnabled, setTgEnabled] = useState<boolean>(() => localStorage.getItem('tg_enabled') === 'true');
  const [tgBackendStatus, setTgBackendStatus] = useState<{ configured: boolean } | null>(null);
  const [tgTestStatus, setTgTestStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [tgSending, setTgSending] = useState(false);

  const [healing, setHealing] = useState(false);
  const [healMessage, setHealMessage] = useState<string | null>(null);

  const triggerFullSync = () => {
    fetch('/api/db/state')
      .then(res => res.json())
      .then(data => {
        if (!data.error) {
          if (data.activeTrades) {
            setActiveTrades(prev => {
              return data.activeTrades.map((t: any) => {
                const existing = prev.find((p: any) => p.id === t.id || p.dbId === t.dbId);
                const livePrice = livePricesRef.current[t.symbol] ?? existing?.currentPrice ?? t.currentPrice;
                return {
                  ...t,
                  currentPrice: livePrice
                };
              });
            });
          }
          if (data.closedTrades) setClosedTrades(data.closedTrades);
          if (data.stats) setStats(data.stats);
          if (data.logs) setTerminalLogs(data.logs);
        }
      })
      .catch(() => {});
  };

  const handleHealDatabase = async () => {
    setHealing(true);
    setHealMessage(null);
    try {
      const res = await fetch('/api/admin/heal');
      const data = await res.json();
      if (data.success) {
        setHealMessage("Database healed!");
        writeLog("[DATABASE HEALER] Success: Existing trade records and system state successfully healed.");
        triggerFullSync();
      } else {
        setHealMessage(data.error || "Failed to heal");
      }
    } catch (e: any) {
      setHealMessage("Network error");
    } finally {
      setHealing(false);
      setTimeout(() => setHealMessage(null), 6000);
    }
  };

  // Fetch server status config
  const reloadTelegramStatus = () => {
    fetch('/api/telegram/status')
      .then(res => res.json())
      .then(data => {
        setTgBackendStatus(data);
        if (data.configured && localStorage.getItem('tg_enabled') === null) {
          setTgEnabled(true);
          localStorage.setItem('tg_enabled', 'true');
        }
      })
      .catch(() => {});
  };

  const loadedStateDb = useRef<boolean>(false);

  useEffect(() => {
    reloadTelegramStatus();
    
    // Load state from DB
    fetch('/api/db/state')
      .then(res => res.json())
      .then(data => {
        if (!data.error) {
          if (data.activeTrades) setActiveTrades(data.activeTrades);
          if (data.closedTrades) setClosedTrades(data.closedTrades);
          if (data.stats) setStats(data.stats);
          if (data.logs) setTerminalLogs(data.logs);
          if (data.filterAdx !== undefined) setFilterAdx(data.filterAdx);
          if (data.filterMtf !== undefined) setFilterMtf(data.filterMtf);
          if (data.filterEma !== undefined) setFilterEma(data.filterEma);
          if (data.filterVolume !== undefined) setFilterVolume(data.filterVolume);
          if (data.filterFunding !== undefined) setFilterFunding(data.filterFunding);
          if (data.filterLiquidity !== undefined) setFilterLiquidity(data.filterLiquidity);
        }
        loadedStateDb.current = true;
      })
      .catch((err) => {
        console.error("Failed to load DB state:", err);
        loadedStateDb.current = true;
      });
  }, []);

  const closedTradesRef = useRef<ClosedTrade[]>([]);
  useEffect(() => {
    closedTradesRef.current = closedTrades;
  }, [closedTrades]);

  // Periodic state sync from DB (for backend-generated trades)
  useEffect(() => {
    const syncInterval = setInterval(() => {
      if (!loadedStateDb.current) return;
      fetch('/api/db/state')
        .then(res => res.json())
        .then(data => {
          if (!data.error) {
            if (data.activeTrades) {
              setActiveTrades(prev => {
                return data.activeTrades.map((t: any) => {
                  const existing = prev.find((p: any) => p.id === t.id || p.dbId === t.dbId);
                  const livePrice = livePricesRef.current[t.symbol] ?? existing?.currentPrice ?? t.currentPrice;
                  return {
                    ...t,
                    currentPrice: livePrice
                  };
                });
              });
            }
            if (data.closedTrades) setClosedTrades(data.closedTrades);
            if (data.stats) setStats(data.stats);
            if (data.logs) {
              setTerminalLogs(prev => {
                const prevSet = new Set(prev);
                const newLogs = data.logs.filter((l: string) => !prevSet.has(l));
                if (newLogs.length > 0) {
                   return [...newLogs, ...prev].slice(0, 40);
                }
                return prev;
              });
            }
          }
        })
        .catch(console.error);
    }, 3000);
    return () => clearInterval(syncInterval);
  }, []);

  // Sync state to DB on change
  useEffect(() => {
    if (!loadedStateDb.current) return;
    
    const timeout = setTimeout(() => {
      fetch('/api/db/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeTrades,
          closedTrades,
          stats,
          logs: terminalLogs,
          filterAdx,
          filterMtf,
          filterEma,
          filterVolume,
          filterFunding,
          filterLiquidity
        })
      }).catch(err => console.error("Failed to save DB state:", err));
    }, 1000); // 1-second debounce
    
    return () => clearTimeout(timeout);
  }, [activeTrades, closedTrades, stats, terminalLogs, filterAdx, filterMtf, filterEma, filterVolume, filterFunding, filterLiquidity]);

  const saveTelegramConfig = (enabled: boolean) => {
    setTgEnabled(enabled);
    localStorage.setItem('tg_enabled', enabled ? 'true' : 'false');
    writeLog(`[TELEGRAM] Saved. Notification relay is ${enabled ? 'ACTIVE' : 'INACTIVE'}.`);
  };

  const sendTelegramNotification = async (htmlMessage: string, imageType?: "LONG" | "SHORT") => {
    if (!tgEnabled) {
      console.log('Telegram NOT sent - tgEnabled is false');
      return;
    }
    if (!tgBackendStatus?.configured) {
      console.log('Telegram NOT sent - tgBackendStatus.configured is false');
      return;
    }

    try {
      const res = await fetch('/api/telegram/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: htmlMessage,
          imageType
        })
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('Telegram endpoint returned error:', data.message);
      } else {
        console.log('Telegram notification sent successfully');
      }
    } catch (err) {
      console.error('Failed to dispatch telegram notification:', err);
    }
  };

  const handleTestTelegram = async () => {
    setTgSending(true);
    setTgTestStatus(null);
    try {
      const response = await fetch('/api/telegram/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `🛡️ <b>Srade Connection Verified!</b>\n\nYour Discord / Telegram notification bridge is live!\n⏰ <b>Time:</b> ${new Date().toLocaleString()}\n🟢 This channel will now monitor all breakout signals and scaling events.`
        })
      });
      const data = await response.json();
      if (data.success) {
        setTgTestStatus({ success: true, message: 'Success! Verify by checking your Telegram Channel/Chat.' });
        writeLog('[TELEGRAM TEST] Sent test packet to Telegram Servers successfully.');
      } else {
        setTgTestStatus({ success: false, message: data.message || 'Verification packet refused.' });
        writeLog(`[TELEGRAM ERROR] ${data.message || 'Unknown error code'}`);
      }
    } catch (err: any) {
      setTgTestStatus({ success: false, message: err.message || 'Network exception.' });
    } finally {
      setTgSending(false);
    }
  };

  // Multi-terminal log logger
  const writeLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setTerminalLogs(prev => [`[${timestamp}] ${msg}`, ...prev].slice(0, 40));
  };

  // Helper to persist trade closure to MongoDB
  const persistTradeUpdate = (dbId: string | undefined, exitPrice: number, pnlPercent: number, status: string) => {
    if (!dbId) return;
    fetch("/api/trades/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dbId, exitPrice, pnlPercent, status
      })
    }).catch(err => writeLog(`[DB UPDATE ERROR] Failed to close trade ${dbId}: ${err.message}`));
  };

  // Master position update handler following high-fidelity PineScript specification
  const processTradeUpdate = (
    trade: ActiveTrade, 
    currentPrice: number, 
    reversalTriggered?: boolean
  ): { nextActive: ActiveTrade | null; closedTrade: ClosedTrade | null } => {
    const isLong = trade.direction === 'LONG';
    const entry = trade.entry;
    const initialSize = trade.initialSize ?? trade.size;
    let currentSize = trade.size;
    let realizedTps = [...(trade.realizedTps ?? [false, false, false, false])];
    let partialPnlRealized = trade.partialPnlRealized ?? 0;
    const displayId = trade.dbId || trade.id;

    const config = COIN_CONFIGS[trade.symbol] || DEFAULT_CONFIG;
    const alloc = config.alloc;

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

      const closed: ClosedTrade = {
        ...trade,
        currentPrice,
        size: currentSize,
        exitPrice: slBound,
        pnl: totalPnl,
        pnlPercent: finalPercent,
        status: isTrailingStop ? 'WIN' : 'LOSS',
        timestamp: Date.now()
      };

      if (!processedEventKeys.current.has(`${trade.id}-exit`)) {
        processedEventKeys.current.add(`${trade.id}-exit`);

        setStats(s => ({
          balance: s.balance + remainingPnl,
          won: s.won + (totalPnl > 0 ? 1 : 0),
          lost: s.lost + (totalPnl <= 0 ? 1 : 0),
          totalPnl: s.totalPnl + remainingPnl
        }));

        writeLog(`[${isTrailingStop ? 'TRAILING STOP' : 'STOP LOSS'} HIT] ${trade.symbol} ${trade.direction} hit SL at ${formatPrice(slBound)}! Yield: ${finalPercent >= 0 ? '+' : ''}${finalPercent.toFixed(2)}%`);
        
        persistTradeUpdate(trade.dbId, slBound, finalPercent, isTrailingStop ? 'WIN' : 'LOSS');

        sendTelegramNotification(
          `${trade.symbol} hit SL`
        ).catch(() => {});
      }

      return { nextActive: null, closedTrade: closed };
    }

    // 2. Check reversal exit
    if (reversalTriggered) {
      const remainingPnl = (currentSize * (isLong ? (currentPrice - entry) : (entry - currentPrice))) / entry;
      const totalPnl = partialPnlRealized + remainingPnl;
      const finalPercent = (totalPnl / initialSize) * 100;
      const status = totalPnl > 0 ? 'WIN' : 'LOSS';

      const closed: ClosedTrade = {
        ...trade,
        currentPrice,
        size: currentSize,
        exitPrice: currentPrice,
        pnl: totalPnl,
        pnlPercent: finalPercent,
        status: status as any,
        timestamp: Date.now()
      };

      if (!processedEventKeys.current.has(`${trade.id}-exit`)) {
        processedEventKeys.current.add(`${trade.id}-exit`);

        setStats(s => ({
          balance: s.balance + remainingPnl,
          won: s.won + (totalPnl > 0 ? 1 : 0),
          lost: s.lost + (totalPnl <= 0 ? 1 : 0),
          totalPnl: s.totalPnl + remainingPnl
        }));

        writeLog(`[REVERSAL EXIT] ${trade.symbol} ${trade.direction} trend flipped! Exited remaining at ${formatPrice(currentPrice)}. Yield: ${finalPercent >= 0 ? '+' : ''}${finalPercent.toFixed(2)}%`);
        
        persistTradeUpdate(trade.dbId, currentPrice, finalPercent, status);

        sendTelegramNotification(
          `${trade.symbol} hit SL`
        ).catch(() => {});
      }

      return { nextActive: null, closedTrade: closed };
    }

    // 3. Scan take-profit levels sequentially
    let immediateCompleteClose = false;
    let actualDeltaPnl = 0;

    for (let i = 0; i < 4; i++) {
      if (realizedTps[i]) continue;

      const targetPrice = trade.tps[i];
      const hitTarget = isLong ? currentPrice >= targetPrice : currentPrice <= targetPrice;
      
      // Strict mathematical constraint: require price to genuinely advance into profit
      const isValidMove = isLong ? currentPrice > entry * 1.0005 : currentPrice < entry * 0.9995;

      if (hitTarget && isValidMove) {
        realizedTps[i] = true;
        const partShare = alloc[i] / 100;
        const partSize = initialSize * partShare;
        
        // Calculate PnL of this partial part
        const partPnl = (partSize * (isLong ? (targetPrice - entry) : (entry - targetPrice))) / entry;
        
        // Deduplicate target hits
        const tpKey = `${trade.id}-tp${i}`;
        if (!processedEventKeys.current.has(tpKey)) {
          processedEventKeys.current.add(tpKey);
          actualDeltaPnl += partPnl;
          writeLog(`[PARTIAL TP${i+1} HIT] ${trade.symbol} scaled out ${alloc[i]}% of units at ${formatPrice(targetPrice)}!`);
          
          let nextSlText = '';
          if (i === 0) nextSlText = 'breakeven';
          else if (i === 1) nextSlText = 'TP1';
          else if (i === 2) nextSlText = 'TP2';
          else if (i === 3) nextSlText = 'TP3';

          sendTelegramNotification(
            `${trade.symbol} hit TP${i+1}\n` +
            `SL to ${nextSlText}`
          ).catch(() => {});
        }
        
        partialPnlRealized += partPnl;

        // Shrink active size
        currentSize = Math.max(0, currentSize - partSize);

        if (i === 3) {
          immediateCompleteClose = true;
        }
      }
    }

    if (actualDeltaPnl !== 0) {
      setStats(s => ({
        ...s,
        balance: s.balance + actualDeltaPnl,
        totalPnl: s.totalPnl + actualDeltaPnl
      }));
    }

    if (immediateCompleteClose || currentSize <= 0.01) {
      const finalPercent = (partialPnlRealized / initialSize) * 100;
      const closed: ClosedTrade = {
        ...trade,
        currentPrice,
        size: 0,
        exitPrice: trade.tps[3],
        pnl: partialPnlRealized,
        pnlPercent: finalPercent,
        status: 'WIN',
        timestamp: Date.now()
      };

      if (!processedEventKeys.current.has(`${trade.id}-exit`)) {
        processedEventKeys.current.add(`${trade.id}-exit`);

        setStats(s => ({
          ...s,
          won: s.won + 1
        }));

        writeLog(`[TP4 COMPLETED] ${trade.symbol} target cycle achieved! Net PnL: +${finalPercent.toFixed(2)}%`);
        
        persistTradeUpdate(trade.dbId, trade.tps[3], finalPercent, 'WIN');

        sendTelegramNotification(
          `${trade.symbol} hit TP4\n` +
          `SL to TP3`
        ).catch(() => {});
      }

      return { nextActive: null, closedTrade: closed };
    }

    // Re-calculate Trailing Stop Loss Logic after TPs
    let newSlBound = trade.sl;
    if (realizedTps[2]) newSlBound = trade.tps[1];      // TP3 hit -> SL to TP2
    else if (realizedTps[1]) newSlBound = trade.tps[0]; // TP2 hit -> SL to TP1
    else if (realizedTps[0]) newSlBound = entry;        // TP1 hit -> SL to BE

    // Otherwise, keep the active position alive but updated
    const nextActive: ActiveTrade = {
      ...trade,
      sl: newSlBound,
      currentPrice,
      size: currentSize,
      realizedTps,
      partialPnlRealized
    };

    return { nextActive, closedTrade: null };
  };

  // Helper to instantly reconcile positions when live rates change
  const checkRealPriceExits = (prices: Record<string, number>) => {
    setActiveTrades(prevTrades => {
      return prevTrades.map(trade => {
        const currentPrice = prices[trade.symbol];
        if (currentPrice === undefined) return trade;
        return {
          ...trade,
          currentPrice
        };
      });
    });
  };

  // Fetch Binance API parameters
  const fetchBinanceData = async () => {
    try {
      setApiError(null);
      const statusRes = await fetch('/api/binance/status');
      const statusData = await statusRes.json();
      setBinanceStatus(statusData);

      const pricesRes = await fetch('/api/binance/prices');
      const pricesData = await pricesRes.json();
      if (pricesData.prices) {
        setLivePrices(pricesData.prices);
        
        // Instant check to remove positions if TP4 or SL is hit at real price
        checkRealPriceExits(pricesData.prices);

        // Feed the live rates into the technical analysis candles
        setCoinsCandles(prev => {
          const next = { ...prev };
          let updated = false;
          Object.entries(pricesData.prices).forEach(([coin, price]) => {
            if (next[coin]) {
              const list = [...next[coin]];
              if (list.length > 0) {
                const last = { ...list[list.length - 1] };
                last.close = price as number;
                list[list.length - 1] = last;
                next[coin] = list;
                updated = true;
              }
            }
          });
          return updated ? next : prev;
        });
      }
      if (!pricesData.success) {
        setApiError("Failed to fetch Binance data");
      }
    } catch (e: any) {
      setApiError("Offline mode - cannot connect to API");
    }
  };

  useEffect(() => {
    // Multi-Asset Real-Time Simultaneous Live WebSocket Stream with Dynamic Adaptive Polling
    let ws: WebSocket | null = null;
    let fallbackTimeout: any = null;
    let pollTimeout: any = null;
    let active = true;
    let isWsConnected = false;

    const pollWithDynamicInterval = async () => {
      if (!active) return;
      try {
        await fetchBinanceData();
      } catch (err) {
        // Silent catch for intermittent network blips
      }
      if (!active) return;
      // If WebSocket is active, back off REST polling to 8 seconds. 
      // If WebSocket is not connected or blocked, poll every 2 seconds for ultra-responsive updates.
      const intervalMs = isWsConnected ? 8000 : 2000;
      pollTimeout = setTimeout(pollWithDynamicInterval, intervalMs);
    };

    const connectLiveWS = () => {
      if (!active) return;
      try {
        console.log("[WS] Attempting to connect to Binance Futures Stream: wss://fstream.binance.com/ws");
        ws = new WebSocket(`wss://fstream.binance.com/ws`);
        
        ws.onopen = () => {
           console.log("[WS] Stream connection established successfully! Sending subscription request for major assets.");
           const params = MAJOR_FUTURES.map(coin => `${coin.toLowerCase()}usdt@ticker`);
           const subscribeMsg = {
             method: "SUBSCRIBE",
             params,
             id: 1
           };
           console.log("[WS] Subscribed pairs:", params);
           ws?.send(JSON.stringify(subscribeMsg));
        };

        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            
            if (payload.id !== undefined || payload.result !== undefined) {
              console.log("[WS] Received subscription confirmation message:", payload);
              return;
            }

            if (payload.e === "24hrTicker") {
              isWsConnected = true;
              const symbol = payload.s; // e.g., "BTCUSDT"
              const coin = symbol.replace("USDT", "");
              const price = parseFloat(payload.c);
              
              // Full trace logging for telemetry debugging and incoming packet structure verification
              console.log(`[WS Ticker] ${symbol} | Close: ${payload.c} | High: ${payload.h} | Low: ${payload.l} | BaseVol: ${payload.v} | EventTime: ${payload.E}`);
              
              setWsPackets(prev => {
                const log = `[WS] TICK ${symbol} @ ${price.toFixed(4)}`;
                return [log, ...prev].slice(0, 10);
              });
              
              setLivePrices(prev => {
                const next = { ...prev, [coin]: price };
                checkRealPriceExits(next);
                return next;
              });

              // Slide real-time prices into focus candle
              setCoinsCandles(prev => {
                if (prev[coin]) {
                  const list = [...prev[coin]];
                  if (list.length > 0) {
                     const last = { ...list[list.length - 1] };
                     last.close = price;
                     list[list.length - 1] = last;
                     return { ...prev, [coin]: list };
                  }
                }
                return prev;
              });
            } else {
              console.log("[WS] Received alternative message format:", payload);
            }
          } catch (err: any) {
            console.error("[WS] Error parsing websocket message event:", err.message);
          }
        };

        ws.onclose = () => {
          console.log("[WS] Socket stream closed. Reconnecting in 10 seconds...");
          isWsConnected = false;
          if (active) {
            fallbackTimeout = setTimeout(connectLiveWS, 10000);
          }
        };

        ws.onerror = (e) => {
          console.log("[WS] Direct connection not available in this environment. Seamlessly relying on high-frequency REST polling fallback.");
          isWsConnected = false;
          if (ws) ws.close();
        };

      } catch (err) {
        console.log("[WS] Direct connection initialization omitted. Seamlessly relying on high-frequency REST polling fallback.");
        isWsConnected = false;
        if (active) {
          fallbackTimeout = setTimeout(connectLiveWS, 10000);
        }
      }
    };

    // Run both tasks
    pollWithDynamicInterval();
    connectLiveWS();

    return () => {
      active = false;
      if (ws) ws.close();
      if (fallbackTimeout) clearTimeout(fallbackTimeout);
      if (pollTimeout) clearTimeout(pollTimeout);
    };
  }, []);

  // Initialize standard major futures coin history on mount, remaining pairs are added dynamically via price feeds
  useEffect(() => {
    const initializeAll = async () => {
      writeLog("SYSTEM INITIALIZATION: Connecting Srade...");
      writeLog("SYNCING MARKET DATA: Fetching 300h candle histories directly from Binance Futures API...");
      const initialCandles: Record<string, any[]> = {};
      
      // Process in chunks to avoid overwhelming the Binance API
      const chunkSize = 4;
      for (let i = 0; i < MAJOR_FUTURES.length; i += chunkSize) {
        const chunk = MAJOR_FUTURES.slice(i, i + chunkSize);
        await Promise.all(
          chunk.map(async (coin) => {
            try {
              const res = await fetch(`/api/binance/metrics/${coin}`);
              const data = await res.json();
              if (data && data.success && data.candles && data.candles.length > 0) {
                initialCandles[coin] = data.candles;
              } else {
                writeLog(`[ERROR] Failed to fetch historical data for ${coin}USDT from Binance API`);
              }
            } catch (err) {
               writeLog(`[ERROR] Failed to fetch historical data for ${coin}USDT from Binance API`);
            }
          })
        );
        // Sleep for 1000ms between chunks
        if (i + chunkSize < MAJOR_FUTURES.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      setCoinsCandles(initialCandles);
      writeLog(`SUCCESS: Seeded 300h real-market history buffers for ${Object.keys(initialCandles).length} primary pairs.`);
      writeLog("BOT SCANNER LIVE: Scanning all futures symbols...");
    };

    initializeAll();
  }, []);

  // Sync authentic 1h metrics for the active focus asset on-demand when user shifts selections
  useEffect(() => {
    if (!selectedCoin) return;
    
    let isMounted = true;
    const loadSelectedHistory = async () => {
      try {
        const res = await fetch(`/api/binance/metrics/${selectedCoin}`);
        const data = await res.json();
        if (isMounted && data && data.success && data.candles && data.candles.length > 0) {
          setCoinsCandles(prev => ({
            ...prev,
            [selectedCoin]: data.candles
          }));
          writeLog(`[MARKET SYNC] Loaded real Binance 1h klines for focus asset: ${selectedCoin}/USDT`);
        }
      } catch (err) {
        // Fallback is silent
      }
    };

    loadSelectedHistory();
    return () => { isMounted = false; };
  }, [selectedCoin]);

  // Selected coin's indicator outputs
  const coinConfig = COIN_CONFIGS[selectedCoin] || DEFAULT_CONFIG;
  const candleData = coinsCandles[selectedCoin] || [];
  
  const ggResult = useMemo(() => {
    if (candleData.length === 0) return null;
    return calculateSrade(candleData, coinConfig.bbPeriod, coinConfig.bbDev, selectedCoin);
  }, [candleData, coinConfig.bbPeriod, coinConfig.bbDev, selectedCoin]);

  const winRate = stats.won + stats.lost > 0 
    ? ((stats.won / (stats.won + stats.lost)) * 100).toFixed(1) 
    : '0.0';

  const cumulativeGainPercent = useMemo(() => {
    return closedTrades.reduce((sum, t) => sum + (t.pnlPercent || 0), 0);
  }, [closedTrades]);

  const displayedCoins = useMemo(() => {
    const query = searchQuery.trim().toUpperCase();
    const allAvailable = Object.keys(livePrices);
    
    if (query) {
      return allAvailable
        .filter(symbol => symbol.includes(query))
        .map(symbol => ({ name: symbol, price: livePrices[symbol] || 100 }));
    }

    // Default: Show major symbols, plus any coin that has an active trade, in a structured/curated set
    const activeSymbols = activeTrades.map(t => t.symbol);
    const uniqueDefaults = Array.from(new Set([...activeSymbols, ...MAJOR_FUTURES]));
    
    // Fallback if livePrices isn't loaded yet
    const sourceList = allAvailable.length > 0 ? allAvailable : MAJOR_FUTURES;
    const itemsToShow = uniqueDefaults.filter(symbol => sourceList.includes(symbol));

    return itemsToShow.map(symbol => ({
      name: symbol,
      price: livePrices[symbol] || MONITORED_COINS.find(c => c.name === symbol)?.price || 100
    }));
  }, [livePrices, searchQuery, activeTrades]);

  return (
    <div className="flex h-screen bg-[#06090e] text-slate-200 overflow-hidden font-sans">
      
      {/* 1. Slim Left Sidebar */}
      <aside className="w-[60px] lg:w-[68px] border-r border-slate-800/80 bg-[#0A0D14] flex flex-col items-center py-5 shrink-0 hidden md:flex z-50">
         <div className="flex flex-col items-center gap-6 w-full">
            <div className="h-9 w-9 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-black shadow-[0_0_10px_rgba(99,102,241,0.05)] ring-1 ring-indigo-500/20 text-sm">SR</div>
            <nav className="flex flex-col gap-3 text-slate-500 w-full px-2 lg:px-3">
               <button className="p-2.5 bg-indigo-500/10 text-indigo-400 rounded-lg transition-colors border border-indigo-500/10 flex justify-center w-full shadow-inner"><Activity size={18}/></button>
               <button className="p-2.5 hover:bg-slate-800/60 hover:text-slate-300 rounded-lg transition-colors flex justify-center w-full"><TrendingUp size={18}/></button>
               <button className="p-2.5 hover:bg-slate-800/60 hover:text-slate-300 rounded-lg transition-colors flex justify-center w-full"><Wallet size={18}/></button>
               <button className="p-2.5 hover:bg-slate-800/60 hover:text-slate-300 rounded-lg transition-colors flex justify-center w-full"><TerminalIcon size={18}/></button>
            </nav>
         </div>
         <div className="mt-auto w-full px-2 lg:px-3">
             <button className="p-2.5 hover:bg-slate-800/60 text-slate-500 hover:text-slate-300 rounded-lg transition-colors flex justify-center w-full"><Sliders size={18}/></button>
         </div>
      </aside>

      {/* 2. Main Terminal Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-[#0a0d15]">
         
         {/* Top Institutional Header */}
         <header className="h-[52px] border-b border-slate-800/80 bg-[#0A0D14]/90 flex items-center justify-between px-4 lg:px-6 shrink-0 z-40">
             <div className="flex items-center gap-5">
                 <h1 className="font-display text-[15px] font-bold text-slate-100 flex items-center gap-2 tracking-tight">Srade <span className="px-1.5 py-[3px] bg-indigo-500/15 text-indigo-400 text-[9px] uppercase tracking-widest rounded font-black border border-indigo-500/20 leading-none">PRO</span></h1>
                 <div className="h-4 w-px bg-slate-800/80 hidden sm:block"></div>
                 <div className="hidden sm:flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full border border-slate-900 outline flex bg-emerald-500 outline-emerald-500/30 animate-pulse"></span>
                    <span className="font-mono text-[9px] font-bold text-slate-400 uppercase tracking-widest pl-1">Sys: Active</span>
                 </div>
             </div>

             <div className="flex items-center gap-3 font-mono">
                 <button 
                    onClick={async () => {
                      if (!confirm("Are you sure you want to reset the entire database? This will clear all trades, stats, and logs.")) return;
                      writeLog("[SYSTEM] Initiating full database reset...");
                      try {
                        const res = await fetch("/api/db/reset", { method: "POST" });
                        const data = await res.json();
                        if (data.success) {
                          writeLog(`[SYSTEM SUCCESS] Database reset complete.`);
                          setTimeout(() => window.location.reload(), 1000);
                        } else {
                          writeLog(`[SYSTEM ERROR] Failed to reset database`);
                        }
                      } catch (err: any) {
                        writeLog(`[SYSTEM EXCEPTION] ${err.message}`);
                      }
                    }}
                    className={cn("flex items-center gap-2 px-3 py-1.5 rounded-[4px] font-bold text-[9px] uppercase tracking-widest transition-all border", "bg-rose-500/5 text-rose-400 border-rose-500/20 hover:bg-rose-500/10")}
                 >
                    <Database size={10} strokeWidth={3}/>
                    Reset System
                 </button>
             </div>
         </header>

         {/* 3. Main Dashboard Scroll Area */}
         <main className="flex-1 overflow-x-hidden overflow-y-auto custom-scrollbar p-3 md:p-5 space-y-4 md:space-y-5 bg-[#070a10]">
             
             {/* ROW 1: System Metrics Grid */}
             <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                 <PremiumStat label="Balance / Equity" value={`$${stats.balance.toFixed(2)}`} valueClass="text-slate-100" />
                 <PremiumStat label="Cumulative PnL" value={`${cumulativeGainPercent >= 0 ? '+' : ''}${cumulativeGainPercent.toFixed(2)}%`} valueClass={cumulativeGainPercent >= 0 ? "text-emerald-400" : "text-rose-400"} />
                 <PremiumStat label="Win Rate" value={`${winRate}%`} valueClass="text-slate-100" />
                 <PremiumStat label="Valid Signals" value={(stats.won + stats.lost).toString()} valueClass="text-slate-100" />
                 <PremiumStat label="Targets Hit" value={stats.won.toString()} valueClass="text-emerald-400" />
                 <PremiumStat label="System Feeds" value={`${Object.keys(livePrices).length || MAJOR_FUTURES.length}`} valueClass="text-indigo-400" />
             </div>

             {/* ROW 2 & 3: Institutional Layout */}
             <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 md:gap-5">
                
                {/* LEFT COLUMNS (8 cols) - Primary Workspace */}
                <div className="xl:col-span-8 flex flex-col gap-4 md:gap-5">
                   
                   {/* Technical Terminal Component */}
                   <div className="bg-[#0f131c] border border-slate-800/60 rounded-lg overflow-hidden shadow-sm flex flex-col">
                       <div className="p-3.5 px-4 border-b border-slate-800/60 flex justify-between items-center bg-[#0d1017]">
                          <div className="flex items-center gap-3">
                             <h2 className="text-[13px] font-semibold text-slate-200 flex items-center gap-2">
                               <Sliders size={14} className="text-indigo-400"/> Technical Terminal
                             </h2>
                             <button 
                               onClick={() => {
                                 setTerminalLogs(prev => [`[${new Date().toLocaleTimeString()}] Triggering backend autonomous scan...`, ...prev].slice(0, 40));
                                 fetch('/api/cron').then(r => r.json()).then(d => {
                                   setTerminalLogs(prev => [`[${new Date().toLocaleTimeString()}] Scan complete: ${d.message}`, ...prev].slice(0, 40));
                                 }).catch(e => console.error(e));
                               }}
                               className="ml-4 text-[9px] font-mono bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-2 py-1 rounded hover:bg-indigo-500/30 transition-colors flex items-center gap-1.5 uppercase tracking-widest font-bold"
                             >
                               Force Scan
                             </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-4 text-xs font-mono bg-[#070a10] border border-slate-800/60 rounded-md px-2 py-1 shadow-inner">
                            <div className="flex items-center gap-2">
                               <span className="text-[9px] text-slate-500 leading-none">ASSET:</span>
                               <span className="text-indigo-400 font-bold text-[11px]">{selectedCoin}/USDT</span>
                            </div>
                            <div className="h-3 w-px bg-slate-700"></div>
                            <div className="flex items-center gap-2">
                               <span className="text-[9px] text-slate-500 leading-none">INT:</span>
                               <span className="text-slate-300 font-bold text-[11px]">1H</span>
                            </div>
                          </div>
                       </div>
                       
                       {/* Top Sub Toolbar for Indicators */}
                       {ggResult && (
                           <div className="grid grid-cols-2 lg:grid-cols-4 border-b border-slate-800/60 divide-x divide-y divide-slate-800/60 lg:divide-y-0 text-center font-mono">
                               <div className="py-2.5 px-3 bg-[#0a0d14]/40">
                                   <div className="text-[9px] text-slate-500 font-bold tracking-widest uppercase mb-1">RSI (14)</div>
                                   <div className={cn("text-[11px] font-bold", (ggResult.rsi?.[ggResult.rsi.length - 1] ?? 50) < 30 ? "text-emerald-400 font-extrabold animate-pulse" : (ggResult.rsi?.[ggResult.rsi.length - 1] ?? 50) > 70 ? "text-rose-400 font-extrabold animate-pulse" : "text-slate-300")}>
                                      {(ggResult.rsi?.[ggResult.rsi.length - 1] ?? 50).toFixed(2)}{(ggResult.rsi?.[ggResult.rsi.length - 1] ?? 50) < 30 ? " (OVERSOLD)" : (ggResult.rsi?.[ggResult.rsi.length - 1] ?? 50) > 70 ? " (OVERBOUGHT)" : ""}
                                   </div>
                               </div>
                               <div className="py-2.5 px-3 bg-[#0a0d14]/40">
                                   <div className="text-[9px] text-slate-500 font-bold tracking-widest uppercase mb-1">MACD Histogram</div>
                                   <div className={cn("text-[11px] font-bold", ggResult.macdColors?.[ggResult.macdColors.length - 1] === 'deep_green' ? "text-emerald-400" : ggResult.macdColors?.[ggResult.macdColors.length - 1] === 'light_green' ? "text-emerald-300/80" : ggResult.macdColors?.[ggResult.macdColors.length - 1] === 'deep_red' ? "text-rose-500" : ggResult.macdColors?.[ggResult.macdColors.length - 1] === 'light_red' ? "text-rose-400/80" : "text-slate-400")}>
                                      {(ggResult.macdHist?.[ggResult.macdHist.length - 1] ?? 0).toFixed(4)}
                                   </div>
                               </div>
                               <div className="py-2.5 px-3 bg-[#0a0d14]/40">
                                   <div className="text-[9px] text-slate-500 font-bold tracking-widest uppercase mb-1">ATR (14) Volatility</div>
                                   <div className="text-[11px] font-bold text-amber-400">
                                      {ggResult.atr?.[ggResult.atr.length - 1] ? "$" + (ggResult.atr[ggResult.atr.length - 1] as number).toFixed(2) : 'N/A'}
                                   </div>
                               </div>
                               <div className="py-2.5 px-3 bg-[#0a0d14]/40">
                                   <div className="text-[9px] text-slate-500 font-bold tracking-widest uppercase mb-1">Target Setup Rule</div>
                                   <div className="text-[11px] font-bold text-indigo-400">
                                      1.5x ATR SL / 2:1 R:R
                                   </div>
                               </div>
                           </div>
                       )}

                       {/* The Graphic Canvas */}
                       {candleData.length === 0 ? (
                          <div className="h-64 sm:h-[340px] flex items-center justify-center text-slate-500 font-mono text-[11px] bg-[#070a10] border-b border-slate-800/60">
                            <RefreshCw className="animate-spin mr-2 text-indigo-500" size={14} /> Syncing market streams...
                          </div>
                       ) : (
                          <div className="p-4 bg-[#070a10] relative">
                             {/* WS Stream Debugger Overlay */}
                             <div className="absolute top-4 left-4 z-40 bg-[#0f131c]/80 backdrop-blur-sm border border-slate-700/50 rounded pointer-events-none w-48 md:w-56 overflow-hidden shadow-lg">
                                <div className="px-2 py-1 bg-[#0d1017] border-b border-slate-700/50 flex items-center justify-between">
                                  <span className="text-[9px] font-mono text-slate-400 font-bold uppercase tracking-widest flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_5px_rgba(52,211,153,0.5)]"></span> WS Debugger</span>
                                </div>
                                <div className="p-1.5 space-y-0.5 bg-[#0a0d15]/50">
                                  {wsPackets.length > 0 ? wsPackets.map((pkt, i) => (
                                    <div key={i} className="text-[8px] font-mono text-emerald-400/80 leading-tight truncate px-1 rounded hover:bg-slate-800/50">
                                      {pkt}
                                    </div>
                                  )) : (
                                    <div className="text-[8px] font-mono text-slate-500 leading-tight italic px-1">Waiting for ticks...</div>
                                  )}
                                </div>
                             </div>
                             <div className="h-64 sm:h-[300px] flex items-end gap-[1px] md:gap-[2px] w-full relative group">
                                {candleData.slice(-60).map((candle, idx) => {
                                   const absoluteIdx = candleData.length - Math.min(60, candleData.length) + idx;
                                   const isGreen = candle.close >= (candleData[absoluteIdx - 1]?.close || candle.close);
                                   const windowCandles = candleData.slice(-60);
                                   const maxVal = Math.max(...windowCandles.map(c => c.high));
                                   const minVal = Math.min(...windowCandles.map(c => c.low));
                                   const range = maxVal - minVal || 100;
                                   const candleHeight = Math.max(5, ((candle.close - minVal) / range) * 100);
                                   const signal = ggResult ? ggResult.signals[absoluteIdx] : null;

                                   return (
                                      <div key={idx} className="flex-1 flex flex-col justify-end items-center h-full relative cursor-crosshair">
                                         <div className="w-px bg-slate-800/50 h-full absolute bottom-0 left-1/2 opacity-20 pointer-events-none"></div>
                                         {signal && (
                                           <div className={cn(
                                             "absolute top-2 left-1/2 -translate-x-1/2 text-[9px] font-mono leading-none tracking-tight px-1.5 py-1 rounded font-black z-30 shadow-lg border-2 animate-pulse",
                                             signal === 'LONG' ? "bg-emerald-500/30 text-emerald-300 border-emerald-500/50" : "bg-rose-500/30 text-rose-300 border-rose-500/50"
                                           )}>
                                             {signal}
                                           </div>
                                         )}
                                         <div className="hidden group-hover:flex flex-col absolute bottom-full mb-2 bg-[#1a2130] border border-slate-700 text-slate-200 text-[9px] font-mono p-2 rounded shadow-2xl z-30 whitespace-nowrap leading-tight gap-1">
                                           <div className="text-slate-400 pb-1 border-b border-slate-700 font-bold uppercase tracking-widest text-[8px] text-center">Interval Data</div>
                                           <div className="flex justify-between gap-3 mt-1">C:<span className={isGreen ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{formatPrice(candle.close)}</span></div>
                                           <div className="flex justify-between gap-3">RSI:<span className="text-slate-300 font-bold">{ggResult?.rsi?.[absoluteIdx]?.toFixed(2) || 'N/A'}</span></div>
                                         </div>
                                         <div 
                                            className={cn("w-full rounded-[1px] relative z-10 transition-all opacity-90 hover:opacity-100", isGreen ? "bg-emerald-500" : "bg-rose-500")}
                                            style={{ height: `${candleHeight}%` }}
                                         />
                                      </div>
                                   )
                                })}
                             </div>
                             
                             <div className="flex justify-between items-center text-[9px] font-mono text-slate-500 mt-3 pt-3 border-t border-slate-800/40 uppercase tracking-widest font-bold">
                                <span>60 Bars | Scaled Window | 1H Resol</span>
                                <div className="flex gap-4">
                                   <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded bg-emerald-500"></span> Bullish</div>
                                   <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded bg-rose-500"></span> Bearish</div>
                                </div>
                             </div>
                          </div>
                       )}
                       <div className="bg-[#0b0e14] border-t border-slate-800/60 p-2.5 grid grid-cols-2 md:grid-cols-4 gap-2 text-[9px] font-mono divide-x divide-slate-800/60 text-center uppercase tracking-widest shadow-inner">
                          <div><span className="text-slate-500">ASSET:</span> <span className="ml-1 text-slate-300 font-bold">BTC ONLY</span></div>
                          <div><span className="text-slate-500">TIMEFRAME:</span> <span className="ml-1 text-slate-300 font-bold">1H ONLY</span></div>
                          <div><span className="text-slate-500">RISK:</span> <span className="ml-1 text-slate-300 font-bold">{coinConfig.risk}%</span></div>
                          <div className="flex items-center justify-center gap-1"><span className="text-slate-500">TP MODULES:</span> <span className="text-emerald-400 font-bold">0.5x ➜ 1.0x ➜ 1.5x ➜ 2.0x ATR</span></div>
                       </div>
                   </div>

                   {/* Active Trades Panel */}
                   <div className="bg-[#0f131c] border border-slate-800/60 rounded-lg overflow-hidden shadow-sm flex flex-col">
                        <div className="p-3.5 px-4 flex items-center justify-between border-b border-slate-800/60 bg-[#0d1017]">
                           <h2 className="text-[13px] font-semibold text-slate-200 flex items-center gap-2"><Target size={14} className="text-indigo-400"/> Execution Layer</h2>
                           <div className="text-[9px] bg-[#070a10] text-slate-400 px-2.5 py-1 rounded-[4px] font-mono border border-slate-800/60 shadow-inner font-bold tracking-widest">
                             {activeTrades.length} ACTIVE
                           </div>
                        </div>
                        <div className="p-4 bg-[#0a0d15] flex-1">
                          {activeTrades.length === 0 ? (
                            <div className="py-10 flex flex-col items-center justify-center text-center">
                               <div className="w-12 h-12 rounded-full border border-slate-800 bg-[#0f131c] flex items-center justify-center mb-3 shadow-inner">
                                   <Activity size={20} className="text-slate-600" />
                               </div>
                               <div className="text-slate-400 text-[11px] font-mono uppercase tracking-widest font-bold">Idle State</div>
                               <div className="text-slate-500 text-[10px] mt-1.5 max-w-xs leading-relaxed font-mono">Algorithm actively scanning real-time feeds. Execution blocks trigger immediately upon signal generation.</div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                               <AnimatePresence mode="popLayout">
                                  {activeTrades.map(trade => (
                                     <ActiveTradeCard key={trade.id} trade={trade} />
                                  ))}
                               </AnimatePresence>
                            </div>
                          )}
                        </div>
                   </div>

                   {/* Terminal Logs Activity Deck */}
                   <div className="bg-[#0a0d15] border border-slate-800/60 rounded-lg overflow-hidden shadow-sm flex flex-col h-48 xl:h-64 mt-auto">
                      <div className="p-2.5 px-4 bg-[#0d1017] border-b border-slate-800/60 flex items-center justify-between">
                         <div className="flex items-center gap-2">
                             <TerminalIcon size={12} className="text-slate-500" />
                             <span className="font-mono text-[9px] uppercase tracking-widest font-bold text-slate-300">System Logs</span>
                         </div>
                         <button onClick={() => setTerminalLogs([])} className="text-[9px] font-mono text-slate-500 hover:text-slate-300 transition-colors uppercase tracking-widest font-bold">Clear Buffer</button>
                      </div>
                      <div className="p-3 bg-[#070a10] overflow-y-auto custom-scrollbar flex-1 font-mono text-[10px] sm:text-[11px] text-slate-400 space-y-1 shadow-inner">
                         {terminalLogs.length > 0 ? terminalLogs.map((l, i) => (
                            <div key={i} className="tracking-tight hover:bg-slate-800/30 px-1 py-0.5 rounded transition-colors"><span className="text-slate-600 mr-2">{'>'}</span>{l}</div>
                         )) : (
                            <div className="opacity-50 italic px-1"><span className="text-slate-600 mr-2">{'>'}</span>Awaiting scanner feed initialization...</div>
                         )}
                      </div>
                   </div>
                </div>

                {/* RIGHT COLUMNS (4 cols) - Context & Controls */}
                <div className="xl:col-span-4 flex flex-col gap-4 md:gap-5">
                   
                   {/* System Connections */}
                   <div className="bg-[#0f131c] border border-slate-800/60 rounded-lg p-3.5 flex flex-col gap-3 shadow-sm">
                       <div className="flex items-center justify-between mb-1 px-1">
                          <h3 className="text-[12px] font-bold tracking-tight text-slate-200 uppercase flex items-center gap-2"><Activity size={12} className="text-indigo-400"/> Connections</h3>
                       </div>
                       
                       {/* Binance */}
                       <div className="flex flex-col p-2.5 rounded border shadow-inner bg-[#0a0d15] border-slate-800/60 gap-1.5">
                           <div className="flex items-center justify-between">
                               <div className="flex items-center gap-2">
                                   <span className={cn("h-1.5 w-1.5 rounded-full", binanceStatus?.configured ? "bg-emerald-500 outline outline-emerald-500/20" : "bg-indigo-400 outline outline-indigo-400/20")}></span>
                                   <span className="text-[10px] font-mono text-slate-300 tracking-widest font-bold uppercase">Exchange API</span>
                               </div>
                               <span className={cn("text-[9px] font-mono font-bold tracking-widest border px-1.5 py-0.5 rounded", binanceStatus?.configured ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/5" : "text-indigo-400 border-indigo-400/20 bg-indigo-500/5")}>{binanceStatus?.configured ? "LIVE" : "SANDBOX"}</span>
                           </div>
                           <div className="flex justify-between text-[9px] font-mono text-slate-500">
                               <span>HOST:</span>
                               <span className="text-slate-400">{binanceStatus?.binanceUrl.replace("https://", "") || "---"}</span>
                           </div>
                       </div>

                       {/* Telegram */}
                       <div className="flex flex-col p-2.5 rounded border shadow-inner bg-[#0a0d15] border-slate-800/60 gap-2 text-[10px] font-mono">
                           <div className="flex items-center justify-between">
                               <div className="flex items-center gap-2">
                                   <span className={cn("h-1.5 w-1.5 rounded-full flex outline", tgBackendStatus?.configured && tgEnabled ? "bg-emerald-500 outline-emerald-500/20" : "bg-rose-500 outline-rose-500/20")}></span>
                                   <span className="text-[10px] text-slate-300 tracking-widest font-bold uppercase">Signal Relay</span>
                               </div>
                               {tgBackendStatus?.configured && (
                                   <button 
                                      onClick={() => saveTelegramConfig(!tgEnabled)}
                                      className={cn("px-2 py-[2px] rounded text-[9px] font-bold border transition-colors tracking-widest", tgEnabled ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20" : "bg-[#070a10] text-slate-500 border-slate-700 hover:bg-slate-800")}
                                   >
                                     {tgEnabled ? "ENABLED" : "DISABLED"}
                                   </button>
                               )}
                           </div>
                           
                           {tgBackendStatus?.configured ? (
                               <div className="flex items-center justify-between mt-1">
                                  <span className="text-slate-500 tracking-widest">BRIDGE: <span className="text-slate-300">ACTIVE</span></span>
                                  <button 
                                      disabled={tgSending || !tgEnabled}
                                      onClick={handleTestTelegram}
                                      className="px-2 py-[3px] rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 disabled:opacity-50 transition-colors font-mono font-bold tracking-widest border border-indigo-500/20 text-[9px]"
                                  >
                                      {tgSending ? "TESTING" : "PING"}
                                  </button>
                               </div>
                           ) : (
                               <div className="text-[9px] text-rose-400 font-mono tracking-widest mt-1">MISSING SECRETS</div>
                           )}
                           {tgTestStatus && (
                               <div className={cn("text-[9px] font-mono px-2 py-1.5 rounded border mt-1 tracking-widest", tgTestStatus.success ? "bg-emerald-500/5 text-emerald-400 border-emerald-500/20" : "bg-rose-500/5 text-rose-400 border-rose-500/20")}>
                                   {tgTestStatus.success ? "Ping Delivered Successfully" : tgTestStatus.message}
                               </div>
                           )}
                       </div>

                       {/* Database Self-Healing */}
                       <div className="flex flex-col p-2.5 rounded border shadow-inner bg-[#0a0d15] border-slate-800/60 gap-2 text-[10px] font-mono">
                           <div className="flex items-center justify-between">
                               <div className="flex items-center gap-2">
                                   <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 outline outline-emerald-500/20 animate-pulse"></span>
                                   <span className="text-[10px] text-slate-300 tracking-widest font-bold uppercase">Database Engine</span>
                               </div>
                               <span className="text-[9px] font-mono font-bold tracking-widest border border-emerald-500/20 bg-emerald-500/5 text-emerald-400 px-1.5 py-0.5 rounded">ONLINE</span>
                           </div>
                           <div className="flex items-center justify-between mt-1">
                               <span className="text-slate-500 tracking-widest font-bold">CALCULATIONS: <span className="text-slate-300">PERCENTAGE TPs</span></span>
                               <button 
                                   disabled={healing}
                                   onClick={handleHealDatabase}
                                   className="px-2 py-[3px] rounded bg-[#b45309]/10 text-amber-400 hover:bg-[#b45309]/20 disabled:opacity-50 transition-colors font-mono font-bold tracking-widest border border-amber-500/20 text-[9px]"
                               >
                                   {healing ? "HEALING" : "HEAL"}
                               </button>
                           </div>
                           {healMessage && (
                               <div className="text-[9px] font-mono px-2 py-1.5 rounded border mt-1 tracking-widest bg-emerald-500/5 text-emerald-400 border-emerald-500/20">
                                   {healMessage}
                               </div>
                           )}
                       </div>
                   </div>

                   {/* Algorithmic Defense Gates */}
                   <div className="bg-[#0f131c] border border-slate-800/60 rounded-lg p-3.5 flex flex-col gap-3 shadow-sm relative overflow-hidden">
                       <div className="absolute right-0 top-0 w-32 h-32 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none"></div>
                       <div className="flex flex-col gap-0.5 z-10 px-1">
                         <h3 className="text-[12px] font-bold tracking-tight text-slate-200 uppercase flex items-center gap-2"><Sparkles size={12} className="text-indigo-400"/> Filter Gates</h3>
                         <p className="text-[9px] text-slate-500 font-mono tracking-widest">Strict execution pipeline defenses</p>
                       </div>
                       <div className="flex flex-col gap-2 z-10">
                          <GateSwitch filterVar={filterAdx} setter={setFilterAdx} label="1. ADX Volatility" value={ggResult?.adx[ggResult.adx.length - 1]?.toFixed(1) ?? 'N/A'} required="> 25.0" pass={filterAdx ? ((ggResult?.adx[ggResult.adx.length - 1] ?? 0) > 25) : null} />
                          <GateSwitch filterVar={filterMtf} setter={setFilterMtf} label="2. 4H Multi-Timeframe" value={ggResult?.mtf4hITrend === 1 ? 'BULL' : ggResult?.mtf4hITrend === -1 ? 'BEAR' : 'N/A'} required="MATCH" pass={filterMtf ? (ggResult && (ggResult.mtf4hITrend === (ggResult.iTrend[ggResult.iTrend.length - 1] || 0))) : null} />
                          <GateSwitch filterVar={filterEma} setter={setFilterEma} label="3. 4H EMA 200" value={ggResult?.ema200_4h?.[ggResult.ema200_4h.length - 1] ? `$${formatPrice(ggResult.ema200_4h[ggResult.ema200_4h.length - 1]!)}` : 'N/A'} required="TREND" pass={filterEma ? (ggResult && coinsCandles[selectedCoin]?.[coinsCandles[selectedCoin].length - 1]?.close ? (ggResult.iTrend[ggResult.iTrend.length - 1] === 1 ? coinsCandles[selectedCoin][coinsCandles[selectedCoin].length - 1].close > (ggResult.ema200_4h[ggResult.ema200_4h.length - 1] ?? 0) : coinsCandles[selectedCoin][coinsCandles[selectedCoin].length - 1].close < Math.max(0.0001, ggResult.ema200_4h[ggResult.ema200_4h.length - 1] ?? Infinity)) : null) : null} />
                          <GateSwitch filterVar={filterVolume} setter={setFilterVolume} label="4. Volume Particip." value={`${ggResult?.volumeRatio?.toFixed(2) ?? '1.00'}x`} required="> 1.50x" pass={filterVolume ? ((ggResult?.volumeRatio ?? 0) > 1.5) : null} />
                          <GateSwitch filterVar={filterFunding} setter={setFilterFunding} label="5. Funding Rate" value={`${(ggResult?.fundingRate ?? 0).toFixed(4)}%`} required="< 0.05%" pass={filterFunding ? (ggResult && !( (ggResult.iTrend[ggResult.iTrend.length - 1] === 1 && ggResult.fundingRate >= 0.05) || (ggResult.iTrend[ggResult.iTrend.length - 1] === -1 && ggResult.fundingRate <= -0.05) )) : null} />
                          <GateSwitch filterVar={filterLiquidity} setter={setFilterLiquidity} label="6. Volume Profile" value={`$${((ggResult?.volume24hUsdt ?? 0) / 1000000).toFixed(1)}M`} required="> $30M" pass={filterLiquidity ? ((ggResult?.volume24hUsdt ?? 0) >= 30000000) : null} />
                       </div>
                   </div>

                   {/* Asset Scanner List */}
                   <div className="bg-[#0f131c] border border-slate-800/60 rounded-lg shadow-sm flex flex-col flex-1 min-h-[300px]">
                       <div className="p-3 border-b border-slate-800/60 bg-[#0d1017] flex flex-col gap-3 rounded-t-lg">
                           <div className="flex justify-between items-center px-1">
                               <h3 className="text-[12px] font-bold tracking-tight text-slate-200 uppercase flex items-center gap-2"><Search size={12} className="text-indigo-400"/> Scanner</h3>
                               <span className="text-[9px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded font-mono font-black tracking-widest uppercase flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse shadow-[0_0_5px_rgba(52,211,153,0.8)]"></span> LIVE</span>
                           </div>
                           <div className="relative">
                               <input 
                                 type="text"
                                 placeholder="Search markets..."
                                 value={searchQuery ?? ''}
                                 onChange={(e) => setSearchQuery(e.target.value)}
                                 className="w-full bg-[#0a0d15] border border-slate-800 rounded-[5px] pl-3 pr-3 py-[7px] text-[10px] text-slate-200 placeholder-slate-600 focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/20 outline-none font-mono transition-all shadow-inner"
                               />
                           </div>
                       </div>
                       <div className="flex-1 overflow-y-auto custom-scrollbar p-1.5 flex flex-col gap-0.5 bg-[#0a0d15] rounded-b-lg h-[250px] xl:h-auto">
                           {displayedCoins.map(c => {
                              const isSelected = selectedCoin === c.name;
                              const hasActiveTrade = activeTrades.some(t => t.symbol === c.name);
                              const history = coinsCandles[c.name] || [];
                              const lastClose = history.length > 0 ? history[history.length - 1].close : c.price;

                              return (
                                 <button 
                                    key={c.name}
                                    onClick={() => setSelectedCoin(c.name)}
                                    className={cn("flex items-center justify-between p-2 rounded-[4px] font-mono text-[10px] transition-colors text-left", 
                                      isSelected ? "bg-indigo-500/10 border border-transparent text-indigo-400 shadow-inner" : "hover:bg-slate-800/40 text-slate-400 border border-transparent"
                                    )}
                                 >
                                     <div className="flex items-center gap-2">
                                        <span className={cn("font-bold tracking-wider", isSelected ? "text-indigo-400" : "text-slate-300")}>{c.name}</span>
                                        {hasActiveTrade && <span className="px-1.5 py-[1px] bg-indigo-500/20 text-indigo-400 outline outline-1 outline-indigo-500/30 text-[8px] rounded uppercase font-black tracking-widest shadow-inner">EXEC</span>}
                                     </div>
                                     <div className="flex items-center gap-2">
                                        <span className={cn("tracking-wider", isSelected ? "text-indigo-300 font-bold" : "text-slate-500")}>{formatPrice(lastClose)}</span>
                                     </div>
                                 </button>
                              )
                           })}
                           {displayedCoins.length === 0 && (
                              <div className="p-4 text-center text-slate-500 font-mono text-[10px] uppercase tracking-widest py-8">No pairs matched.</div>
                           )}
                       </div>
                   </div>

                   {/* Daily Performance / History */}
                   <div className="rounded-lg shadow-sm overflow-hidden bg-[#0f131c] border border-slate-800/60 flex-shrink-0">
                        <DailyPerformance trades={closedTrades} />
                   </div>

                </div>
             </div>

         </main>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// INTERNAL SUB-COMPONENTS
// -------------------------------------------------------------

function PremiumStat({ label, value, valueClass }: { label: string, value: string | ReactNode, valueClass?: string }) {
  return (
    <div className="bg-[#0f131c] border border-slate-800/60 rounded-lg p-3 md:p-3.5 shadow-sm flex flex-col justify-center">
      <div className="text-[9px] text-slate-500 font-mono tracking-widest uppercase mb-1.5">{label}</div>
      <div className={cn("font-mono font-bold text-lg md:text-xl", valueClass)}>
        {value}
      </div>
    </div>
  );
}

function GateSwitch({ filterVar, setter, label, value, required, pass }: any) {
   return (
      <div className={cn("flex flex-col gap-1 p-2.5 rounded-[6px] border transition-all relative overflow-hidden shadow-inner", 
          filterVar ? (pass ? "bg-[#070a10]/80 border-emerald-500/20" : "bg-[#070a10]/80 border-rose-500/20") : "bg-[#070a10]/80 border-slate-800/40 opacity-70"
      )}>
         <div className="flex items-center justify-between">
            <span className={cn("text-[9px] font-bold font-mono tracking-widest uppercase", filterVar ? (pass ? "text-slate-200" : "text-slate-200") : "text-slate-500")}>{label}</span>
            <input type="checkbox" checked={!!filterVar} onChange={e => setter(e.target.checked)} className="rounded-[3px] border-slate-700 bg-slate-900 cursor-pointer h-3 w-3 focus:ring-1 focus:ring-indigo-500/50 focus:ring-offset-0 text-indigo-500 outline-none"/>
         </div>
         <div className="flex items-center justify-between text-[9px] font-mono mt-0.5">
            <div className="flex flex-col gap-0.5">
               <div className="text-slate-500 flex items-center gap-1.5 tracking-wider">VAL: <span className="text-slate-300 font-bold">{value}</span></div>
               <div className="text-slate-600 tracking-wider">REQ: {required}</div>
            </div>
            {filterVar ? (
               <div className={cn("px-1.5 py-0.5 rounded-[4px] font-black uppercase tracking-widest border shadow-inner", pass ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20")}>
                  {pass ? "PASS" : "REJECT"}
               </div>
            ) : <div className="text-slate-600 font-bold tracking-widest uppercase">OFF</div>}
         </div>
      </div>
   )
}

