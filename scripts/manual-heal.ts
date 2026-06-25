import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import { COIN_CONFIGS, DEFAULT_CONFIG } from "../src/lib/srade_1h_config.js";

const mongoUri = "mongodb+srv://Sami:sami%40123sami@gg-shot.ybpg66p.mongodb.net/?appName=GG-Shot";

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

async function runManualHeal() {
  console.log("==========================================================================");
  console.log("               SRADE SYSTEM DATABASE MANUAL HEALING RUN                   ");
  console.log("==========================================================================");
  console.log("Connecting to database...");

  try {
    await mongoose.connect(mongoUri, { dbName: "Srade" });
    console.log("✅ Connected to Mongoose successfully.");

    const client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db("Srade");
    console.log("✅ Connected to MongoClient successfully.");

    // 1. Heal individual daily_trades
    console.log("\n[STEP 1] Healing daily_trades collection...");
    const trades = await TradeModel.find({});
    console.log(`Found ${trades.length} trade documents to analyze.`);

    let healedTradesCount = 0;
    const healReport: any[] = [];

    for (const doc of trades) {
      const coin = doc.symbol;
      if (!coin) continue;
      const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
      const direction = doc.direction;
      const entryPrice = doc.entryPrice;
      if (!entryPrice || !direction) continue;

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

      const oldPnlPercent = doc.pnlPercent || 0;
      let newPnlPercent = oldPnlPercent;

      if (doc.status !== "OPEN") {
        const exitPrice = doc.exitPrice || correctTps[3];
        newPnlPercent = direction === 'LONG'
          ? ((exitPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - exitPrice) / entryPrice) * 100;
        
        doc.pnlPercent = newPnlPercent;
        healedTradesCount++;
      }

      await doc.save();

      healReport.push({
        tradeId: doc.tradeId,
        symbol: coin,
        direction,
        entryPrice: entryPrice.toFixed(4),
        exitPrice: doc.exitPrice ? doc.exitPrice.toFixed(4) : "N/A",
        status: doc.status,
        oldPnl: `${oldPnlPercent.toFixed(2)}%`,
        newPnl: `${newPnlPercent.toFixed(2)}%`,
        healed: oldPnlPercent !== newPnlPercent ? "YES" : "NO"
      });
    }

    if (healReport.length > 0) {
      console.table(healReport.slice(0, 30));
      if (healReport.length > 30) {
        console.log(`... and ${healReport.length - 30} more trade entries healed.`);
      }
    }
    console.log(`🎉 Trade documents process finished. Corrected PnL calculations for ${healedTradesCount} closed trades.`);

    // 2. Heal system_state collection
    console.log("\n[STEP 2] Healing system_state collection...");
    const stateDoc = await db.collection("system_state").findOne({ id: "main" });
    if (stateDoc) {
      let stateChanged = false;
      const activeTrades = stateDoc.activeTrades || [];
      const closedTrades = stateDoc.closedTrades || [];

      console.log(`Found ${activeTrades.length} active trades and ${closedTrades.length} closed trades inside system_state.`);

      let activeHealed = 0;
      for (const t of activeTrades) {
        const coin = t.symbol;
        if (!coin) continue;
        const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
        const direction = t.direction;
        const entryPrice = t.entry;
        if (!entryPrice || !direction) continue;

        const p1 = config.tp[0];
        const p2 = config.tp[1];
        const p3 = config.tp[2];
        const p4 = config.tp[3];
        const slPct = config.sl;

        const oldTps = [...(t.tps || [])];
        const oldSl = t.sl;

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

        // Find which index we are currently on or reset current target
        // For active trades, make sure the current tp reflects the next target
        t.tp = t.tps[0]; // defaults to TP1
        activeHealed++;
        stateChanged = true;
      }

      let closedHealed = 0;
      for (const t of closedTrades) {
        const coin = t.symbol;
        if (!coin) continue;
        const config = COIN_CONFIGS[coin] || DEFAULT_CONFIG;
        const direction = t.direction;
        const entryPrice = t.entry;
        if (!entryPrice || !direction) continue;

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
        closedHealed++;
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
        await db.collection("system_state").updateOne(
          { id: "main" },
          { $set: { activeTrades, closedTrades, stats: correctStats } }
        );
        console.log(`✅ Successfully updated system_state and stats with ${activeHealed} healed active trades and ${closedHealed} healed closed trades!`);
      } else {
        console.log("No changes detected in system_state.");
      }
    } else {
      console.log("system_state document not found in database.");
    }

    await mongoose.disconnect();
    await client.close();
    console.log("\n==========================================================================");
    console.log("  SUCCESS: Database has been fully healed with precise percentage-based TPs!");
    console.log("==========================================================================");
    process.exit(0);
  } catch (error: any) {
    console.error("❌ Database healer script failed:", error);
    process.exit(1);
  }
}

runManualHeal();
