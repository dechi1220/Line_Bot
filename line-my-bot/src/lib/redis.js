// 用 Upstash Redis 的 REST API 存資料。
// v2 資料結構：
// - usd_settings：一個 JSON，存美金日報開關 + 多組到價提醒
// - stocks：一個 Redis Hash，field = 股票代號，value = 該股票的 JSON 設定（含提醒清單）
// - target_user_id：要推播給誰

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

// ---------------- 美金設定 ----------------
// { dailyReportEnabled: bool, alerts: [{ id, type: 'above'|'below', value, state: 'none'|'triggered' }] }

const DEFAULT_USD_SETTINGS = { dailyReportEnabled: true, alerts: [] };

async function getUsdSettings() {
  const raw = await redisCommand("GET", "usd_settings");
  if (!raw) return { ...DEFAULT_USD_SETTINGS, alerts: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      dailyReportEnabled: parsed.dailyReportEnabled ?? true,
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    };
  } catch {
    return { ...DEFAULT_USD_SETTINGS, alerts: [] };
  }
}

async function saveUsdSettings(settings) {
  return redisCommand("SET", "usd_settings", JSON.stringify(settings));
}

// ---------------- 股票設定（Hash：field=代號, value=JSON）----------------
// 每檔股票的 JSON： { alerts: [{ id, type, value, state }] }

async function getAllStocks() {
  const raw = await redisCommand("HGETALL", "stocks");
  const result = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      const symbol = raw[i];
      try {
        result[symbol] = JSON.parse(raw[i + 1]);
      } catch {
        result[symbol] = { alerts: [] };
      }
    }
  }
  return result;
}

async function getStock(symbol) {
  const raw = await redisCommand("HGET", "stocks", symbol);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { alerts: [] };
  }
}

async function saveStock(symbol, data) {
  return redisCommand("HSET", "stocks", symbol, JSON.stringify(data));
}

async function removeStock(symbol) {
  return redisCommand("HDEL", "stocks", symbol);
}

// ---------------- 使用者 ----------------

async function saveUserId(userId) {
  return redisCommand("SET", "target_user_id", userId);
}

async function getUserId() {
  return redisCommand("GET", "target_user_id");
}

module.exports = {
  getUsdSettings,
  saveUsdSettings,
  getAllStocks,
  getStock,
  saveStock,
  removeStock,
  saveUserId,
  getUserId,
};
