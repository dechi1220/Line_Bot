// 用 Yahoo Finance 非官方的 chart API 查即時報價。
// 好處是股票（台股/美股）跟外匯（USD/TWD）可以用同一個函式查詢，不需要另外申請 API 金鑰。
// 缺點：這是非官方介面，Yahoo 偶爾會擋爬蟲或改格式，如果之後發現查詢常常失敗，
// 可以考慮換成 TWSE OpenAPI（台股）+ Finnhub 免費方案（美股）。

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;

  const res = await fetch(url, {
    headers: {
      // 不帶 User-Agent 常常會被 Yahoo 擋掉，所以假裝是瀏覽器
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`查詢失敗 ${symbol}（HTTP ${res.status}）`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];

  if (!result || !result.meta) {
    throw new Error(`查無資料：${symbol}`);
  }

  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change = price - prevClose;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;

  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    price,
    prevClose,
    change,
    changePercent,
    currency: meta.currency,
  };
}

module.exports = { fetchQuote };
