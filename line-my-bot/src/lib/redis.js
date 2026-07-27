// 用 Upstash Redis 的 REST API 存資料（追蹤股票清單、美金到價區間、使用者 ID 等）。
// 不需要另外安裝 redis client，用 fetch 打 REST API 就好，Render 免費方案也能用。

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(...args) {
  const path = args.map((a) => encodeURIComponent(a)).join("/");
  const res = await fetch(`${UPSTASH_URL}/${path}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Redis 錯誤：${data.error}`);
  }
  return data.result;
}

// ---- 股票追蹤清單（用 Redis Set 存）----

async function getStockList() {
  const result = await redisCommand("SMEMBERS", "stocks");
  return result || [];
}

async function addStock(symbol) {
  return redisCommand("SADD", "stocks", symbol);
}

async function removeStock(symbol) {
  return redisCommand("SREM", "stocks", symbol);
}

// ---- 美金到價區間 ----

const DEFAULT_RANGE = { low: 31, high: 33 };

async function getUsdRange() {
  const raw = await redisCommand("GET", "usd_range");
  if (!raw) return DEFAULT_RANGE;
  try {
    return JSON.parse(raw);
  } catch {
    return DEFAULT_RANGE;
  }
}

async function setUsdRange(low, high) {
  return redisCommand("SET", "usd_range", JSON.stringify({ low, high }));
}

// ---- 到價提醒狀態（避免同一個狀態一直重複通知）----
// 狀態值：'above' | 'below' | 'none'

async function getAlertState() {
  const state = await redisCommand("GET", "usd_alert_state");
  return state || "none";
}

async function setAlertState(state) {
  return redisCommand("SET", "usd_alert_state", state);
}

// ---- 記住要推播給誰（LINE userId）----
// 使用者第一次跟機器人說話時會存下來，之後排程任務才知道要推播給誰

async function saveUserId(userId) {
  return redisCommand("SET", "target_user_id", userId);
}

async function getUserId() {
  return redisCommand("GET", "target_user_id");
}

module.exports = {
  getStockList,
  addStock,
  removeStock,
  getUsdRange,
  setUsdRange,
  getAlertState,
  setAlertState,
  saveUserId,
  getUserId,
};
