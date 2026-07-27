const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 回覆訊息（回應使用者傳來的訊息，免費、不限次數，但只能在收到訊息後用一次）
async function replyMessage(replyToken, text) {
  await callLineApi("https://api.line.me/v2/bot/message/reply", {
    replyToken,
    messages: [{ type: "text", text }],
  });
}

// 主動推播訊息（排程任務要用這個，因為不是在回應使用者的訊息）
async function pushMessage(userId, text) {
  await callLineApi("https://api.line.me/v2/bot/message/push", {
    to: userId,
    messages: [{ type: "text", text }],
  });
}

async function callLineApi(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("LINE API 錯誤:", res.status, errText);
  }
}

module.exports = { replyMessage, pushMessage };
