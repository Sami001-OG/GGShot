const { MongoClient } = require('mongodb');
require('dotenv').config();

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log("No MONGODB_URI provided");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("Srade");
  const state = await db.collection("system_state").findOne({ id: "main" });
  if (state && state.activeTrades) {
    for (const t of state.activeTrades) {
      if (t.realizedTps && t.realizedTps.some(x => x)) {
        console.log("Trade", t.symbol, "TPs:", t.realizedTps, "SL:", t.sl, "Entry:", t.entry);
      }
    }
    console.log("Active trades:", state.activeTrades.length);
  } else {
    console.log("No active trades found.");
  }
  await client.close();
}
run();
