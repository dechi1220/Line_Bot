# LINE 美金到價 + 每日股票總結機器人

功能：
1. 傳訊息管理你要追蹤的股票（台股/美股都支援）
2. 美金匯率超過你設定的區間時，主動推播提醒你
3. 每天固定時間（預設台北時間 14:00）發送美金匯率 + 所有追蹤股票的漲跌總結

全部用免費方案就能跑起來：**Render**（跑程式）+ **Upstash Redis**（存資料）+ **GitHub Actions**（排程觸發）。

---

## 你會用到的指令

跟機器人加好友之後，直接傳文字訊息：

| 指令 | 範例 | 說明 |
|---|---|---|
| 新增 [代號] | `新增 2330` 或 `新增 AAPL` | 開始追蹤這檔股票 |
| 刪除 [代號] | `刪除 2330` | 停止追蹤 |
| 清單 | `清單` | 看目前追蹤了哪些股票、美金區間設多少 |
| 設定匯率 [低] [高] | `設定匯率 31 33` | 改美金到價提醒的區間 |
| 說明 | `說明` | 列出所有指令 |

台股代號直接打數字就好（例如 `2330`），程式會自動補上 `.TW`。美股直接打代碼（例如 `AAPL`、`TSLA`）。

---

## 部署步驟

### 1. 建立 LINE Bot

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立一個 Provider，再建立一個 **Messaging API** channel
2. 在 channel 的「Messaging API」分頁：
   - 產生並複製 **Channel access token**（長期）
   - 「Basic settings」分頁可以找到 **Channel secret**
3. 先把「自動回應訊息」「加入好友的歡迎訊息」都關掉（Messaging API 分頁裡有開關），避免跟我們自己的邏輯打架
4. 用手機掃描 QR Code，把這個官方帳號加為好友（先加好友，之後才能收到推播）

### 2. 建立 Upstash Redis（免費）

1. 到 [upstash.com](https://upstash.com) 註冊，建立一個 Redis Database（選離你近的 region，例如新加坡或東京）
2. 進到 Database 詳情頁，找到 **REST API** 區塊，複製：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### 3. 上傳程式碼到 GitHub

把這個資料夾建立成一個新的 GitHub repository（可以設成 private）。

### 4. 部署到 Render（免費）

1. 到 [render.com](https://render.com)，New -> Web Service，選你剛剛的 repo
2. 設定：
   - Build Command: `npm install`
   - Start Command: `npm start`
3. 在 Environment 分頁加入環境變數（就是 `.env.example` 裡的那些）：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `CRON_SECRET`（自己隨便打一串英數字亂碼即可，例如用密碼產生器產生）
4. 部署完成後，你會拿到一個網址，例如 `https://your-bot.onrender.com`

> 提醒：Render 免費方案閒置一段時間會「睡著」，收到請求後幾秒內會醒過來再回應，第一次呼叫可能會慢個幾秒，屬正常現象。

### 5. 設定 LINE Webhook

回到 LINE Developers Console -> Messaging API 分頁：
1. Webhook URL 填：`https://your-bot.onrender.com/webhook`
2. 打開「Use webhook」開關
3. 點 Verify，確認顯示成功

### 6. 設定 GitHub Actions（排程）

到你的 GitHub repo -> Settings -> Secrets and variables -> Actions，新增兩個 Repository secrets：
- `APP_URL`：你的 Render 網址，例如 `https://your-bot.onrender.com`（結尾不要加 `/`）
- `CRON_SECRET`：跟 Render 環境變數裡設的那組亂碼一樣

推上 GitHub 後，Actions 分頁應該就會看到 `機器人排程任務` 這個 workflow。

### 7. 測試

1. 用手機傳「說明」給機器人，應該會收到指令列表
2. 傳「新增 2330」「新增 AAPL」「設定匯率 31 33」
3. 傳「清單」確認有存進去
4. 到 GitHub repo 的 Actions 分頁，找到 `機器人排程任務`，點右上角 **Run workflow** 手動觸發一次，確認會收到 LINE 推播（因為是手動觸發，`github.event.schedule` 會是空的，這次一定會走「到價檢查」那條路徑，可以先改 `src/index.js` 暫時直接測 `/daily-summary`，或直接瀏覽器打開 `https://your-bot.onrender.com/daily-summary?secret=你的CRON_SECRET` 測試也可以）

---

## 之後可以擴充的方向

- Yahoo Finance 的查詢介面是非官方的，如果之後常常查詢失敗，可以換成 TWSE OpenAPI（台股）+ Finnhub 免費方案（美股）
- 目前只支援一個使用者（一組 target_user_id）。如果你想讓家人朋友也能用，需要把資料結構改成「每個 userId 各自一份追蹤清單」
- 到價提醒目前只有美金，架構上很容易比照同樣邏輯加上個股的到價提醒
