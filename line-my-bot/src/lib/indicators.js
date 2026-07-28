// 均線交叉、RSI 都是公開、機械化的技術分析公式，這裡只是照公式計算，
// 不涉及任何主觀判斷——最終要不要動作，還是使用者自己決定。
//
// 注意：這裡的 RSI 是簡化版（單純用最近 N 期的平均漲跌計算），
// 跟看盤軟體上用 Wilder's Smoothing 連續平滑運算的 RSI 數值可能會有些微差異，
// 拿來當「大概是不是過熱/過冷」的參考即可，不要拿來跟券商 App 的數字對到小數點。

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

// 回傳目前短天期均線相對於長天期均線的位置：'above' | 'below' | null（資料不足）
function computeMARelation(closes, shortPeriod = 5, longPeriod = 20) {
  const shortMA = computeSMA(closes, shortPeriod);
  const longMA = computeSMA(closes, longPeriod);
  if (shortMA == null || longMA == null) return null;
  return shortMA > longMA ? "above" : "below";
}

// 簡化版 RSI（0~100）
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// 把 RSI 數值分類成區間：'overbought'（過熱）| 'oversold'（過冷）| 'neutral'（正常）
function rsiZone(rsi) {
  if (rsi == null) return "neutral";
  if (rsi >= 70) return "overbought";
  if (rsi <= 30) return "oversold";
  return "neutral";
}

module.exports = { computeSMA, computeMARelation, computeRSI, rsiZone };
