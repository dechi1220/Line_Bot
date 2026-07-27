const express = require("express");
const crypto = require("crypto");
const { fetchQuote } = require("./lib/yahoo");
const redisLib = require("./lib/redis");
const lineLib = require("./lib/line");
const { genId, evaluateAlert, describeAlert, parseAlertSpec } = require("./lib/alerts");

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
  const reply = await handleCommand(text);
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

  // ---------- 總覽 ----------
  if (cmd === "清單") {
    const stocks = await redisLib.getAllStocks();
    const usdSettings = await redisLib.getUsdSettings();
    const symbols = Object.keys(stocks);

    const lines = ["📋 目前設定總覽", ""];
    lines.push(`💵 美金每日報告：${usdSettings.dailyReportEnabled ? "開啟" : "關閉"}`);
    lines.push(`💵 美金到價提醒：${usdSettings.alerts.length} 組`);
    lines.push("");

    if (symbols.length === 0) {
      lines.push("目前沒有追蹤任何股票（輸入「新增 股票代號」開始追蹤）");
    } else {
      lines.push("📈 自選股：");
      for (const symbol of symbols) {
        const alertCount = stocks[symbol].alerts?.length || 0;
        lines.push(`・${symbol}（${alertCount} 組提醒）`);
      }
    }

    return lines.join("\n");
  }

  // ---------- 說明 ----------
  if (cmd === "說明" || cmd.toLowerCase() === "help") {
    return [
      "【美金】",
      "美金 - 查詢目前美金匯率",
      "美金日報 開 / 美金日報 關 - 開關每日美金報告",
      "美金提醒 高於33 / 美金提醒 低於31 - 新增到價提醒（可設多組）",
      "美金提醒清單 - 查看目前所有美金提醒",
      "刪除美金提醒 [編號] - 刪除指定的美金提醒",
      "",
      "【股票】",
      "查詢 2330 - 直接查詢股價，不用先加入清單",
      "新增 2330 - 加入自選股清單",
      "刪除 2330 - 移除自選股",
      "提醒 2330 高於600 - 幫股票設到價提醒（未加入清單會自動加入）",
      "提醒清單 2330 - 查看該股票的提醒",
      "刪除提醒 2330 1 - 刪除該股票的第幾組提醒",
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
    for (const [symbol, data] of Object.entries(stocks)) {
      if (!data.alerts || data.alerts.length === 0) continue;
      let quote;
      try {
        quote = await fetchQuote(symbol);
      } catch (err) {
        console.error(`查詢 ${symbol} 失敗:`, err.message);
        continue;
      }
      let changed = false;
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
