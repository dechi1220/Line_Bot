const express = require("express");
const crypto = require("crypto");
const { fetchQuote, fetchHistory } = require("./lib/yahoo");
const redisLib = require("./lib/redis");
const lineLib = require("./lib/line");
const { genId, evaluateAlert, describeAlert, parseAlertSpec } = require("./lib/alerts");
const { computeMARelation, computeRSI, rsiZone } = require("./lib/indicators");
const costLib = require("./lib/cost");

const app = express();

// LINE webhook 需要「原始 body」才能驗證簽章，所以這條路徑不能用 express.json()
app.use("/webhook", express.raw({ type: "*/*" }));

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;
const USD_SYMBOL = "TWD=X";

function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

app.get("/", (req, res) => {
  res.send("LINE 美金/股票提醒機器人運作中 ✅ (v2)");
});

app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  if (!verifySignature(req.body, signature)) {
    return res.status(401).send("簽章驗證失敗");
  }

  res.status(200).send("OK"); // 先回應 LINE，避免處理太久被判定逾時

  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    console.error("解析 webhook body 失敗:", err);
    return;
  }

  for (const event of body.events || []) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("處理事件失敗:", err);
    }
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  if (userId) {
    await redisLib.saveUserId(userId);
  }

  const text = event.message.text.trim();
  let reply;
  try {
    reply = await handleCommand(text);
  } catch (err) {
    // 之前這種錯誤只會寫進 log、使用者完全看不到任何回覆，很難排查問題。
    // 現在直接把錯誤訊息回傳給使用者，才能一眼看出是哪裡壞掉（例如 Redis 權限不足）。
    console.error("指令處理發生錯誤:", err);
    reply = `⚠️ 處理指令時發生錯誤：\n${err.message}`;
  }
  await lineLib.replyMessage(event.replyToken, reply);
}

// 台股代號如果是純數字（例如 2330、0050），自動補上 .TW 後綴
function normalizeSymbol(raw) {
  const s = raw.toUpperCase();
  if (/^\d{4,6}$/.test(s)) return `${s}.TW`;
  return s;
}

function formatQuoteLine(q) {
  const arrow = q.changePercent >= 0 ? "🔺" : "🔻";
  const sign = q.changePercent >= 0 ? "+" : "";
  return `${arrow} ${q.name}（${q.symbol}）\n目前價格：${q.price.toFixed(2)}\n今日漲跌：${sign}${q.change.toFixed(2)} (${sign}${q.changePercent.toFixed(2)}%)`;
}

// 解析像「15」「15%」這樣的百分比輸入
function parsePercent(text) {
  const cleaned = (text || "").replace(/%/g, "").trim();
  const value = parseFloat(cleaned);
  if (Number.isNaN(value) || value <= 0) return null;
  return value;
}

// 確保股票有一份預設完整的設定物件（相容舊資料，欄位不存在就補上）
function ensureStockShape(stock) {
  return {
    category: stock?.category || null,
    costBasis: stock?.costBasis ?? null,
    costAlerts: stock?.costAlerts || [],
    alerts: stock?.alerts || [],
    technicalEnabled: stock?.technicalEnabled || false,
    maRelation: stock?.maRelation ?? null,
    rsiZone: stock?.rsiZone || "neutral",
  };
}

// ------------------------------------------------
// 指令處理
// ------------------------------------------------

async function handleCommand(text) {
  const [cmd, ...rest] = text.split(/\s+/);

  // ---------- 美金：查詢 ----------
  if (cmd === "美金" || cmd === "查詢美金") {
    try {
      const q = await fetchQuote(USD_SYMBOL);
      return `💵 美金即時匯率\n${formatQuoteLine({ ...q, name: "USD/TWD" })}`;
    } catch (err) {
      return `查詢美金匯率失敗：${err.message}`;
    }
  }

  // ---------- 美金：近兩週高低點 ----------
  if (cmd === "美金兩週") {
    try {
      const points = await fetchHistory(USD_SYMBOL, 10); // 兩週大約 10 個交易日
      if (points.length === 0) return "查無近期資料";

      const first = points[0];
      const last = points[points.length - 1];
      let highPoint = points[0];
      let lowPoint = points[0];
      for (const p of points) {
        if (p.high > highPoint.high) highPoint = p;
        if (p.low < lowPoint.low) lowPoint = p;
      }

      const changePercent = ((last.close - first.close) / first.close) * 100;
      const sign = changePercent >= 0 ? "+" : "";
      const fmtDate = (d) =>
        d.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" });

      return [
        `💵 美金近兩週走勢（${fmtDate(first.date)} ~ ${fmtDate(last.date)}）`,
        `區間漲跌：${sign}${changePercent.toFixed(2)}%`,
        `最高：${highPoint.high.toFixed(3)}（${fmtDate(highPoint.date)}）`,
        `最低：${lowPoint.low.toFixed(3)}（${fmtDate(lowPoint.date)}）`,
      ].join("\n");
    } catch (err) {
      return `查詢失敗：${err.message}`;
    }
  }

  // ---------- 美金：每日報告開關 ----------
  if (cmd === "美金日報") {
    const setting = rest[0];
    if (setting !== "開" && setting !== "關") {
      return "格式錯誤，請用：美金日報 開　或　美金日報 關";
    }
    const settings = await redisLib.getUsdSettings();
    settings.dailyReportEnabled = setting === "開";
    await redisLib.saveUsdSettings(settings);
    return `已${setting === "開" ? "開啟" : "關閉"}每日美金價格報告`;
  }

  // ---------- 美金：新增到價提醒 ----------
  if (cmd === "美金提醒") {
    const spec = parseAlertSpec(rest.join(""));
    if (!spec) {
      return "格式錯誤，請用：美金提醒 高於33　或　美金提醒 低於31";
    }
    const settings = await redisLib.getUsdSettings();
    settings.alerts.push({ id: genId(), type: spec.type, value: spec.value, state: "none" });
    await redisLib.saveUsdSettings(settings);
    return `已新增美金提醒：${describeAlert(spec)}`;
  }

  // ---------- 美金：提醒清單 ----------
  if (cmd === "美金提醒清單") {
    const settings = await redisLib.getUsdSettings();
    if (settings.alerts.length === 0) return "目前沒有設定任何美金到價提醒。";
    const lines = settings.alerts.map((a, i) => `${i + 1}. ${describeAlert(a)}`);
    return `美金到價提醒：\n${lines.join("\n")}`;
  }

  // ---------- 美金：刪除提醒 ----------
  if (cmd === "刪除美金提醒") {
    const index = parseInt(rest[0], 10) - 1;
    const settings = await redisLib.getUsdSettings();
    if (Number.isNaN(index) || index < 0 || index >= settings.alerts.length) {
      return "編號不存在，先傳「美金提醒清單」確認編號。";
    }
    const removed = settings.alerts.splice(index, 1)[0];
    await redisLib.saveUsdSettings(settings);
    return `已刪除美金提醒：${describeAlert(removed)}`;
  }

  // ---------- 股票：查詢（不用先加入清單）----------
  if (cmd === "查詢" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    try {
      const q = await fetchQuote(symbol);
      return formatQuoteLine(q);
    } catch (err) {
      return `查不到「${symbol}」的報價，請確認代號是否正確。`;
    }
  }

  // ---------- 股票：新增自選 ----------
  if (cmd === "新增" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    try {
      await fetchQuote(symbol);
    } catch {
      return `查不到「${symbol}」的報價，請確認代號是否正確。\n（台股輸入數字代號，例如 2330；美股輸入代碼，例如 AAPL）`;
    }
    const existing = await redisLib.getStock(symbol);
    if (existing) return `「${symbol}」已經在自選股清單裡了。`;
    await redisLib.saveStock(symbol, { alerts: [] });
    return `已新增自選股：${symbol}`;
  }

  // ---------- 股票：刪除自選 ----------
  if (cmd === "刪除" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    await redisLib.removeStock(symbol);
    return `已刪除自選股：${symbol}（相關的到價提醒也會一併移除）`;
  }

  // ---------- 股票：新增到價提醒 ----------
  if (cmd === "提醒" && rest[0] && rest[1] !== undefined) {
    const symbol = normalizeSymbol(rest[0]);
    const spec = parseAlertSpec(rest.slice(1).join(""));
    if (!spec) {
      return "格式錯誤，請用：提醒 2330 高於600　或　提醒 2330 低於550";
    }
    try {
      await fetchQuote(symbol);
    } catch {
      return `查不到「${symbol}」的報價，請確認代號是否正確。`;
    }
    let stock = await redisLib.getStock(symbol);
    let autoAdded = false;
    if (!stock) {
      stock = { alerts: [] };
      autoAdded = true;
    }
    stock.alerts.push({ id: genId(), type: spec.type, value: spec.value, state: "none" });
    await redisLib.saveStock(symbol, stock);
    return `已新增「${symbol}」的到價提醒：${describeAlert(spec)}${autoAdded ? "\n（已自動加入自選股清單）" : ""}`;
  }

  // ---------- 股票：提醒清單 ----------
  if (cmd === "提醒清單" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    const stock = await redisLib.getStock(symbol);
    if (!stock || stock.alerts.length === 0) {
      return `「${symbol}」目前沒有設定任何到價提醒。`;
    }
    const lines = stock.alerts.map((a, i) => `${i + 1}. ${describeAlert(a)}`);
    return `「${symbol}」的到價提醒：\n${lines.join("\n")}`;
  }

  // ---------- 股票：刪除提醒 ----------
  if (cmd === "刪除提醒" && rest[0] && rest[1] !== undefined) {
    const symbol = normalizeSymbol(rest[0]);
    const index = parseInt(rest[1], 10) - 1;
    const stock = await redisLib.getStock(symbol);
    if (!stock || Number.isNaN(index) || index < 0 || index >= stock.alerts.length) {
      return `編號不存在，先傳「提醒清單 ${symbol}」確認編號。`;
    }
    const removed = stock.alerts.splice(index, 1)[0];
    await redisLib.saveStock(symbol, stock);
    return `已刪除「${symbol}」的提醒：${describeAlert(removed)}`;
  }

  // ---------- 股票：分類（核心／衛星）----------
  if (cmd === "分類" && rest[0] && rest[1]) {
    const symbol = normalizeSymbol(rest[0]);
    const label = rest[1];
    if (label !== "核心" && label !== "衛星") {
      return "格式錯誤，請用：分類 2330 核心　或　分類 2330 衛星";
    }
    let stock = await redisLib.getStock(symbol);
    if (!stock) return `「${symbol}」還沒加入自選股清單，先傳「新增 ${symbol}」。`;
    stock = ensureStockShape(stock);
    stock.category = label === "核心" ? "core" : "satellite";
    await redisLib.saveStock(symbol, stock);
    return `已將「${symbol}」分類為${label}持股`;
  }

  // ---------- 股票：設定成本 ----------
  if (cmd === "成本" && rest[0] && rest[1]) {
    const symbol = normalizeSymbol(rest[0]);
    const cost = parseFloat(rest[1]);
    if (Number.isNaN(cost) || cost <= 0) {
      return "格式錯誤，請用：成本 2330 550";
    }
    let stock = await redisLib.getStock(symbol);
    let autoAdded = false;
    if (!stock) {
      try {
        await fetchQuote(symbol);
      } catch {
        return `查不到「${symbol}」的報價，請確認代號是否正確。`;
      }
      autoAdded = true;
    }
    stock = ensureStockShape(stock);
    stock.costBasis = cost;
    await redisLib.saveStock(symbol, stock);
    return `已設定「${symbol}」成本：${cost}${autoAdded ? "\n（已自動加入自選股清單）" : ""}`;
  }

  // ---------- 股票：查看損益 ----------
  if (cmd === "損益" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    const stock = ensureStockShape(await redisLib.getStock(symbol));
    if (!stock.costBasis) {
      return `「${symbol}」尚未設定成本，先傳「成本 ${symbol} 你的成本價」。`;
    }
    try {
      const q = await fetchQuote(symbol);
      const percent = ((q.price - stock.costBasis) / stock.costBasis) * 100;
      const sign = percent >= 0 ? "+" : "";
      const arrow = percent >= 0 ? "🔺" : "🔻";
      return `${arrow} ${q.name}（${symbol}）\n目前價格：${q.price.toFixed(2)}\n持有成本：${stock.costBasis}\n損益：${sign}${percent.toFixed(2)}%`;
    } catch (err) {
      return `查詢失敗：${err.message}`;
    }
  }

  // ---------- 股票：停利／停損／加碼提醒 ----------
  if ((cmd === "停利" || cmd === "停損" || cmd === "加碼提醒") && rest[0] && rest[1] !== undefined) {
    const symbol = normalizeSymbol(rest[0]);
    const percent = parsePercent(rest[1]);
    if (percent == null) {
      return `格式錯誤，請用：${cmd} ${rest[0]} 10（代表 10%）`;
    }
    let stock = await redisLib.getStock(symbol);
    if (!stock || !ensureStockShape(stock).costBasis) {
      return `「${symbol}」尚未設定成本，先傳「成本 ${symbol} 你的成本價」再設定這個提醒。`;
    }
    stock = ensureStockShape(stock);
    const purpose = cmd === "停利" ? "profit" : cmd === "停損" ? "loss" : "addon";
    const alert = { id: genId(), purpose, percent, state: "none" };
    stock.costAlerts.push(alert);
    await redisLib.saveStock(symbol, stock);
    return `已新增「${symbol}」提醒：${costLib.describeCostAlert(stock.costBasis, alert)}`;
  }

  // ---------- 股票：成本提醒清單 ----------
  if (cmd === "成本提醒清單" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    const stock = ensureStockShape(await redisLib.getStock(symbol));
    if (!stock.costBasis || stock.costAlerts.length === 0) {
      return `「${symbol}」目前沒有設定任何成本相關提醒。`;
    }
    const lines = stock.costAlerts.map(
      (a, i) => `${i + 1}. ${costLib.describeCostAlert(stock.costBasis, a)}`
    );
    return `「${symbol}」成本提醒（成本：${stock.costBasis}）：\n${lines.join("\n")}`;
  }

  // ---------- 股票：刪除成本提醒 ----------
  if (cmd === "刪除成本提醒" && rest[0] && rest[1] !== undefined) {
    const symbol = normalizeSymbol(rest[0]);
    const index = parseInt(rest[1], 10) - 1;
    const stock = ensureStockShape(await redisLib.getStock(symbol));
    if (Number.isNaN(index) || index < 0 || index >= stock.costAlerts.length) {
      return `編號不存在，先傳「成本提醒清單 ${symbol}」確認編號。`;
    }
    const removed = stock.costAlerts.splice(index, 1)[0];
    await redisLib.saveStock(symbol, stock);
    return `已刪除「${symbol}」的提醒：${costLib.describeCostAlert(stock.costBasis, removed)}`;
  }

  // ---------- 股票：技術指標提醒開關（均線交叉 + RSI）----------
  if (cmd === "技術提醒" && rest[0] && rest[1]) {
    const symbol = normalizeSymbol(rest[0]);
    const setting = rest[1];
    if (setting !== "開" && setting !== "關") {
      return `格式錯誤，請用：技術提醒 ${rest[0]} 開　或　技術提醒 ${rest[0]} 關`;
    }
    let stock = await redisLib.getStock(symbol);
    let autoAdded = false;
    if (!stock) {
      try {
        await fetchQuote(symbol);
      } catch {
        return `查不到「${symbol}」的報價，請確認代號是否正確。`;
      }
      autoAdded = true;
    }
    stock = ensureStockShape(stock);

    if (setting === "關") {
      stock.technicalEnabled = false;
      await redisLib.saveStock(symbol, stock);
      return `已關閉「${symbol}」的技術指標提醒`;
    }

    // 開啟時：先抓歷史資料，把「目前狀態」記錄下來當基準，不主動通知，
    // 避免一開啟就因為「從無到有」被當成一次訊號誤發通知。
    try {
      const points = await fetchHistory(symbol, 90, "3mo");
      const closes = points.map((p) => p.close);
      const relation = computeMARelation(closes, 5, 20);
      const rsi = computeRSI(closes, 14);
      const zone = rsiZone(rsi);

      stock.technicalEnabled = true;
      stock.maRelation = relation;
      stock.rsiZone = zone;
      await redisLib.saveStock(symbol, stock);

      const relationText =
        relation === "above" ? "5日線在20日線之上" : relation === "below" ? "5日線在20日線之下" : "資料不足";
      const rsiText = rsi != null ? `RSI ${rsi.toFixed(1)}（${zone === "neutral" ? "正常" : zone === "overbought" ? "過熱" : "過冷"}）` : "資料不足";

      return [
        `已開啟「${symbol}」的技術指標提醒${autoAdded ? "（已自動加入自選股清單）" : ""}`,
        `目前狀態：${relationText}，${rsiText}`,
        "之後只有「轉變」的時候才會通知你（例如均線交叉、RSI 進出過熱/過冷區間）",
      ].join("\n");
    } catch (err) {
      return `開啟失敗，查詢歷史資料時發生錯誤：${err.message}`;
    }
  }

  // ---------- 總覽 ----------
  if (cmd === "清單") {
    const stocksRaw = await redisLib.getAllStocks();
    const usdSettings = await redisLib.getUsdSettings();
    const symbols = Object.keys(stocksRaw);

    const lines = ["📋 目前設定總覽", ""];
    lines.push(`💵 美金每日報告：${usdSettings.dailyReportEnabled ? "開啟" : "關閉"}`);
    lines.push(`💵 美金到價提醒：${usdSettings.alerts.length} 組`);

    if (symbols.length === 0) {
      lines.push("", "目前沒有追蹤任何股票（輸入「新增 股票代號」開始追蹤）");
      return lines.join("\n");
    }

    const describeStockLine = (symbol, stock) => {
      const parts = [`・${symbol}`];
      if (stock.costBasis) parts.push(`成本${stock.costBasis}`);
      if (stock.alerts.length > 0) parts.push(`到價${stock.alerts.length}組`);
      if (stock.costAlerts.length > 0) parts.push(`損益提醒${stock.costAlerts.length}組`);
      if (stock.technicalEnabled) parts.push("技術指標已開啟");
      return parts.join("｜");
    };

    const core = [];
    const satellite = [];
    const uncategorized = [];
    for (const symbol of symbols) {
      const stock = ensureStockShape(stocksRaw[symbol]);
      if (stock.category === "core") core.push([symbol, stock]);
      else if (stock.category === "satellite") satellite.push([symbol, stock]);
      else uncategorized.push([symbol, stock]);
    }

    if (core.length > 0) {
      lines.push("", "🏛 核心持股：");
      for (const [symbol, stock] of core) lines.push(describeStockLine(symbol, stock));
    }
    if (satellite.length > 0) {
      lines.push("", "🛰 衛星持股：");
      for (const [symbol, stock] of satellite) lines.push(describeStockLine(symbol, stock));
    }
    if (uncategorized.length > 0) {
      lines.push("", "📈 尚未分類：");
      for (const [symbol, stock] of uncategorized) lines.push(describeStockLine(symbol, stock));
      lines.push("（可用「分類 股票代號 核心」或「分類 股票代號 衛星」分類）");
    }

    return lines.join("\n");
  }

  // ---------- 說明 ----------
  if (cmd === "說明" || cmd.toLowerCase() === "help") {
    return [
      "【美金】",
      "美金 - 查詢目前美金匯率",
      "美金兩週 - 查看近兩週的漲跌幅、高低點與日期",
      "美金日報 開 / 美金日報 關 - 開關每日美金報告",
      "美金提醒 高於33 / 美金提醒 低於31 - 新增到價提醒（可設多組）",
      "美金提醒清單 - 查看目前所有美金提醒",
      "刪除美金提醒 [編號] - 刪除指定的美金提醒",
      "",
      "【股票】",
      "查詢 2330 - 直接查詢股價，不用先加入清單",
      "新增 2330 - 加入自選股清單",
      "刪除 2330 - 移除自選股",
      "分類 2330 核心 / 分類 2330 衛星 - 標記長期核心持股或短期衛星持股（純顯示分組用）",
      "提醒 2330 高於600 - 用實際價格設到價提醒",
      "提醒清單 2330 / 刪除提醒 2330 1",
      "",
      "【成本、停利停損、加碼（核心持股逢低加碼很適合用這組）】",
      "成本 2330 550 - 設定持有成本",
      "損益 2330 - 查看目前損益 %",
      "停利 2330 15 - 漲到成本+15% 提醒",
      "停損 2330 8 - 跌到成本-8% 提醒",
      "加碼提醒 2330 10 - 跌到成本-10% 提醒（適合core持股逢低加碼）",
      "成本提醒清單 2330 / 刪除成本提醒 2330 1",
      "",
      "【技術指標（衛星持股波段操作輔助）】",
      "技術提醒 2330 開 - 開啟均線交叉(5日/20日) + RSI過熱過冷通知",
      "技術提醒 2330 關 - 關閉",
      "",
      "清單 - 總覽所有設定",
    ].join("\n");
  }

  return "看不懂這個指令 🤔 輸入「說明」看看可以做什麼。";
}

// ------------------------------------------------
// 給 GitHub Actions 排程呼叫的端點
// ------------------------------------------------

function checkCronAuth(req, res) {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

// 到價檢查：美金 + 所有有設定提醒的股票
app.get("/check-alerts", async (req, res) => {
  if (!checkCronAuth(req, res)) return;

  try {
    const userId = await redisLib.getUserId();
    if (!userId) return res.send("尚無使用者跟機器人說過話，略過檢查");

    const messages = [];

    // 美金
    const usdSettings = await redisLib.getUsdSettings();
    if (usdSettings.alerts.length > 0) {
      const usdQuote = await fetchQuote(USD_SYMBOL);
      let changed = false;
      for (const alert of usdSettings.alerts) {
        const { shouldNotify, newState } = evaluateAlert(alert, usdQuote.price);
        if (newState !== alert.state) {
          alert.state = newState;
          changed = true;
        }
        if (shouldNotify) {
          messages.push(
            `💵 美金到價提醒\n目前匯率：${usdQuote.price.toFixed(3)}\n條件：${describeAlert(alert)}`
          );
        }
      }
      if (changed) await redisLib.saveUsdSettings(usdSettings);
    }

    // 股票
    const stocks = await redisLib.getAllStocks();
    for (const [symbol, rawData] of Object.entries(stocks)) {
      const data = ensureStockShape(rawData);
      const hasPriceAlerts = data.alerts.length > 0;
      const hasCostAlerts = data.costBasis && data.costAlerts.length > 0;
      if (!hasPriceAlerts && !hasCostAlerts) continue;

      let quote;
      try {
        quote = await fetchQuote(symbol);
      } catch (err) {
        console.error(`查詢 ${symbol} 失敗:`, err.message);
        continue;
      }

      let changed = false;

      if (hasPriceAlerts) {
        for (const alert of data.alerts) {
          const { shouldNotify, newState } = evaluateAlert(alert, quote.price);
          if (newState !== alert.state) {
            alert.state = newState;
            changed = true;
          }
          if (shouldNotify) {
            messages.push(
              `📈 ${quote.name}（${symbol}）到價提醒\n目前價格：${quote.price.toFixed(2)}\n條件：${describeAlert(alert)}`
            );
          }
        }
      }

      if (hasCostAlerts) {
        for (const alert of data.costAlerts) {
          const priceAlert = costLib.toPriceAlert(data.costBasis, alert);
          const { shouldNotify, newState } = evaluateAlert(priceAlert, quote.price);
          if (newState !== alert.state) {
            alert.state = newState;
            changed = true;
          }
          if (shouldNotify) {
            messages.push(costLib.notifyText(symbol, quote.name, quote.price, data.costBasis, alert));
          }
        }
      }

      if (changed) await redisLib.saveStock(symbol, data);
    }

    if (messages.length > 0) {
      await lineLib.pushMessage(userId, messages.join("\n\n"));
    }

    res.send(`檢查完成，觸發 ${messages.length} 則提醒`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`錯誤: ${err.message}`);
  }
});

// 技術指標檢查：均線交叉 + RSI 區間轉換，一天檢查一次、只用收盤價判斷，避免盤中雜訊
app.get("/technical-check", async (req, res) => {
  if (!checkCronAuth(req, res)) return;

  try {
    const userId = await redisLib.getUserId();
    if (!userId) return res.send("尚無使用者跟機器人說過話，略過檢查");

    const messages = [];
    const stocks = await redisLib.getAllStocks();

    for (const [symbol, rawData] of Object.entries(stocks)) {
      const data = ensureStockShape(rawData);
      if (!data.technicalEnabled) continue;

      let points;
      try {
        points = await fetchHistory(symbol, 90, "3mo");
      } catch (err) {
        console.error(`查詢 ${symbol} 歷史資料失敗:`, err.message);
        continue;
      }

      const closes = points.map((p) => p.close);
      const name = symbol;
      let changed = false;

      const relation = computeMARelation(closes, 5, 20);
      if (relation && relation !== data.maRelation) {
        if (data.maRelation != null) {
          // 有基準狀態才通知，避免第一次開啟就誤判成一次交叉
          const crossType = relation === "above" ? "黃金交叉" : "死亡交叉";
          const emoji = relation === "above" ? "🌟" : "⚠️";
          messages.push(
            `${emoji} ${name} 出現${crossType}\n5日均線${relation === "above" ? "上穿" : "下穿"}20日均線，趨勢可能正在轉變`
          );
        }
        data.maRelation = relation;
        changed = true;
      }

      const rsi = computeRSI(closes, 14);
      const zone = rsiZone(rsi);
      if (zone !== data.rsiZone) {
        if (zone === "overbought") {
          messages.push(`🔥 ${name} RSI 進入過熱區間（RSI ${rsi.toFixed(1)}），短線漲多，留意拉回風險`);
        } else if (zone === "oversold") {
          messages.push(`🧊 ${name} RSI 進入過冷區間（RSI ${rsi.toFixed(1)}），短線跌深，留意反彈機會`);
        }
        data.rsiZone = zone;
        changed = true;
      }

      if (changed) await redisLib.saveStock(symbol, data);
    }

    if (messages.length > 0) {
      await lineLib.pushMessage(userId, messages.join("\n\n"));
    }

    res.send(`技術指標檢查完成，觸發 ${messages.length} 則提醒`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`錯誤: ${err.message}`);
  }
});

async function buildStockSummaryLines() {
  const stocks = await redisLib.getAllStocks();
  const symbols = Object.keys(stocks);
  if (symbols.length === 0) return ["目前沒有追蹤任何自選股。"];

  const lines = [];
  for (const symbol of symbols) {
    try {
      const q = await fetchQuote(symbol);
      const arrow = q.changePercent >= 0 ? "🔺" : "🔻";
      const sign = q.changePercent >= 0 ? "+" : "";
      lines.push(
        `${arrow} ${q.name}（${symbol}）：${q.price.toFixed(2)} (${sign}${q.changePercent.toFixed(2)}%)`
      );
    } catch {
      lines.push(`⚠️ ${symbol}：查詢失敗`);
    }
  }
  return lines;
}

function todayLabel() {
  return new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// 開盤前總結：主要用來看隔夜美股的變化 + 台股前一日收盤價
app.get("/premarket-summary", async (req, res) => {
  if (!checkCronAuth(req, res)) return;
  try {
    const userId = await redisLib.getUserId();
    if (!userId) return res.send("尚無使用者跟機器人說過話，略過總結");

    const stockLines = await buildStockSummaryLines();
    const lines = [`🌅 開盤前總結（${todayLabel()}）`, "", "📈 自選股：", ...stockLines];

    await lineLib.pushMessage(userId, lines.join("\n"));
    res.send("開盤前總結已發送");
  } catch (err) {
    console.error(err);
    res.status(500).send(`錯誤: ${err.message}`);
  }
});

// 收盤後總結：台股收盤價 + 美金匯率（如果有開啟每日報告）
app.get("/close-summary", async (req, res) => {
  if (!checkCronAuth(req, res)) return;
  try {
    const userId = await redisLib.getUserId();
    if (!userId) return res.send("尚無使用者跟機器人說過話，略過總結");

    const lines = [`🌇 收盤後總結（${todayLabel()}）`];

    const usdSettings = await redisLib.getUsdSettings();
    if (usdSettings.dailyReportEnabled) {
      const usd = await fetchQuote(USD_SYMBOL);
      const sign = usd.changePercent >= 0 ? "+" : "";
      lines.push("", `💵 美金匯率：${usd.price.toFixed(3)} (${sign}${usd.changePercent.toFixed(2)}%)`);
    }

    const stockLines = await buildStockSummaryLines();
    lines.push("", "📈 自選股：", ...stockLines);

    await lineLib.pushMessage(userId, lines.join("\n"));
    res.send("收盤後總結已發送");
  } catch (err) {
    console.error(err);
    res.status(500).send(`錯誤: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器啟動於 port ${PORT}`);
});
