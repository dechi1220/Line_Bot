const express = require("express");
const crypto = require("crypto");
const { fetchQuote } = require("./lib/yahoo");
const redisLib = require("./lib/redis");
const lineLib = require("./lib/line");

const app = express();

// LINE webhook 需要「原始 body」才能驗證簽章，所以這條路徑不能用 express.json()，
// 要用 express.raw() 拿到還沒被解析過的 Buffer。
app.use("/webhook", express.raw({ type: "*/*" }));

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;

function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

app.get("/", (req, res) => {
  res.send("LINE 美金/股票提醒機器人運作中 ✅");
});

app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  if (!verifySignature(req.body, signature)) {
    return res.status(401).send("簽章驗證失敗");
  }

  // 先回 200 給 LINE，避免處理太久導致 LINE 覺得逾時
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
    // 記住這個人，之後排程任務才能主動推播給他
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

async function handleCommand(text) {
  const [cmd, ...rest] = text.split(/\s+/);

  if (cmd === "新增" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    // 順便驗證一下這個代號查得到報價，避免使用者打錯字都不知道
    try {
      await fetchQuote(symbol);
    } catch (err) {
      return `查不到「${symbol}」的報價，請確認代號是否正確。\n（台股請輸入數字代號，例如 2330；美股請輸入代碼，例如 AAPL）`;
    }
    await redisLib.addStock(symbol);
    return `已新增追蹤：${symbol}`;
  }

  if (cmd === "刪除" && rest[0]) {
    const symbol = normalizeSymbol(rest[0]);
    await redisLib.removeStock(symbol);
    return `已刪除追蹤：${symbol}`;
  }

  if (cmd === "清單") {
    const list = await redisLib.getStockList();
    const range = await redisLib.getUsdRange();
    const stockPart = list.length
      ? `目前追蹤股票：\n${list.join("、")}`
      : "目前沒有追蹤任何股票（輸入「新增 股票代號」新增）";
    return `${stockPart}\n\n美金到價區間：${range.low} ~ ${range.high}`;
  }

  if (cmd === "設定匯率" && rest.length >= 2) {
    const low = parseFloat(rest[0]);
    const high = parseFloat(rest[1]);
    if (Number.isNaN(low) || Number.isNaN(high) || low >= high) {
      return "格式錯誤，請用：設定匯率 31 33（低點在前，高點在後）";
    }
    await redisLib.setUsdRange(low, high);
    await redisLib.setAlertState("none"); // 區間改了，通知狀態重置
    return `已更新美金到價區間：${low} ~ ${high}`;
  }

  if (cmd === "說明" || cmd.toLowerCase() === "help") {
    return [
      "可用指令：",
      "新增 [股票代號] - 例如「新增 2330」或「新增 AAPL」",
      "刪除 [股票代號] - 例如「刪除 2330」",
      "清單 - 查看目前追蹤清單與美金到價區間",
      "設定匯率 [低] [高] - 例如「設定匯率 31 33」",
    ].join("\n");
  }

  return "看不懂這個指令 🤔 輸入「說明」看看可以做什麼。";
}

// ---------------------------------------------
// 以下兩個端點給 GitHub Actions 排程呼叫，不是給使用者用的
// ---------------------------------------------

function checkCronAuth(req, res) {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

// 美金到價檢查：定期被呼叫，只有「跨越門檻」時才會推播，避免一直重複通知
app.get("/check-alerts", async (req, res) => {
  if (!checkCronAuth(req, res)) return;

  try {
    const userId = await redisLib.getUserId();
    if (!userId) {
      return res.send("尚無使用者跟機器人說過話，略過檢查");
    }

    const range = await redisLib.getUsdRange();
    const quote = await fetchQuote("TWD=X"); // USD/TWD 匯率
    const price = quote.price;
    const state = await redisLib.getAlertState();

    if (price > range.high && state !== "above") {
      await lineLib.pushMessage(
        userId,
        `🔺美金到價提醒\n目前匯率：${price.toFixed(3)}\n已高於設定上限 ${range.high}`
      );
      await redisLib.setAlertState("above");
    } else if (price < range.low && state !== "below") {
      await lineLib.pushMessage(
        userId,
        `🔻美金到價提醒\n目前匯率：${price.toFixed(3)}\n已低於設定下限 ${range.low}`
      );
      await redisLib.setAlertState("below");
    } else if (price >= range.low && price <= range.high && state !== "none") {
      await redisLib.setAlertState("none");
    }

    res.send(`檢查完成，目前匯率 ${price}`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`錯誤: ${err.message}`);
  }
});

// 每日總結：美金匯率 + 所有追蹤股票的漲跌
app.get("/daily-summary", async (req, res) => {
  if (!checkCronAuth(req, res)) return;

  try {
    const userId = await redisLib.getUserId();
    if (!userId) {
      return res.send("尚無使用者跟機器人說過話，略過總結");
    }

    const usd = await fetchQuote("TWD=X");
    const stockList = await redisLib.getStockList();

    const today = new Date().toLocaleDateString("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const lines = [
      `📊 每日總結（${today}）`,
      "",
      `💵 美金匯率：${usd.price.toFixed(3)} (${usd.changePercent >= 0 ? "+" : ""}${usd.changePercent.toFixed(2)}%)`,
    ];

    if (stockList.length > 0) {
      lines.push("", "📈 股票漲跌：");
      for (const symbol of stockList) {
        try {
          const q = await fetchQuote(symbol);
          const arrow = q.changePercent >= 0 ? "🔺" : "🔻";
          lines.push(
            `${arrow} ${q.name}（${symbol}）：${q.price.toFixed(2)} (${
              q.changePercent >= 0 ? "+" : ""
            }${q.changePercent.toFixed(2)}%)`
          );
        } catch (err) {
          lines.push(`⚠️ ${symbol}：查詢失敗`);
        }
      }
    }

    await lineLib.pushMessage(userId, lines.join("\n"));
    res.send("每日總結已發送");
  } catch (err) {
    console.error(err);
    res.status(500).send(`錯誤: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器啟動於 port ${PORT}`);
});
