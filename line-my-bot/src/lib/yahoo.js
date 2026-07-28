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

// 抓一段期間的歷史日線資料，用來算近期高低點、區間漲跌幅
// days: 想要取最近幾個「交易日」的資料（週末/假日不會計入，所以抓 range 要留一點餘裕）
async function fetchHistory(symbol, days = 10, range = "1mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`查詢歷史資料失敗 ${symbol}（HTTP ${res.status}）`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result || !result.timestamp) {
    throw new Error(`查無歷史資料：${symbol}`);
  }

  const timestamps = result.timestamp;
  const quoteData = result.indicators?.quote?.[0] || {};
  const closes = quoteData.close || [];
  const highs = quoteData.high || [];
  const lows = quoteData.low || [];

  const points = timestamps
    .map((t, i) => ({
      date: new Date(t * 1000),
      close: closes[i],
      high: highs[i],
      low: lows[i],
    }))
    .filter((p) => p.close != null && p.high != null && p.low != null);

  return points.slice(-days);
}

module.exports = { fetchQuote, fetchHistory };

