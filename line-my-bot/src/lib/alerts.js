// 美金跟股票的到價提醒都共用這一套邏輯，避免同一個狀態一直重複通知。
//
// 每組提醒長這樣：{ id, type: 'above' | 'below', value, state: 'none' | 'triggered' }
// - type 'above'：價格 > value 時觸發
// - type 'below'：價格 < value 時觸發
// - 觸發後 state 會變成 'triggered'，直到價格回到門檻的另一側才會重置成 'none'，
//   這樣同一次突破只會通知一次，不會每次排程檢查都一直傳訊息。

function genId() {
  return Math.random().toString(36).slice(2, 7);
}

function evaluateAlert(alert, currentPrice) {
  const { type, value, state } = alert;

  if (type === "above") {
    if (currentPrice > value && state !== "triggered") {
      return { shouldNotify: true, newState: "triggered" };
    }
    if (currentPrice <= value && state === "triggered") {
      return { shouldNotify: false, newState: "none" };
    }
  } else if (type === "below") {
    if (currentPrice < value && state !== "triggered") {
      return { shouldNotify: true, newState: "triggered" };
    }
    if (currentPrice >= value && state === "triggered") {
      return { shouldNotify: false, newState: "none" };
    }
  }

  return { shouldNotify: false, newState: state || "none" };
}

function describeAlert(alert) {
  return alert.type === "above" ? `高於 ${alert.value}` : `低於 ${alert.value}`;
}

// 解析像「高於33」「低於 31.5」這樣的字串
function parseAlertSpec(text) {
  const cleaned = text.replace(/\s+/g, "");
  const match = cleaned.match(/^(高於|低於)([\d.]+)$/);
  if (!match) return null;
  const value = parseFloat(match[2]);
  if (Number.isNaN(value)) return null;
  return { type: match[1] === "高於" ? "above" : "below", value };
}

module.exports = { genId, evaluateAlert, describeAlert, parseAlertSpec };
