import { motion, AnimatePresence } from 'motion/react';
import { ArrowUpRight, ArrowDownRight, Clock, CheckCircle2, XCircle } from 'lucide-react';
import { ClosedTrade } from '../types';
import { cn, formatPrice, formatPercent } from '../lib/utils';

interface DailyPerformanceProps {
  trades: ClosedTrade[];
}

export function DailyPerformance({ trades }: DailyPerformanceProps) {
  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[500px] text-slate-500 border border-slate-800 rounded-2xl bg-slate-950/40">
        <Clock className="mb-3 opacity-40 text-indigo-400" size={32} />
        <p className="font-mono text-sm uppercase tracking-wide">Awaiting closed signal logs...</p>
      </div>
    );
  }

  return (
    <div className="border border-slate-800 rounded-2xl bg-slate-900 overflow-hidden flex flex-col h-[500px] shadow-lg">
      <div className="p-4 border-b border-slate-850 bg-slate-950 flex justify-between items-center">
        <h2 className="font-display font-bold text-slate-100 flex items-center gap-2">
          Signal Performance History
          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-950/50 border border-indigo-900 text-indigo-400 font-extrabold ml-2">LIVE</span>
        </h2>
        <span className="text-xs text-slate-400 font-mono">Total Signals: {trades.length}</span>
      </div>
      
      <div className="flex-1 overflow-y-auto px-2 py-2 hide-scrollbar bg-slate-900">
        <div className="grid grid-cols-5 text-[10px] uppercase font-bold text-slate-500 px-4 py-2 sticky top-0 bg-slate-950/75 backdrop-blur-sm z-10 rounded mb-2 font-mono border-b border-slate-850">
          <div className="col-span-1">Pair</div>
          <div className="col-span-1 text-center">Bias</div>
          <div className="col-span-2 text-right">Outcome Price</div>
          <div className="col-span-1 text-right">Performance</div>
        </div>

        <div className="flex flex-col gap-1.5 px-2">
          <AnimatePresence initial={false}>
            {trades.map((trade) => {
              const isWin = trade.status === 'WIN';
              return (
                <motion.div
                  key={`${trade.id}-${trade.timestamp}`}
                  initial={{ opacity: 0, height: 0, scale: 0.95 }}
                  animate={{ opacity: 1, height: 'auto', scale: 1 }}
                  transition={{ duration: 0.3, type: 'spring', bounce: 0.4 }}
                  className={cn(
                    "grid grid-cols-5 items-center p-3 rounded-xl text-sm border border-l-4",
                    isWin 
                      ? "bg-emerald-950/15 border-emerald-900/40 border-l-emerald-500 hover:bg-emerald-950/25 text-slate-200" 
                      : "bg-rose-950/15 border-rose-900/45 border-l-rose-500 hover:bg-rose-950/25 text-slate-200"
                  )}
                >
                  <div className="col-span-1 font-bold font-display tracking-tight flex items-center gap-1.5">
                    {isWin ? <CheckCircle2 size={14} className="text-emerald-400 animate-pulse" /> : <XCircle size={14} className="text-rose-400" />}
                    {trade.symbol}
                  </div>
                  
                  <div className="col-span-1 text-center flex justify-center">
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 font-mono font-bold",
                      trade.direction === 'LONG' ? "bg-emerald-950/30 text-emerald-400 border border-emerald-900/35" : "bg-rose-950/30 text-rose-400 border border-rose-900/35"
                    )}>
                      {trade.direction === 'LONG' ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                      {trade.direction}
                    </span>
                  </div>
                  
                  <div className="col-span-2 text-right font-mono flex flex-col justify-center">
                    <span className="text-slate-100 font-bold">{formatPrice(trade.exitPrice)}</span>
                    <span className="text-[10px] text-slate-500 block">Entry {formatPrice(trade.entry)}</span>
                  </div>
                  
                  <div className="col-span-1 text-right font-mono font-bold flex flex-col justify-center">
                    <span className={isWin ? 'text-emerald-400 text-[10px] uppercase font-black' : 'text-rose-400 text-[10px] uppercase font-black'}>
                      {isWin ? 'TARGET MET' : 'STOP HIT'}
                    </span>
                    <span className={cn("text-[10px] font-semibold", isWin ? 'text-emerald-400' : 'text-rose-400')}>
                      {trade.pnlPercent >= 0 ? '+' : ''}{trade.pnlPercent.toFixed(2)}%
                    </span>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
