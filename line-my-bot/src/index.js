const express = require("express");
const crypto = require("crypto");
const { fetchQuote, fetchHistory } = require("./lib/yahoo");
const redisLib = require("./lib/redis");
const lineLib = require("./lib/line");
const { genId, evaluateAlert, describeAlert, parseAlertSpec } = require("./lib/alerts");
const { computeMARelation, computeRSI, rsiZone } = require("./lib/indicators");
const costLib = require("./lib/cost");

const app = express();

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
  res.send("LINE 美金/股票提醒機器人運作中 ✅ (v4)");
});

app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  if (!verifySignature(req.body, signature)) {
    return res.status(401).send("簽章驗證失敗");
  }

  res.status(200).send("OK");

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
    console.error("指令處理發生錯誤:", err);
    reply = `⚠️ 處理指令時發生錯誤：\n${err.message}`;
  }
  await lineLib.replyMessage(event.replyToken, reply);
}

function normalizeSymbol(raw) {
  const s = raw.toUpperCase();
  if (/^\d{4,6}$/.test(s)) return `${s}.TW`;
  return s;
}

function isUsdTarget(token) {
  return token === "美金" || token.toUpperCase() === "USD";
}

function formatQuoteLine(q) {
  const arrow = q.changePercent >= 0 ? "🔺" : "🔻";
  const sign = q.changePercent >= 0 ? "+" : "";
  return `${arrow} ${q.name}（${q.symbol}）\n目前價格：${q.price.toFixed(2)}\n今日漲跌：${sign}${q.change.toFixed(2)} (${sign}${q.changePercent.toFixed(2)}%)`;
}

function parsePercent(text) {
  const cleaned = (text || "").replace(/%/g, "").trim();
  const value = parseFloat(cleaned);
  if (Number.isNaN(value) || value <= 0) return null;
  return value;
}

function ensureStockShape(stock) {
  return {
    costBasis: stock?.costBasis ?? null,
    costAlerts: stock?.costAlerts || [],
    alerts: stock?.alerts || [],
    technicalEnabled: stock?.technicalEnabled || false,
    maRelation: stock?.maRelation ?? null,
    rsiZone: stock?.rsiZone || "neutral",
  };
}

function nowTaipeiHHMM() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hh = parts.find((p) => p.type === "hour").value;
  const mm = parts.find((p) => p.type === "minute").value;
  return `${hh}:${mm}`;
}

function todayTaipeiDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

async function handleCommand(text) {
  const [cmd, ...rest] = text.split(/\s+/);

  if (cmd === "美金" || cmd === "查詢美金") {
    try {
      const q = await fetchQuote(USD_SYMBOL);
      return `💵 美金即時匯率\n${formatQuoteLine({ ...q, name: "USD/TWD" })}`;
    } catch (err) {
      return `查詢美金匯率失敗：${err.message}`;
    }
  }

  if (cmd === "美金兩週") {
    try {
      const points = await fetchHistory(USD_SYMBOL, 10);
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

  if (cmd === "美金日報") {
    const arg = rest[0];
    if (!arg) {
      return "格式錯誤，請用：美金日報 1030（代表每天 10:30 發送）　或　美金日報 關";
    }

    if (arg === "關") {
      const settings = await redisLib.getUsdSettings();
      settings.dailyReportTime = null;
      await redisLib.saveUsdSettings(settings);
      return "已關閉美金日報";
    }

    const match = arg.match(/^([01]\d|2[0-3])([0-5]\d)$/);
    if (!match) {
      return "時間格式錯誤，請用 24 小時制四碼，例如：美金日報 1030（代表 10:30）";
    }
    const time = `${match[1]}:${match[2]}`;
    const settings = await redisLib.getUsdSettings();
    settings.dailyReportTime = time;
    settings.lastReportSentDate = null;
    await redisLib.saveUsdSettings(settings);
    return `已開啟美金日報，每天約 ${time} 發送`;
  }

  if (cmd === "提醒" && rest[0] && rest[1] !== undefined) {
    const target = rest[0];
    const spec = parseAlertSpec(rest.slice(1).join(""));
    if (!spec) {
      return "格式錯誤，請用：提醒 美金 高於33　或　提醒 2330 高於600";
    }

    if (isUsdTarget(target)) {
      const settings = await redisLib.getUsdSettings();
      settings.alerts.push({ id: genId(), type: spec.type, value: spec.value, state: "none" });
      await redisLib.saveUsdSettings(settings);
      return `已新增美金提醒：${describeAlert(spec)}`;
    }

    const symbol = normalizeSymbol(target);
    try {
      await fetchQuote(symbol);
    } catch {
      return `查不到「${symbol}」的報價，請確認代號是否正確。`;
    }
    let stock = await redisLib.getStock(symbol);
    const autoAdded = !stock;
    stock = ensureStockShape(stock);
    stock.alerts.push({ id: genId(), type: spec.type, value: spec.value, state: "none" });
    await redisLib.saveStock(symbol, stock);
    return `已新增「${symbol}」的到價提醒：${describeAlert(spec)}${autoAdded ? "\n（已自動加入自選股清單）" : ""}`;
  }

  if (cmd === "提醒清單") {
    const target = rest[0];

    if (!target) {
      const usdSettings = await redisLib.getUsdSettings();
      const stocks = await redisLib.getAllStocks();
      const lines = [];

      if (usdSettings.alerts.length > 0) {
        lines.push("💵 美金：");
        usdSettings.alerts.forEach((a, i) => lines.push(`${i + 1}. ${describeAlert(a)}`));
      }
      for (const [symbol, raw] of Object.entries(stocks)) {
        const stock = ensureStockShape(raw);
        if (stock.alerts.length === 0) continue;
        if (lines.length > 0) lines.push("");
        lines.push(`📈 ${symbol}：`);
        stock.alerts.forEach((a, i) => lines.push(`${i + 1}. ${describeAlert(a)}`));
      }
      return lines.length > 0 ? lines.join("\n") : "目前沒有設定任何到價提醒。";
    }

    if (isUsdTarget(target)) {
      const settings = await redisLib.getUsdSettings();
      if (settings.alerts.length === 0) return "目前沒有設定任何美金到價提醒。";
      const lines = settings.alerts.map((a, i) => `${i + 1}. ${describeAlert(a)}`);
      return `美金到價提醒：\n${lines.join("\n")}`;
    }

    const symbol = normalizeSymbol(target);
    const stock = ensureStockShape(await redisLib.getStock(symbol));
    if (stock.alerts.length === 0) return `「${symbol}」目前沒有設定任何到價提醒。`;
    const lines = stock.alerts.map((a, i) => `${i + 1}. ${describeAlert(a)}`);
    return `「${symbol}」的到價提醒：\n${lines.join("\n")}`;
  }

  if (cmd === "刪除提醒" && rest[0] && rest[1] !== undefined) {
    const target = rest[0];
    const index = parseInt(rest[1], 10) - 1;

    if (isUsdTarget(target)) {
      const settings = await redisLib.getUsdSettings();
      if (Number.isNaN(index) || index < 0 || index >= settings.alerts.length) {
        return "編號不存在，先傳「提醒清單 美金」確認編號。";
      }
      const removed = settings.alerts.splice(index, 1)[0];
      await redisLib.saveUsdSettings(settings);
      return `已刪除美金提醒：${describeAlert(removed)}`;
    }

    const symbol = normalizeSymbol(target);
    const stock = ensureStockShape(await redisLib.getStock(symbol));
    if (Number.isNaN(index) || index < 0 || index >= stock.alerts.length) {
      return `編號不存在，先傳「提醒清單 ${symbol}」確認編號。`;
    }
    const removed = stock.alerts.splice(index, 1)[0];
    await redisLib.saveStock(symbol, stock);
    return `已刪除「${symbol}」的提醒：${describeAlert(removed)}`;
  }

  if (cmd === "查詢" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    try {
      const q = await fetchQuote(symbol);
      return formatQuoteLine(q);
    } catch (err) {
      return `查不到「${symbol}」的報價，請確認代號是否正確。`;
    }
  }

  if (cmd === "新增" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    try {
      await fetchQuote(symbol);
    } catch {
      return `查不到「${symbol}」的報價，請確認代號是否正確。\n（台股輸入數字代號，例如 2330；美股輸入代碼，例如 AAPL）`;
    }
    const existing = await redisLib.getStock(symbol);
    if (existing) return `「${symbol}」已經在自選股清單裡了。`;
    await redisLib.saveStock(symbol, ensureStockShape(null));
    return `已新增自選股：${symbol}`;
  }

  if (cmd === "刪除" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    await redisLib.removeStock(symbol);
    return `已刪除自選股：${symbol}（相關的提醒也會一併移除）`;
  }

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

  if (cmd === "清單") {
    const stocksRaw = await redisLib.getAllStocks();
    const usdSettings = await redisLib.getUsdSettings();
    const symbols = Object.keys(stocksRaw);

    const lines = ["📋 目前設定總覽", ""];
    lines.push(`💵 美金日報：${usdSettings.dailyReportTime ? `每天約 ${usdSettings.dailyReportTime}` : "關閉"}`);
    lines.push(`💵 美金到價提醒：${usdSettings.alerts.length} 組`);

    if (symbols.length === 0) {
      lines.push("", "目前沒有追蹤任何股票（輸入「新增 股票代號」開始追蹤）");
      return lines.join("\n");
    }

    lines.push("", "📈 自選股：");
    for (const symbol of symbols) {
      const stock = ensureStockShape(stocksRaw[symbol]);
      const parts = [`・${symbol}`];
      if (stock.costBasis) parts.push(`成本${stock.costBasis}`);
      if (stock.alerts.length > 0) parts.push(`到價${stock.alerts.length}組`);
      if (stock.costAlerts.length > 0) parts.push(`損益提醒${stock.costAlerts.length}組`);
      if (stock.technicalEnabled) parts.push("技術指標已開啟");
      lines.push(parts.join("｜"));
    }

    return lines.join("\n");
  }

  if (cmd === "說明" || cmd.toLowerCase() === "help") {
    return [
      "【美金】",
      "「美金」查詢目前美金匯率",
      "「美金兩週」查看近兩週的漲跌幅、高低點與日期",
      "「美金日報 1030」開啟美金日報，每天約 10:30 發送（24小時制四碼）",
      "「美金日報 關」關閉美金日報",
      "",
      "【到價提醒（美金、股票通用）】",
      "「提醒 美金 高於33」「提醒 美金 低於31」新增美金到價提醒",
      "「提醒 2330 高於600」「提醒 2330 低於550」新增股票到價提醒（未加入清單會自動加入）",
      "「提醒清單」查看全部到價提醒",
      "「提醒清單 美金」「提醒清單 2330」查看指定的到價提醒",
      "「刪除提醒 美金 1」「刪除提醒 2330 1」用編號刪除",
      "",
      "【股票基本】",
      "「查詢 2330」直接查詢股價，不用先加入清單",
      "「新增 2330」加入自選股清單",
      "「刪除 2330」移除自選股",
      "",
      "【成本、停利停損、加碼】",
      "「成本 2330 550」設定持有成本",
      "「損益 2330」查看目前損益 %",
      "「停利 2330 15」漲到成本+15% 提醒",
      "「停損 2330 8」跌到成本-8% 提醒",
      "「加碼提醒 2330 10」跌到成本-10% 提醒（適合核心持股逢低加碼）",
      "「成本提醒清單 2330」「刪除成本提醒 2330 1」",
      "",
      "【技術指標（波段操作輔助）】",
      "「技術提醒 2330 開」開啟均線交叉(5日/20日) + RSI過熱過冷通知",
      "「技術提醒 2330 關」關閉",
      "",
      "「清單」總覽所有設定",
    ].join("\n");
  }

  return "看不懂這個指令 🤔 輸入「說明」看看可以做什麼。";
}

function checkCronAuth(req, res) {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

app.get("/check-alerts", async (req, res) => {
  if (!checkCronAuth(req, res)) return;

  try {
    const userId = await redisLib.getUserId();
    if (!userId) return res.send("尚無使用者跟機器人說過話，略過檢查");

    const messages = [];

    const usdSettings = await redisLib.getUsdSettings();
    let usdQuote = null;
    if (usdSettings.alerts.length > 0) {
      usdQuote = await fetchQuote(USD_SYMBOL);
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

    if (usdSettings.dailyReportTime) {
      const today = todayTaipeiDateStr();
      if (usdSettings.lastReportSentDate !== today) {
        const nowHHMM = nowTaipeiHHMM();
        const [nowH, nowM] = nowHHMM.split(":").map(Number);
        const [targetH, targetM] = usdSettings.dailyReportTime.split(":").map(Number);
        const diff = Math.abs(nowH * 60 + nowM - (targetH * 60 + targetM));
        if (diff <= 15) {
          const quote = usdQuote || (await fetchQuote(USD_SYMBOL));
          const sign = quote.changePercent >= 0 ? "+" : "";
          await lineLib.pushMessage(
            userId,
            `💵 美金日報\n目前匯率：${quote.price.toFixed(3)} (${sign}${quote.changePercent.toFixed(2)}%)`
          );
          usdSettings.lastReportSentDate = today;
          await redisLib.saveUsdSettings(usdSettings);
        }
      }
    }

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

app.get("/close-summary", async (req, res) => {
  if (!checkCronAuth(req, res)) return;
  try {
    const userId = await redisLib.getUserId();
    if (!userId) return res.send("尚無使用者跟機器人說過話，略過總結");

    const stockLines = await buildStockSummaryLines();
    const lines = [`🌇 收盤後總結（${todayLabel()}）`, "", "📈 自選股：", ...stockLines];

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
