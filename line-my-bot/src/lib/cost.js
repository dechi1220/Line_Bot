// 「成本提醒」是根據使用者設定的持有成本 + 百分比，換算成實際目標價格，
// 再交給 alerts.js 裡同一套 evaluateAlert 邏輯判斷有沒有觸發。
//
// purpose 決定文字怎麼講、以及方向：
// - profit（停利）：目標價 = 成本 * (1 + percent/100)，價格「高於」目標價時觸發
// - loss（停損）／addon（加碼）：目標價 = 成本 * (1 - percent/100)，價格「低於」目標價時觸發
//   loss 跟 addon 數學算法完全一樣，只是給使用者不同情境（停損 vs 逢低加碼）分開講、分開設定

function targetPrice(costBasis, alert) {
  if (alert.purpose === "profit") {
    return costBasis * (1 + alert.percent / 100);
  }
  return costBasis * (1 - alert.percent / 100);
}

function toPriceAlert(costBasis, alert) {
  return {
    type: alert.purpose === "profit" ? "above" : "below",
    value: targetPrice(costBasis, alert),
    state: alert.state,
  };
}

function describeCostAlert(costBasis, alert) {
  const target = targetPrice(costBasis, alert);
  if (alert.purpose === "profit") {
    return `停利 +${alert.percent}%（目標價 ${target.toFixed(2)}）`;
  }
  if (alert.purpose === "loss") {
    return `停損 -${alert.percent}%（目標價 ${target.toFixed(2)}）`;
  }
  return `加碼 -${alert.percent}%（目標價 ${target.toFixed(2)}）`;
}

function notifyText(symbol, name, price, costBasis, alert) {
  const percentNow = (((price - costBasis) / costBasis) * 100).toFixed(2);
  if (alert.purpose === "profit") {
    return `🎯 ${name}（${symbol}）停利提醒\n目前價格：${price.toFixed(2)}\n目前損益：${percentNow}%（已達 +${alert.percent}% 目標）`;
  }
  if (alert.purpose === "loss") {
    return `🛑 ${name}（${symbol}）停損提醒\n目前價格：${price.toFixed(2)}\n目前損益：${percentNow}%（已跌破 -${alert.percent}% 停損線）`;
  }
  return `📥 ${name}（${symbol}）加碼提醒\n目前價格：${price.toFixed(2)}\n目前跌幅：${percentNow}%（已達 -${alert.percent}%，可考慮依計畫加碼）`;
}

module.exports = { targetPrice, toPriceAlert, describeCostAlert, notifyText };
