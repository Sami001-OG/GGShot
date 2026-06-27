const payload = {
  activeTrades: [],
  closedTrades: [],
  stats: { balance: 10000, won: 0, lost: 0, totalPnl: 0 },
  logs: ["test log 1", "test log 2"],
  filterAdx: true,
  filterMtf: true,
  filterEma: true,
  filterVolume: true,
  filterFunding: true,
  filterLiquidity: true
};

fetch('http://localhost:3000/api/db/state', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
})
.then(async r => {
  console.log('Status:', r.status);
  const text = await r.text();
  console.log('Response:', text);
})
.catch(console.error);

