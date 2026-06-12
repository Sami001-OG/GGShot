import { motion } from 'motion/react';
import { Target, ShieldAlert, CheckCircle2, Circle, TrendingUp, TrendingDown, DollarSign } from 'lucide-react';
import { ActiveTrade } from '../types';
import { cn, formatPrice, formatPercent } from '../lib/utils';
import { COIN_CONFIGS } from '../lib/ggshot_1h_config';

interface ActiveTradeCardProps {
  key?: string | number;
  trade: ActiveTrade;
}

export function ActiveTradeCard({ trade }: ActiveTradeCardProps) {
  const { id, symbol, direction, entry, tps, sl, currentPrice } = trade;
  const isLong = direction === 'LONG';
  
  // High-fidelity progress mapping
  const slBound = sl;
  const tpBound = tps ? tps[3] : trade.tp; // Use TP4 as target bounds
  
  // Calculate percentage progress between SL (0%) and TP4 (100%)
  const percentage = ((currentPrice - slBound) / (tpBound - slBound)) * 100;
  const safePercentage = Math.max(0, Math.min(100, percentage));
  
  const currentPnlPercent = isLong 
    ? ((currentPrice - entry) / entry) * 100 
    : ((entry - currentPrice) / entry) * 100;

  const currentPnlValue = (trade.size * currentPnlPercent) / 100;
  const isProfit = currentPnlPercent >= 0;

  // Fetch real theoretical allocations
  const config = COIN_CONFIGS[symbol] || { alloc: [40, 30, 20, 10] };
  const allocs = config.alloc;

  // Determine reached status for each target
  const checkTargetReached = (val: number) => {
    return isLong ? currentPrice >= val : currentPrice <= val;
  };

  const getPercentageOf = (price: number) => {
    const range = tpBound - slBound;
    if (range === 0) return 0;
    const pct = ((price - slBound) / range) * 100;
    return Math.max(0, Math.min(100, pct));
  };

  const points = [
    { 
      label: 'SL', 
      price: sl, 
      percent: 0, 
      position: 'below' as const, 
      color: 'text-rose-500 font-extrabold', 
      dotColor: 'bg-rose-500 shadow-[0_0_4px_#ef4444]' 
    },
    { 
      label: 'ENT', 
      price: entry, 
      percent: getPercentageOf(entry), 
      position: 'above' as const, 
      color: 'text-indigo-400 font-extrabold', 
      dotColor: 'bg-indigo-400 shadow-[0_0_5px_#818cf8] z-25' 
    },
    ...(tps ? tps.map((val, index) => {
      const isReached = trade.realizedTps ? trade.realizedTps[index] : checkTargetReached(val);
      const isFinal = index === 3;
      return {
        label: `TP${index + 1}`,
        price: val,
        percent: isFinal ? 100 : getPercentageOf(val),
        position: index % 2 === 0 ? ('below' as const) : ('above' as const),
        color: isReached ? 'text-emerald-400 font-extrabold' : 'text-slate-500 font-semibold',
        dotColor: isReached 
          ? 'bg-emerald-400 shadow-[0_0_6px_#34d399] z-25' 
          : 'bg-slate-700/85 border border-slate-900/40'
      };
    }) : [])
  ];

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.98, y: 15 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -10 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn(
        "p-5 rounded-2xl border backdrop-blur-md relative overflow-hidden flex flex-col justify-between transition-all duration-300",
        isProfit 
          ? "border-emerald-500/20 bg-slate-900/90 shadow-[0_4px_30px_rgba(16,185,129,0.02)]" 
          : "border-rose-500/25 bg-slate-900/90 shadow-[0_4px_30px_rgba(239,68,68,0.02)]"
      )}
    >
      {/* Subtle background ambient flare */}
      <div className={cn(
        "absolute -top-12 -right-12 w-28 h-28 rounded-full blur-3xl opacity-10 pointer-events-none transition-colors duration-300",
        isProfit ? "bg-emerald-500/20" : "bg-rose-500/20"
      )} />

      {/* 1. Header Row (Symbol, Direction, Sizing, and Live PNL) */}
      <div className="relative z-10 flex justify-between items-start mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display font-extrabold text-xl tracking-tight text-slate-100 flex items-center gap-1">
              {symbol}
              <span className="text-slate-500 text-xs font-normal">/USDT</span>
            </h3>
            <span className={cn(
              "text-[9px] px-2 py-0.5 rounded-full font-extrabold tracking-widest uppercase flex items-center gap-1",
              isLong 
                ? "bg-emerald-950/40 text-emerald-400 border border-emerald-500/20" 
                : "bg-rose-950/40 text-rose-400 border border-rose-500/25"
            )}>
              {isLong ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
              {direction}
            </span>
          </div>
          <div className="flex gap-2 text-[10px] font-mono text-slate-400 mt-1">
            <span>Size: <strong className="text-slate-200">{trade.size.toLocaleString()} Units</strong></span>
            <span className="text-slate-605">•</span>
            <span>ID: <strong className="text-slate-200">{id}</strong></span>
          </div>
        </div>
        
        <div className="text-right">
          <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400 font-mono block mb-0.5">Live PNL</span>
          <div className={cn("font-mono font-black text-sm flex items-center justify-end gap-1", isProfit ? "text-emerald-400" : "text-rose-400")}>
            <span className="text-xs bg-slate-950 px-2 py-1 rounded border border-slate-800 ml-1">
              {currentPnlPercent >= 0 ? '+' : ''}{currentPnlPercent.toFixed(2)}%
            </span>
          </div>
        </div>
      </div>

      {/* 2. Parameters Overview Strip */}
      <div className="relative z-10 grid grid-cols-3 gap-2 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80 mb-4 text-xs font-mono">
        <div>
          <span className="text-[9px] text-slate-500 block uppercase">Entry Price</span>
          <span className="font-bold text-slate-200 mt-0.5 block">{formatPrice(entry)}</span>
        </div>
        <div className="border-l border-r border-slate-800 px-2.5">
          <span className="text-[9px] text-slate-500 block uppercase">Current Price</span>
          <motion.span 
            key={currentPrice}
            initial={{ scale: 1.05 }}
            animate={{ scale: 1 }}
            className={cn("font-bold mt-0.5 block", isProfit ? "text-emerald-400" : "text-rose-400")}
          >
            {formatPrice(currentPrice)}
          </motion.span>
        </div>
        <div className="pl-1">
          <span className="text-[9px] text-rose-400 flex items-center gap-1 uppercase">
            <ShieldAlert size={10} /> Stop Loss
          </span>
          <span className="font-bold text-rose-550 mt-0.5 block">{formatPrice(sl)}</span>
        </div>
      </div>

      {/* 3. Integrated Micro Multi-Target Multi-Milestone Progress Timeline */}
      <div className="relative pt-12 pb-12 mt-2 px-1 z-10 select-none">
        <div className="h-1 bg-slate-850 rounded-full border border-slate-800 relative animate-pulse-slow">
          {/* Inner clip container for the filled track */}
          <div className="absolute inset-0 rounded-full overflow-hidden">
            <div 
              className={cn(
                "h-full transition-all duration-300",
                isProfit 
                  ? "bg-gradient-to-r from-slate-800 via-emerald-500 to-emerald-400" 
                  : "bg-gradient-to-r from-slate-800 to-rose-500"
              )}
              style={{ width: `${safePercentage}%` }}
            />
          </div>
          
          {/* Active tracking pointer line showing Current Price position */}
          <div 
            className="absolute top-[-5px] h-3.5 w-1 bg-slate-200 shadow-sm z-35"
            style={{ left: `${safePercentage}%` }}
          />

          {/* Markers / Dots and Price Labels */}
          {points.map((point) => {
            const isAbove = point.position === 'above';
            // Adjust dot style and color classes for dark theme
            let themeDotColor = point.dotColor;
            if (point.label.startsWith('TP')) {
              const isWin = point.color.includes('emerald');
              themeDotColor = isWin 
                ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)] z-25' 
                : 'bg-slate-800 border border-slate-700';
            } else if (point.label === 'ENT') {
              themeDotColor = 'bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.6)] z-25';
            } else if (point.label === 'SL') {
              themeDotColor = 'bg-rose-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]';
            }

            return (
              <div 
                key={point.label}
                className="absolute -translate-x-1/2 flex flex-col items-center"
                style={{ left: `${point.percent}%` }}
              >
                {/* Dot */}
                <div 
                  className={cn(
                    "w-2.5 h-2.5 rounded-full absolute -translate-y-1/2 border border-slate-900 transition-all duration-300 z-30", 
                    themeDotColor
                  )} 
                  style={{ top: "50%" }}
                />

                {/* Alternating labels wrapper */}
                {isAbove ? (
                  <div className="absolute bottom-4 flex flex-col items-center text-center">
                    <span className="text-[7.5px] text-slate-400 font-bold uppercase tracking-wider font-mono">{point.label}</span>
                    <span className={cn("text-[9px] font-mono font-semibold leading-none mt-0.5", point.color.replace('text-slate-500', 'text-slate-400'))}>{formatPrice(point.price)}</span>
                    <div className="w-px h-1.5 bg-slate-800 mt-0.5" />
                  </div>
                ) : (
                  <div className="absolute top-4 flex flex-col items-center text-center">
                    <div className="w-px h-1.5 bg-slate-800 mb-0.5" />
                    <span className={cn("text-[9px] font-mono font-semibold leading-none", point.color.replace('text-slate-500', 'text-slate-400'))}>{formatPrice(point.price)}</span>
                    <span className="text-[7.5px] text-slate-400 font-bold uppercase tracking-wider font-mono mt-0.5">{point.label}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
