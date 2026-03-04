# my-support-portal

カスタマーサポートポータルのバックエンドサーバー（Node.js/Express）。
GAS (Google Apps Script) から Railway へ移行したバージョンです。

---

## ディレクトリ構成

```
my-support-portal/
├── index.js        ← メインサーバー（全アクション統合）
├── package.json
├── .env.example    ← 環境変数テンプレート
└── README.md
```

---

## ローカル動作確認手順

### 1. 前提条件

- Node.js 20 以上がインストール済みであること
  ```
  node -v   # v20.x.x 以上
  ```

### 2. 依存パッケージのインストール

```bash
cd my-support-portal
npm install
```

### 3. 環境変数の設定

`.env.example` をコピーして `.env` を作成し、実際の値を入力します。

```bash
cp .env.example .env
```

`.env` を編集（例）:

```
PORT=3000
KINTONE_DOMAIN=exk1223hafrf.cybozu.com
KINTONE_API_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
KINTONE_APP_ID=786
RELATION_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
RELATION_SUBDOMAIN=mycompany
RELATION_MAILBOX_BFULL=1
RELATION_MAILBOX_INSIGHT=34
RELATION_MAIL_ACCOUNT_BFULL=34
RELATION_MAIL_ACCOUNT_INSIGHT=199
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
OTP_EXPIRY_MINUTES=15
OTP_MAX_ATTEMPTS=5
STATUS_OPTIONS=受付完了,ご内容確認中,ご返送依頼,検品中,修繕・交換作業中,発送準備中,発送済み,返金対応,口座情報-確認中,返金手続き中,お振込み,ご対応終了
```

### 4. サーバー起動

```bash
# 通常起動
npm start

# ファイル変更監視（開発時）
npm run dev
```

起動成功時のログ:
```
Server running on port 3000
Kintone App: exk1223hafrf.cybozu.com / App786
Re:Lation: mycompany.relationapp.jp
```

### 5. 動作確認（curl コマンド例）

#### ポータルデータ取得

```bash
curl "http://localhost:3000/?action=getPortalData&token=YOUR_TOKEN"
```

期待レスポンス（公開中）:
```json
{ "ok": true, "data": { "管理番号": "...", ... } }
```

#### OTP リクエスト

```bash
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"action":"requestOTP","token":"YOUR_TOKEN"}'
```

#### 進捗更新（担当者）

```bash
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"action":"updateProgress","recordId":"123","status":"検品中","progressNote":"検品中"}'
```

#### 進捗選択肢取得

```bash
curl "http://localhost:3000/?action=getStatusOptions"
```

#### Webhook テスト（kintone から届く形式を模倣）

```bash
curl -X POST http://localhost:3000/webhook/kintone \
  -H "Content-Type: application/json" \
  -d '{
    "type": "UPDATE_STATUS",
    "record": {
      "$id": { "value": "123" },
      "進捗ステータス": { "value": "対応完了" }
    }
  }'
```

---

## フロントエンド・カスタマイズJSの URL 変更

GAS の URL を Railway のデプロイ URL に差し替えるだけで動作します。

**変更前（GAS）:**
```
https://script.google.com/macros/s/XXXXXX/exec
```

**変更後（Railway）:**
```
https://your-app-name.railway.app
```

`index.html` および `app786_staff_panel_9.js` 内の GAS URL を Railway の URL に置換してください。

---

## Railway へのデプロイ手順

1. [Railway](https://railway.app) にログインしてプロジェクト作成
2. GitHub リポジトリを連携（またはローカルから `railway up`）
3. Railway のダッシュボードで環境変数を設定（`.env` の内容をすべて入力）
4. 推奨: `TZ=Asia/Tokyo` も環境変数に追加（タイムゾーン設定）
5. デプロイ完了後、Railway が発行する URL を確認
6. Kintone の Webhook 設定を `https://your-app.railway.app/webhook/kintone` に変更

---

## TODO リスト（未確認事項）

以下の `// TODO:` コメントが `index.js` 内にあります。実際の仕様に合わせて修正してください。

| 箇所 | 内容 |
|------|------|
| `sendMessage` | お客様→担当者への Re:Lation 通知メールの送信先（担当者メールアドレスの取得元） |
| `updateProgress` | `進捗担当者` フィールドへ担当者名を設定する場合、リクエストボディに追加 |
| `verifyOTP` | セッション有効期限の長さ（現在1時間） |
| `requestOTP` | Re:Lation サンドボックス環境がある場合は本番適用前に確認 |
| `webhook/kintone` | Railway の `TZ=Asia/Tokyo` 環境変数設定を推奨 |
| `cron` | Kintone の DATETIME クエリは UTC 基準で動作（保存値も UTC のため整合済み） |

---

## アクション一覧

| action | メソッド | 用途 |
|--------|---------|------|
| `getPortalData` | GET | ポータル表示用データ取得 |
| `getFiles` | GET | 担当者共有ファイル取得 |
| `requestOTP` | POST | OTP メール送信 |
| `verifyOTP` | POST | OTP 照合・セッション発行 |
| `getPII` | POST | 個人情報取得 |
| `savePII` | POST | 個人情報保存 |
| `sendMessage` | POST | お客様メッセージ送信 |
| `downloadMessageFile` | GET | メッセージ添付ファイルダウンロード |
| `getRecordForStaff` | GET | 担当者パネル用データ取得 |
| `updateProgress` | POST | 進捗更新 |
| `sendStaffMessage` | POST | 担当者メッセージ送信 |
| `setNextContactDate` | POST | 次回連絡予定日設定 |
| `getStatusOptions` | GET | 進捗選択肢取得 |
| `/webhook/kintone` | POST | Kintone Webhook 受信 |
