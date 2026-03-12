# カスタマーサポートポータル — プロジェクトメモリ

## システム構成

| レイヤー | サービス | 用途 |
|---------|---------|------|
| フロントエンド | Cloudflare Pages `bfull-customersupport.pages.dev` | お客様向けポータル UI (`index.html` 単一ファイル) |
| バックエンド | Railway `customer-production-92e0.up.railway.app` | Express サーバー (`index.js`)。ポータル API・cron・webhook を担当 |
| DB | kintone App **786** | ポータル管理レコード |
| 問合せ元 | kintone App **125** | 問合せ管理（関連レコード参照のみ） |
| メール | Re:Lation API | お客様へのメール送信（OTP・ウェルカム・自動返信・担当者メッセージ） |
| 通知 | Discord Webhook | お客様からのメッセージ受信時に通知 |
| スタッフ操作 | kintone JS カスタマイズ (`app786_staff_panel_9`) | App786 詳細画面のダイアログ UI |

---

## デプロイ方法（重要）

### Cloudflare Pages（index.html）
git push では**自動デプロイされない**。以下のコマンドで手動デプロイする：

```bash
cd "D:\ClaudeCode\my-support-portal"
cp index.html deploy_tmp/
npx wrangler pages deploy deploy_tmp --project-name=bfull-customersupport --branch=main
```

### Railway（index.js）
git push で**自動デプロイ**される：
```bash
git add index.js
git commit -m "..."
git push origin main
```

### kintone JS カスタマイズ
MCPツールでは対応不可。手動でアップロード：
- kintone → App786 → アプリ設定 → JavaScriptカスタマイズ
- ファイル: `C:\Users\yagor\Downloads\app786_staff_panel_9 (5).js`

---

## 環境変数

### Railway（index.js 用）
| 変数名 | 内容 |
|--------|------|
| `KINTONE_DOMAIN` | `exk1223hafrf.cybozu.com` |
| `KINTONE_API_TOKEN` | App786 APIトークン |
| `KINTONE_APP_ID` | `786` |
| `PORTAL_BASE_URL` | `https://bfull-customersupport.pages.dev` |
| `KINTONE_ORIGIN` | `https://exk1223hafrf.cybozu.com`（スタッフパネル CORS 許可用）|
| `STAFF_SECRET` | スタッフ操作認証シークレット（64文字ランダム文字列）|
| `WEBHOOK_SECRET` | kintone Webhook 認証シークレット（64文字ランダム文字列）|
| `RELATION_SUBDOMAIN` | `bfull-corp` |
| `RELATION_API_KEY` | Re:Lation APIキー |
| `RELATION_MAILBOX_BFULL` | `1` |
| `RELATION_MAILBOX_INSIGHT` | `34` |
| `RELATION_MAIL_ACCOUNT_BFULL` | `34` |
| `RELATION_MAIL_ACCOUNT_INSIGHT` | `199` |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL |
| `STATUS_OPTIONS` | 進捗ステータス選択肢（カンマ区切り）|
| `TZ` | `Asia/Tokyo` 推奨 |

---

## App786 主要フィールド一覧

| フィールドコード | 型 | 用途 |
|----------------|-----|------|
| `アクセストークン` | SINGLE_LINE_TEXT | ポータルURL用UUID |
| `ポータルURL` | LINK | お客様専用URL |
| `ポータル公開フラグ` | CHECK_BOX | `['公開']` = 公開中 |
| `アクセス制限日時` | DATETIME | この日時を過ぎると自動非公開（cron）|
| `進捗ステータス` | SINGLE_LINE_TEXT | 現在の進捗 |
| `進捗履歴` | SUBTABLE | 進捗履歴タイムライン |
| `メッセージ履歴` | SUBTABLE | 双方向メッセージ |
| `担当者共有ファイル` | FILE | ポータル表示用ファイル |
| `OTPコード` | SINGLE_LINE_TEXT | 認証コード（一時保存）|
| `セッションキー` | SINGLE_LINE_TEXT | PII認証セッション |
| `お客様メールアドレス` | SINGLE_LINE_TEXT | 送信先メールアドレス |
| `ブランド` | DROP_DOWN | `Bfull FOTS JAPAN` / `インサイト` |

---

## 既知の注意点・仕様

### kintone クエリの空 DATETIME 挙動
`アクセス制限日時 <= "now"` は、フィールドが**空のレコードにも一致**する。
必ず `アクセス制限日時 != ""` を先頭条件に追加すること。

```js
// ✅ 正しい
`アクセス制限日時 != "" and アクセス制限日時 <= "${now}" and ポータル公開フラグ in ("公開")`

// ❌ NG（空レコードも一致し全件非公開になる）
`アクセス制限日時 <= "${now}" and ポータル公開フラグ in ("公開")`
```

### kintone サブテーブルの新規行追加
新規行に `id: null` を含めると API エラーになる。`id` フィールドは**省略**すること。

```js
// ✅ 正しい
{ value: { フィールド: { value: '...' } } }

// ❌ NG
{ id: null, value: { フィールド: { value: '...' } } }
```

### CORS 許可オリジン
Railway の Express サーバーは以下の2オリジンを許可：
- `PORTAL_BASE_URL`（Cloudflare Pages）
- `KINTONE_ORIGIN`（kintone スタッフパネル）

### ポータル公開フラグの削除機能
- ポータル向け GAS・担当者操作 GAS・kintone JS — **いずれにも非公開化機能なし**
- 自動非公開は Railway cron（毎時0分）のみ：`対応完了` ステータス後1ヶ月で自動非公開

---

## ブランド設定

| ブランド | Re:Lation 受信箱 | メールアカウント |
|---------|----------------|---------------|
| Bfull FOTS JAPAN | 1 | 34（info@fots.jp）|
| インサイト | 34 | 199（info@ape-insight.jp）|

ブランド判定: `ブランド` フィールドが `インサイト` → インサイト、それ以外 → Bfull FOTS JAPAN

---

## 作業ログ

### 2026-03-12
- セキュリティ強化・API効率化を実施（`caaf562`）
  - STAFF_SECRET・WEBHOOK_SECRET 認証追加
  - CORS を PORTAL_BASE_URL + KINTONE_ORIGIN に限定
  - OTP レート制限・セッション有効期限チェック強化
  - ファイルアップロードをリトライループ外に移動
- cron バグ修正（`5c4fee0`）：空の `アクセス制限日時` が全件一致する問題
- CORS バグ修正（`6c00387`）：kintone オリジンを許可リストに追加
- サブテーブル `id: null` バグ修正（`92c5d6e`）
- `次回ご連絡予定` の表示位置を CARD2（担当者メッセージ内）→ CARD1（お問合せ内容下）へ移動（`744cb8a`）
- Cloudflare Pages デプロイ方法確認：git push 非連携、wrangler CLI で手動デプロイ

### 2026-03-12（続）
- UI修正（`a6ef044`）：タイトル1行化・「管理No.」表示・担当者メッセージを進捗の上へ移動
- 個人情報告知文追加（`4481a51`）：CARD1 の kintone-note 下に 🔒 案内文を追加
- ブランド正規化バグ修正（`445f4c6`）：App125 の `B'full` → App786 `Bfull FOTS JAPAN` に変換する `normalizeBrand()` を追加。400エラーを解消
