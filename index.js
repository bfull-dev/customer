require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const FormData = require('form-data');

const app = express();
const allowedOrigins = [
  process.env.PORTAL_BASE_URL || 'https://bfull-customersupport.pages.dev',
  process.env.KINTONE_ORIGIN  || 'https://exk1223hafrf.cybozu.com',
];
app.use(cors({
  origin: (origin, cb) => {
    // オリジンなし（curl等）または許可リストに含まれる場合は許可
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed: ' + origin));
  },
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Kintone カスタマイズJS（staff panel）は Content-Type: text/plain で JSON を送信するため対応
app.use(express.text({ type: 'text/plain', limit: '50mb' }));

const PORT = process.env.PORT || 3000;

// ─── 日時ヘルパー ─────────────────────────────────────────────────────────────

/** JST現在日時を ISO 8601 形式で返す（例: 2025-01-01T12:00:00+09:00） */
const nowJST = () => {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;
};

// ─── Kintone API ─────────────────────────────────────────────────────────────

const KINTONE_BASE = `https://${process.env.KINTONE_DOMAIN}/k/v1`;
const KINTONE_APP_ID = Number(process.env.KINTONE_APP_ID);

const kintoneGetHeaders = {
  'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN,
};
const kintonePostHeaders = {
  'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN,
  'Content-Type': 'application/json',
};

/** 複数レコード検索 */
const searchRecords = async (query) => {
  const res = await axios.get(`${KINTONE_BASE}/records.json`, {
    headers: kintoneGetHeaders,
    params: { app: KINTONE_APP_ID, query },
  });
  return res.data.records;
};

/** 1件取得 */
const getRecord = async (recordId) => {
  try {
    const url = `${KINTONE_BASE}/record.json?app=${KINTONE_APP_ID}&id=${recordId}`;
    console.log('[getRecord] URL:', url);
    const res = await axios.get(url, {
      headers: kintoneGetHeaders,
    });
    return res.data.record;
  } catch (error) {
    console.error('Kintone API Error:', error.response?.status, error.response?.data?.message);
    throw error;
  }
};

/**
 * レコード更新（revision=-1 でリビジョンチェックをスキップ）
 * 409 発生時は最大 retries 回リトライ（500ms 待機）
 */
const updateRecord = async (recordId, fields, revision = -1, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      await axios.put(
        `${KINTONE_BASE}/record.json`,
        {
          app: KINTONE_APP_ID,
          id: recordId,
          revision,
          record: fields,
        },
        { headers: kintonePostHeaders }
      );
      return;
    } catch (e) {
      if (e.response?.status === 409 && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
};

/** Kintone Files API にファイルをアップロードして fileKey を返す */
const uploadFile = async (name, type, base64data) => {
  const buffer = Buffer.from(base64data, 'base64');
  const form = new FormData();
  form.append('file', buffer, { filename: name, contentType: type });
  const res = await axios.post(`${KINTONE_BASE}/file.json`, form, {
    headers: {
      'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN,
      ...form.getHeaders(), // multipart/form-data; boundary=...
    },
  });
  return res.data.fileKey;
};

/** Kintone Files API からファイルを取得して base64 と contentType を返す */
const downloadFile = async (fileKey) => {
  const res = await axios.get(`${KINTONE_BASE}/file.json`, {
    headers: kintoneGetHeaders,
    params: { fileKey },
    responseType: 'arraybuffer',
  });
  return {
    data: Buffer.from(res.data).toString('base64'),
    type: res.headers['content-type'],
    name: extractFilenameFromHeader(res.headers['content-disposition'] || ''),
  };
};

/** Content-Disposition ヘッダーからファイル名を取り出す */
const extractFilenameFromHeader = (contentDisposition) => {
  // RFC 5987 形式: filename*=UTF-8''xxx
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);
  // 通常形式: filename="xxx"
  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (plainMatch) return plainMatch[1];
  return 'file';
};

// ─── Re:Lation API ────────────────────────────────────────────────────────────

// TODO: Re:Lation ベース URL のバージョンが v2 であることを確認してください
const RELATION_BASE = `https://${process.env.RELATION_SUBDOMAIN}.relationapp.jp/api/v2`;

const relationHeaders = {
  Authorization: `Bearer ${process.env.RELATION_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Re:Lation メール送信
 * POST /<mailboxId>/mails
 */
const sendRelationMail = async ({ mailboxId, mailAccountId, to, subject, body }) => {
  // TODO: Re:Lation API がサンドボックス環境を持つ場合、本番適用前に確認すること
  try {
    const res = await axios.post(
      `${RELATION_BASE}/${mailboxId}/mails`,
      {
        status_cd: 'ongoing',
        mail_account_id: Number(mailAccountId),
        to,
        subject,
        body,
        is_html: false,
      },
      { headers: relationHeaders }
    );
    return res.data; // { message_id, ticket_id }
  } catch (error) {
    console.error('[Re:Lation] Error status:', error.response?.status);
    console.error('[Re:Lation] Error data:', JSON.stringify(error.response?.data));
    console.error('[Re:Lation] Request URL:', error.config?.url);
    console.error('[Re:Lation] Request Body:', error.config?.data);
    throw error;
  }
};

// ─── Discord Webhook ─────────────────────────────────────────────────────────

const notifyDiscord = async (message, files = []) => {
  if (!process.env.DISCORD_WEBHOOK_URL) return;

  if (files.length === 0) {
    // テキストのみ
    await axios.post(process.env.DISCORD_WEBHOOK_URL, { content: message });
  } else {
    // ファイル添付あり → multipart/form-data で送信（複数対応）
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: message }));
    files.forEach((file, index) => {
      const buffer = Buffer.from(file.data, 'base64');
      form.append(`files[${index}]`, buffer, {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
      });
    });
    await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
      headers: form.getHeaders(),
    });
  }
};

// ─── ブランド名正規化（App125→App786）──────────────────────────────────────
// App125 の「B'full」「bfull」等の表記 → App786 DROP_DOWN の「Bfull FOTS JAPAN」に統一

const normalizeBrand = (raw) => {
  const v = (raw || '').trim();
  if (v === 'インサイト') return 'インサイト';
  // "B'full" / "Bfull" / "bfull" 等はすべて Bfull FOTS JAPAN へ
  return 'Bfull FOTS JAPAN';
};

// ─── ブランド → Re:Lation マッピング ─────────────────────────────────────────

const getRelationMailbox = (brand) => {
  if (brand === 'インサイト') {
    return {
      mailboxId: process.env.RELATION_MAILBOX_INSIGHT,
      mailAccountId: process.env.RELATION_MAIL_ACCOUNT_INSIGHT,
    };
  }
  // Bfull FOTS JAPAN その他
  return {
    mailboxId: process.env.RELATION_MAILBOX_BFULL,
    mailAccountId: process.env.RELATION_MAIL_ACCOUNT_BFULL,
  };
};

// ─── ① お客様向けアクション ──────────────────────────────────────────────────

/**
 * getPortalData
 * token でレコードを検索してポータル表示用データを返す
 */
const getPortalData = async (params) => {
  const { token } = params;
  const records = await searchRecords(`アクセストークン = "${token}" limit 1`);
  if (!records.length) return { ok: false, error: 'invalid_token' };

  const rec = records[0];
  const flag = rec['ポータル公開フラグ'].value;
  if (!Array.isArray(flag) || !flag.includes('公開')) {
    return { ok: false, error: 'portal_closed' };
  }

  const progressHistory = (rec['進捗履歴'].value || []).map((row) => ({
    進捗内容: row.value['進捗内容'].value,
    進捗記載日時: row.value['進捗記載日時'].value,
  }));

  const messageHistory = (rec['メッセージ履歴'].value || []).map((row) => ({
    送信者区分: row.value['送信者区分'].value,
    メッセージ本文: row.value['メッセージ本文'].value,
    送信日時: row.value['送信日時'].value,
    添付ファイル: (row.value['添付ファイル'].value || []).map((f) => ({
      key: f.fileKey,
      name: f.name,
    })),
  }));

  // 担当者メッセージは最新のもの（サブテーブルではなく単一フィールド）
  return {
    ok: true,
    data: {
      管理番号: rec['管理番号'].value,
      受付日: rec['受付日'].value,
      対象商品名: rec['対象商品名'].value,
      商品サブタイトル: rec['商品サブタイトル'].value,
      対応方法: rec['対応方法'].value,
      不具合内容: rec['不具合内容'].value,
      進捗ステータス: rec['進捗ステータス'].value,
      進捗履歴: progressHistory,
      担当者メッセージ: rec['担当者メッセージ'].value,
      次回ご連絡予定日: rec['次回ご連絡予定日'].value,
      次回予定: rec['次回予定'].value,
      メッセージ履歴: messageHistory,
      ブランド: rec['ブランド'].value,
    },
  };
};

/**
 * getFiles
 * 担当者共有ファイルを全件 base64 で返す
 */
const getFiles = async (params) => {
  const { token } = params;
  const records = await searchRecords(`アクセストークン = "${token}" limit 1`);
  if (!records.length) return { ok: false, error: 'invalid_token' };

  const rec = records[0];
  const attachments = rec['担当者共有ファイル'].value || [];

  const files = await Promise.all(
    attachments.map(async (f) => {
      const { data, type } = await downloadFile(f.fileKey);
      return { name: f.name, type, size: f.size, data };
    })
  );

  return { ok: true, files };
};

/**
 * requestOTP
 * 6桁OTPを生成・保存し、Re:Lation でお客様へ送信
 */
const requestOTP = async (params) => {
  const { token } = params;
  const records = await searchRecords(`アクセストークン = "${token}" limit 1`);
  if (!records.length) return { ok: false, error: 'invalid_token' };

  const rec = records[0];
  const recordId = rec['$id'].value;
  const email = rec['お客様メールアドレス'].value;
  const brand = rec['ブランド'].value;

  // OTP有効期限が残っている間は再発行しない（レート制限）
  const lastExpiry = rec['OTP有効期限'].value;
  if (lastExpiry && new Date() < new Date(lastExpiry)) {
    return { ok: false, error: 'otp_too_soon', message: 'しばらく経ってから再送してください。' };
  }

  const otp = crypto.randomInt(100000, 999999).toString();
  const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES || '15', 10);
  const expiry = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

  await updateRecord(recordId, {
    OTPコード: { value: otp },
    OTP有効期限: { value: expiry }, // SINGLE_LINE_TEXT に ISO 8601 文字列で保存
    OTP試行回数: { value: 0 },
  });

  const { mailboxId, mailAccountId } = getRelationMailbox(brand);
  await sendRelationMail({
    mailboxId,
    mailAccountId,
    to: email,
    subject: `【認証コード】${otp} - ご本人確認のお知らせ`,
    body: [
      `認証コード: ${otp}`,
      `有効期限: ${expiryMinutes}分`,
      '',
      'このコードはご本人確認のためのワンタイムパスワードです。',
      '有効期限を過ぎた場合は再度お手続きをお願いします。',
      'このメールに心当たりのない場合はお問い合わせください。',
    ].join('\n'),
  });

  return { ok: true };
};

/**
 * verifyOTP
 * OTPを照合してセッションキーを発行する
 */
const verifyOTP = async (params) => {
  const { token, otp } = params;
  const records = await searchRecords(`アクセストークン = "${token}" limit 1`);
  if (!records.length) return { ok: false, error: 'invalid_token' };

  const rec = records[0];
  const recordId = rec['$id'].value;
  const maxAttempts = parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10);
  const attempts = parseInt(rec['OTP試行回数'].value || '0', 10);

  if (attempts >= maxAttempts) return { ok: false, error: 'otp_locked' };

  const expiry = rec['OTP有効期限'].value;
  if (!expiry || new Date() > new Date(expiry)) {
    return { ok: false, error: 'otp_expired' };
  }

  if (rec['OTPコード'].value !== String(otp)) {
    await updateRecord(recordId, {
      OTP試行回数: { value: attempts + 1 },
    });
    return { ok: false, error: 'otp_invalid' };
  }

  // OTP 一致 → セッションキー発行
  const sessionKey = crypto.randomUUID();
  // TODO: セッション有効期限の長さを要件に応じて変更してください（現在1時間）
  const sessionExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await updateRecord(recordId, {
    セッションキー: { value: sessionKey },
    セッション有効期限: { value: sessionExpiry },
    OTPコード: { value: '' },
    OTP試行回数: { value: 0 },
    OTP有効期限: { value: '' },
  });

  return { ok: true, sessionKey };
};

/**
 * getPII
 * セッションキーを照合して個人情報を返す
 */
const getPII = async (params) => {
  const { token, sessionKey } = params;
  const records = await searchRecords(`アクセストークン = "${token}" limit 1`);
  if (!records.length) return { ok: false, error: 'invalid_token' };

  const rec = records[0];
  if (rec['セッションキー'].value !== sessionKey) {
    return { ok: false, error: 'invalid_session' };
  }
  const sessionExpiry = rec['セッション有効期限'].value;
  if (!sessionExpiry || new Date() > new Date(sessionExpiry)) {
    return { ok: false, error: 'session_expired' };
  }

  return {
    ok: true,
    data: {
      氏名: rec['氏名'].value,
      電話番号: rec['電話番号'].value,
      郵便番号: rec['郵便番号'].value,
      住所: rec['住所'].value,
      銀行名: rec['銀行名'].value,
      支店名: rec['支店名'].value,
      口座種別: rec['口座種別'].value,
      口座番号: rec['口座番号'].value,
      口座名義: rec['口座名義'].value,
    },
  };
};

/**
 * App786に入力された個人情報をApp619の対応レコードへ同期する
 * @param {string} kanriNumber - 管理番号（両アプリの紐付けキー）
 * @param {{ 氏名: string, 電話番号: string, 郵便番号: string, 住所: string }} personalInfo
 */
const syncPersonalInfoTo619 = async (kanriNumber, personalInfo) => {
  const domain = process.env.KINTONE_DOMAIN;
  const apiToken = process.env.KINTONE_APP619_TOKEN;
  const APP_ID = 619;

  const query = encodeURIComponent(`管理番号 = "${kanriNumber}" limit 1`);
  const searchRes = await axios.get(
    `https://${domain}/k/v1/records.json?app=${APP_ID}&query=${query}&fields[0]=$id`,
    { headers: { 'X-Cybozu-API-Token': apiToken } }
  );
  const records = searchRes.data.records;
  if (!records || records.length === 0) {
    console.warn(`[619sync] App619に管理番号「${kanriNumber}」のレコードが見つかりませんでした`);
    return;
  }
  const recordId = records[0].$id.value;

  await axios.put(
    `https://${domain}/k/v1/record.json`,
    {
      app: APP_ID,
      id: recordId,
      record: {
        氏名:     { value: personalInfo.氏名 },
        電話番号:  { value: personalInfo.電話番号 },
        郵便番号:  { value: personalInfo.郵便番号 },
        住所:     { value: personalInfo.住所 },
      },
    },
    { headers: { 'X-Cybozu-API-Token': apiToken, 'Content-Type': 'application/json' } }
  );
  console.log(`[619sync] App619 レコードID:${recordId} の個人情報を更新しました`);
};

/**
 * savePII
 * 個人情報を保存してセッションをクリアする
 */
const savePII = async (params) => {
  const {
    token,
    sessionKey,
    氏名,
    電話番号,
    郵便番号,
    住所,
    銀行名,
    支店名,
    口座種別,
    口座番号,
    口座名義,
  } = params;

  const records = await searchRecords(`アクセストークン = "${token}" limit 1`);
  if (!records.length) return { ok: false, error: 'invalid_token' };

  const rec = records[0];
  const recordId = rec['$id'].value;

  if (rec['セッションキー'].value !== sessionKey) {
    return { ok: false, error: 'invalid_session' };
  }
  const sessionExpiry2 = rec['セッション有効期限'].value;
  if (!sessionExpiry2 || new Date() > new Date(sessionExpiry2)) {
    return { ok: false, error: 'session_expired' };
  }

  const fields = {
    氏名: { value: 氏名 },
    電話番号: { value: 電話番号 },
    郵便番号: { value: 郵便番号 },
    住所: { value: 住所 },
    // セッションをクリア
    セッションキー: { value: '' },
    セッション有効期限: { value: '' },
  };
  if (銀行名 !== undefined) fields['銀行名'] = { value: 銀行名 };
  if (支店名 !== undefined) fields['支店名'] = { value: 支店名 };
  if (口座種別 !== undefined) fields['口座種別'] = { value: 口座種別 };
  if (口座番号 !== undefined) fields['口座番号'] = { value: 口座番号 };
  if (口座名義 !== undefined) fields['口座名義'] = { value: 口座名義 };

  const kanriNumber = rec['管理番号'].value;
  await updateRecord(recordId, fields);

  // ========== App619へ個人情報を同期 ==========
  try {
    await syncPersonalInfoTo619(kanriNumber, { 氏名, 電話番号, 郵便番号, 住所 });
  } catch (err) {
    // 619の更新失敗はログのみ。お客様へのレスポンスはブロックしない
    console.error('[619sync] 予期せぬエラー:', err);
  }

  return { ok: true };
};

/**
 * createPortal
 * App125 から呼び出し：App786 にレコードを作成してポータルURLを発行し案内メールを送信する
 */
const createPortal = async (params) => {
  const {
    管理番号,
    ブランド,
    対応方法,
    対象商品名,
    不具合内容,
    受付日,
    お客様メールアドレス,
    氏名,
  } = params;

  if (!管理番号 || !お客様メールアドレス) {
    return { ok: false, error: '管理番号とお客様メールアドレスは必須です' };
  }

  // App125 のブランド名を App786 DROP_DOWN の選択肢に正規化
  // 例: "B'full" → "Bfull FOTS JAPAN"
  const normalizedBrand = normalizeBrand(ブランド);

  // 重複チェック（同じ管理番号がすでに存在する場合）
  const existing = await searchRecords(`管理番号 = "${管理番号}" limit 1`);
  if (existing.length > 0) {
    const rec = existing[0];
    return {
      ok: false,
      error: 'already_exists',
      portalUrl: rec['ポータルURL']?.value || '',
      recordId:  rec['$id']?.value || '',
    };
  }

  // アクセストークン・ポータルURL生成
  const token = crypto.randomUUID();
  const portalBaseUrl = process.env.PORTAL_BASE_URL || '';
  const portalUrl = `${portalBaseUrl}?token=${token}`;

  // App786 にレコード作成
  const res = await axios.post(
    `${KINTONE_BASE}/record.json`,
    {
      app: KINTONE_APP_ID,
      record: {
        管理番号:             { value: 管理番号 },
        ブランド:             { value: normalizedBrand },
        対応方法:             { value: 対応方法 || '受付中' },
        対象商品名:           { value: 対象商品名 || '' },
        不具合内容:           { value: 不具合内容 || '' },
        受付日:               { value: 受付日 || '' },
        お客様メールアドレス: { value: お客様メールアドレス },
        氏名:                 { value: 氏名 || '' },
        アクセストークン:     { value: token },
        ポータルURL:          { value: portalUrl },
        ポータル公開フラグ:   { value: ['公開'] },
        進捗ステータス:       { value: '受付完了' },
      },
    },
    { headers: kintonePostHeaders }
  );

  const recordId = String(res.data.id);
  const brandName = normalizedBrand;
  const { mailboxId, mailAccountId } = getRelationMailbox(brandName);

  // Re:Lation でお客様へ案内メール送信
  try {
    await sendRelationMail({
      mailboxId,
      mailAccountId,
      to: お客様メールアドレス,
      subject: `【${brandName}】お問い合わせ対応状況確認ページのご案内`,
      body: [
        `${氏名 ? 氏名 + ' 様' : 'お客様'}`,
        '',
        `この度は${brandName}をご利用いただき、誠にありがとうございます。`,
        'お問い合わせ内容の対応状況をご確認いただけるページをご用意いたしました。',
        '',
        '▼ 対応状況確認ページ',
        portalUrl,
        '',
        '上記URLよりアクセスいただき、本件の対応をさせていただきます。',
        '（メールアドレス宛のご返信はご対応できない場合もございますので、ご注意ください。）',
        '',
        '────────────────────────',
        '【対応時間】',
        '平日 9:00〜18:00（12：00～13：00は除く）',
        '土日・祝日・夏季休暇・年末年始はメッセージの確認・返信ができません。',
        '休業日明けに順次ご対応いたします。',
        '────────────────────────',
        `${brandName} サポート窓口`,
      ].join('\n'),
    });
  } catch (mailErr) {
    console.error('[createPortal] Re:Lation mail error:', String(mailErr));
    return { ok: true, portalUrl, recordId, warning: `レコード作成成功。メール送信でエラーが発生しました: ${String(mailErr)}` };
  }

  return { ok: true, portalUrl, recordId };
};

/**
 * sendMessage
 * お客様からのメッセージをメッセージ履歴サブテーブルに追記し通知する
 */
const sendMessage = async (params) => {
  const { token, message, files = [] } = params;
  const records = await searchRecords(`アクセストークン = "${token}" limit 1`);
  if (!records.length) return { ok: false, error: 'invalid_token' };

  const rec = records[0];
  const recordId = rec['$id'].value;
  const revision = rec['$revision'].value;
  const 管理番号 = rec['管理番号'].value;

  // ファイルアップロード
  const uploadedFileKeys = [];
  const uploadedFileNames = [];
  for (const file of files) {
    const fileKey = await uploadFile(file.name, file.type, file.data);
    uploadedFileKeys.push({ fileKey });
    uploadedFileNames.push(file.name);
  }

  // メッセージ履歴サブテーブルに追記（既存 + 新規行）
  const existingMessages = rec['メッセージ履歴'].value || [];
  const newRow = {
    id: null, // null で新規行追加
    value: {
      送信者区分: { value: 'お客様' },
      メッセージ本文: { value: message },
      送信日時: { value: new Date().toISOString() },
      添付ファイル: { value: uploadedFileKeys },
    },
  };

  await axios.put(
    `${KINTONE_BASE}/record.json`,
    {
      app: KINTONE_APP_ID,
      id: recordId,
      revision,
      record: {
        メッセージ履歴: { value: [...existingMessages, newRow] },
      },
    },
    { headers: kintonePostHeaders }
  );

  // TODO: Re:Lation API でお客様→担当者への通知メール送信
  // 担当者の通知先メールアドレスの取得方法を確認してください。
  // App786 に担当者メールアドレスフィールドがあれば以下のコメントを解除してください:
  // const brand = rec['ブランド'].value;
  // const { mailboxId, mailAccountId } = getRelationMailbox(brand);
  // await sendRelationMail({
  //   mailboxId,
  //   mailAccountId,
  //   to: '担当者メールアドレス', // TODO: 担当者のメールアドレスを取得する方法を確認
  //   subject: `【お客様メッセージ受信】管理番号: ${管理番号}`,
  //   body: message,
  // });

  // Discord 通知（添付ファイルがあれば一緒に送信）
  const kintoneRecordUrl = `https://${process.env.KINTONE_DOMAIN}/k/${KINTONE_APP_ID}/show#record=${recordId}`;
  await notifyDiscord(
    `📩 お客様からメッセージが届きました\n管理番号: ${管理番号}\n本文:\n${message}\n🔗 ${kintoneRecordUrl}`,
    files
  );

  return { ok: true, uploadedFileNames };
};

/**
 * downloadMessageFile
 * メッセージ履歴の添付ファイルを base64 で返す
 */
const downloadMessageFile = async (params) => {
  const { token, fileKey } = params;
  const records = await searchRecords(`アクセストークン = "${token}" limit 1`);
  if (!records.length) return { ok: false, error: 'invalid_token' };

  const rec = records[0];
  const allFileKeys = (rec['メッセージ履歴'].value || []).flatMap((row) =>
    (row.value['添付ファイル']?.value || []).map((f) => f.fileKey)
  );
  if (!allFileKeys.includes(fileKey)) {
    return { ok: false, error: 'file_not_found' };
  }

  const res = await axios.get(`${KINTONE_BASE}/file.json`, {
    headers: kintoneGetHeaders,
    params: { fileKey },
    responseType: 'arraybuffer',
  });

  const contentType = res.headers['content-type'];
  const name = extractFilenameFromHeader(res.headers['content-disposition'] || '');

  return {
    ok: true,
    data: Buffer.from(res.data).toString('base64'),
    type: contentType,
    name,
  };
};

// ─── ② 担当者操作専用アクション ──────────────────────────────────────────────

/**
 * getRecordForStaff
 * 担当者パネル用データを返す
 */
const getRecordForStaff = async (params) => {
  const { recordId } = params;
  const rec = await getRecord(recordId);

  // 進捗履歴の最新行（日時 + 内容）
  const progressHistory = rec['進捗履歴']?.value || [];
  let 最新進捗 = '';
  if (progressHistory.length > 0) {
    const last = progressHistory[progressHistory.length - 1].value;
    const dt  = last['進捗記載日時']?.value ? last['進捗記載日時'].value.replace('T', ' ').slice(0, 16) : '';
    const txt = last['進捗内容']?.value || '';
    最新進捗 = dt ? `${dt}　${txt}` : txt;
  }

  // メッセージ履歴の最新行（送信者 + 本文80文字）
  const messageHistory = rec['メッセージ履歴']?.value || [];
  let 直近メッセージ = '';
  if (messageHistory.length > 0) {
    const lastMsg = messageHistory[messageHistory.length - 1].value;
    const sender  = lastMsg['送信者区分']?.value || '';
    const text    = lastMsg['メッセージ本文']?.value || '';
    直近メッセージ = `（${sender}）${text.substring(0, 80)}`;
  }

  // 担当者共有ファイル（FILEフィールド）
  const fileVal = rec['担当者共有ファイル']?.value;
  const 共有ファイル = Array.isArray(fileVal) ? fileVal.map((f) => f.name).filter(Boolean) : [];

  // STATUS_OPTIONS をそのまま statusOptions として返す
  const statusOptions = (process.env.STATUS_OPTIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const progressNoteOptions = statusOptions.length > 0 ? statusOptions : [
    '受付完了','ご内容確認中','ご返送依頼','検品中','修繕・交換作業中',
    '発送準備中','発送済み','返金対応','口座情報-確認中','返金手続き中','お振込み','ご対応終了',
  ];

  return {
    ok: true,
    data: {
      進捗ステータス:  rec['進捗ステータス']?.value      || '',
      最新進捗,
      お客様メール:    rec['お客様メールアドレス']?.value || '',
      直近メッセージ,
      共有ファイル,
      次回連絡日:      rec['次回ご連絡予定日']?.value     || '',
      管理番号:        rec['管理番号']?.value             || '',
      ブランド:        rec['ブランド']?.value             || '',
      statusOptions,
      progressNoteOptions,
    },
  };
};

/**
 * updateProgress
 * 進捗ステータス更新 + 進捗履歴サブテーブルへ追記
 * revision を毎回取得して 409 対策
 */
const updateProgress = async (params) => {
  const { recordId, status, progressNote } = params;
  console.log('[updateProgress] status:', status);
  console.log('[updateProgress] progressNote:', progressNote);

  for (let i = 0; i < 3; i++) {
    try {
      const rec = await getRecord(recordId);
      const revision = rec['$revision'].value;
      const existingProgress = rec['進捗履歴'].value || [];

      const newRow = {
        value: {
          進捗内容: { value: progressNote },
          進捗記載日時: { value: nowJST() },
          進捗担当者: { value: '' },
        },
      };

      await axios.put(
        `${KINTONE_BASE}/record.json`,
        {
          app: KINTONE_APP_ID,
          id: recordId,
          revision,
          record: {
            進捗ステータス: { value: status },
            進捗履歴: { value: [...existingProgress, newRow] },
          },
        },
        { headers: kintonePostHeaders }
      );

      return { ok: true };
    } catch (e) {
      console.error('[updateRecord] Error status:', e.response?.status);
      console.error('[updateRecord] Error data:', JSON.stringify(e.response?.data));
      console.error('[updateRecord] Request URL:', e.config?.url);
      console.error('[updateRecord] Request Body:', e.config?.data);
      if (e.response?.status === 409 && i < 2) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
};

/**
 * sendStaffMessage
 * 担当者メッセージをサブテーブルに追記し Re:Lation でお客様へ送信
 */
const sendStaffMessage = async (params) => {
  const { recordId, message, files = [] } = params;

  // ファイルアップロードはリトライ外で1度だけ実行（重複アップロード防止）
  const uploadedFileKeys = await Promise.all(
    files.map(async (file) => {
      const fileKey = await uploadFile(file.name, file.type, file.data);
      return { fileKey };
    })
  );

  for (let i = 0; i < 3; i++) {
    try {
      const rec = await getRecord(recordId);
      const revision = rec['$revision'].value;

      // メッセージ履歴サブテーブルに追記
      const existingMessages = rec['メッセージ履歴'].value || [];
      const newRow = {
        id: null,
        value: {
          送信者区分: { value: '担当者' },
          メッセージ本文: { value: message },
          送信日時: { value: nowJST() },
          添付ファイル: { value: uploadedFileKeys },
        },
      };

      const brandName = rec['ブランド']?.value || 'Bfull FOTS JAPAN';
      const { mailboxId, mailAccountId } = getRelationMailbox(brandName);
      const email = rec['お客様メールアドレス'].value;
      const 管理番号 = rec['管理番号'].value;
      const portalUrl = rec['ポータルURL']?.value || '';
      const status = rec['進捗ステータス']?.value || '';

      await axios.put(
        `${KINTONE_BASE}/record.json`,
        {
          app: KINTONE_APP_ID,
          id: recordId,
          revision,
          record: {
            メッセージ履歴: { value: [...existingMessages, newRow] },
            担当者メッセージ: { value: message }, // ポータル表示用フィールドにも反映
          },
        },
        { headers: kintonePostHeaders }
      );

      // Re:Lation でお客様へメール送信
      const mailBody = [
        `${brandName} サポート窓口です。`,
        '',
        '担当者よりメッセージが届いております。',
        '以下の内容をご確認ください。',
        '',
        '────────────────────────',
        message,
        '────────────────────────',
        '',
        `　現在のステータス：${status}`,
        '',
        'ご不明な点がございましたら、対応状況確認ページより',
        'メッセージをお送りください。',
        '',
        '　▼ お問合せ状況確認ページ',
        `　${portalUrl}`,
        '',
        '────────────────────────',
        '【対応時間】',
        '平日 9:00〜18:00（12：00～13：00は除く）',
        '土日・祝日・夏季休暇・年末年始はメッセージの確認・返信ができません。',
        '休業日明けに順次ご対応いたします。',
        '────────────────────────',
        `${brandName} サポート窓口`,
      ].join('\n');

      try {
        await sendRelationMail({
          mailboxId,
          mailAccountId,
          to: email,
          subject: `【${brandName}】担当者よりメッセージが届いています（管理番号：${管理番号}）`,
          body: mailBody,
        });
      } catch (mailErr) {
        // メール送信エラーはログのみ（Kintone更新は成功扱い）
        console.error('Re:Lation mail error:', String(mailErr));
        return { ok: true, warning: `Kintone更新成功。メール送信でエラーが発生しました: ${String(mailErr)}` };
      }

      return { ok: true };
    } catch (e) {
      if (e.response?.status === 409 && i < 2) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
};

/**
 * setNextContactDate
 * 次回ご連絡予定日と次回予定を更新する
 */
const setNextContactDate = async (params) => {
  const { recordId, date, note } = params;
  const fields = {
    次回ご連絡予定日: { value: date },
  };
  if (note !== undefined) {
    fields['次回予定'] = { value: note };
  }
  await updateRecord(recordId, fields); // revision=-1 でリビジョンチェックをスキップ
  return { ok: true };
};

/**
 * getStatusOptions
 * 進捗内容の選択肢を返す
 */
const getStatusOptions = async () => {
  const options = (process.env.STATUS_OPTIONS || '').split(',').filter(Boolean);
  return { ok: true, options };
};

// ─── Router ───────────────────────────────────────────────────────────────────

const router = async (req, res) => {
  // Content-Type: text/plain で送られた JSON ボディを解析（Kintone カスタマイズJS対応）
  let bodyParams = {};
  if (typeof req.body === 'string') {
    try { bodyParams = JSON.parse(req.body); } catch (_) {}
  } else if (req.body && typeof req.body === 'object') {
    bodyParams = req.body;
  }
  const params = { ...req.query, ...bodyParams };
  const action = params.action;

  try {
    let result;
    switch (action) {
      // App125 連携
      case 'createPortal':
        result = await createPortal(params);
        break;
      // お客様向け
      case 'getPortalData':
        result = await getPortalData(params);
        break;
      case 'getFiles':
        result = await getFiles(params);
        break;
      case 'requestOTP':
        result = await requestOTP(params);
        break;
      case 'verifyOTP':
        result = await verifyOTP(params);
        break;
      case 'getPII':
        result = await getPII(params);
        break;
      case 'savePII':
        result = await savePII(params);
        break;
      case 'sendMessage':
        result = await sendMessage(params);
        break;
      case 'downloadMessageFile':
        result = await downloadMessageFile(params);
        break;
      // 担当者向け（STAFF_SECRET による認証）
      case 'getRecordForStaff':
      case 'updateProgress':
      case 'sendStaffMessage':
      case 'setNextContactDate':
      case 'getStatusOptions': {
        if (process.env.STAFF_SECRET && params.staffSecret !== process.env.STAFF_SECRET) {
          result = { ok: false, error: 'unauthorized' };
          break;
        }
        if (action === 'getRecordForStaff') result = await getRecordForStaff(params);
        else if (action === 'updateProgress') result = await updateProgress(params);
        else if (action === 'sendStaffMessage') result = await sendStaffMessage(params);
        else if (action === 'setNextContactDate') result = await setNextContactDate(params);
        else result = await getStatusOptions();
        break;
      }
      default:
        result = { ok: false, error: 'unknown_action' };
    }
    res.json(result);
  } catch (e) {
    console.error(`[${action}] Error:`, e.stack || e.message);
    res.json({ ok: false, error: e.message || 'server_error' });
  }
};

app.get('/', router);
app.post('/', router);

// ─── ③-a App619 配送メール送信 ───────────────────────────────────────────────

/**
 * POST /api/send-shipping-mail-619
 * App619 Kintone JS から呼び出し。配送完了メールを Re:Lation 経由で送信する。
 */
app.post('/api/send-shipping-mail-619', async (req, res) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { secret, brand, to, subject, mailBody } = body;

  if (!process.env.STAFF_SECRET || secret !== process.env.STAFF_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!to || !subject || !mailBody) {
    return res.status(400).json({ ok: false, error: 'missing_params' });
  }

  try {
    const { mailboxId, mailAccountId } = getRelationMailbox(brand || '');
    await sendRelationMail({ mailboxId, mailAccountId, to, subject, body: mailBody });
    console.log(`[619mail] 配送メール送信完了 → ${to} (brand: ${brand})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[619mail] Error:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── ③-b App619 お客様返送状況「着荷」Discord通知 ─────────────────────────────

/**
 * POST /webhook/kintone-619
 * App619 の EDIT_RECORD イベントを受け取り、
 * お客様返送状況 = 着荷 になったら中村さん宛 Discord チャンネルへ通知する。
 *
 * 環境変数:
 *   DISCORD_619_ARRIVES_WEBHOOK — 専用 Discord チャンネルの Webhook URL
 *   WEBHOOK_619_SECRET          — kintone Webhook トークン（任意）
 */

// 同一レコードへの重複通知を防ぐ（24 時間キャッシュ）
const arrivedNotifiedIds = new Set();
setInterval(() => arrivedNotifiedIds.clear(), 24 * 60 * 60 * 1000);

app.post('/webhook/kintone-619', async (req, res) => {
  // URL クエリパラメータ認証 (?k=シークレット)
  // kintone Webhook にはトークン欄がないため URL に埋め込む方式を採用
  if (process.env.WEBHOOK_619_SECRET) {
    if (req.query.k !== process.env.WEBHOOK_619_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  try {
    const { type, record } = req.body;

    // EDIT_RECORD 以外は無視
    if (type !== 'EDIT_RECORD') return res.json({ ok: true, skipped: `type=${type}` });
    if (!record) return res.json({ ok: true, skipped: 'no record' });

    // 返送状況の値を取得（フィールドコード: 返送状況 / RADIO_BUTTON型 / 選択肢: 未着・着荷）
    const raw = record['返送状況']?.value ?? '';
    const statusVal = Array.isArray(raw) ? raw.join('') : String(raw);

    if (statusVal !== '着荷') {
      return res.json({ ok: true, skipped: `status=${statusVal}` });
    }

    // 重複通知チェック
    const recordId = String(record['$id']?.value ?? '');
    if (arrivedNotifiedIds.has(recordId)) {
      return res.json({ ok: true, skipped: 'already_notified' });
    }
    arrivedNotifiedIds.add(recordId);

    // Discord メッセージ組み立て
    const kanriNo  = record['管理番号']?.value  || '（未設定）';
    const name     = record['氏名']?.value      || '（未設定）';
    const product  = record['商品名']?.value    || '（未設定）';
    const domain   = process.env.KINTONE_DOMAIN;
    const recUrl   = `https://${domain}/k/619/show#record=${recordId}`;

    const message =
      '🏭 **不具合品が千秋工場へ到着しました**\n' +
      'お客様へ不具合品荷受けのご連絡をしてください。\n\n' +
      `📋 管理番号：${kanriNo}\n` +
      `👤 お客様名：${name}\n` +
      `📦 商品名：${product}\n` +
      `🔗 ${recUrl}`;

    const webhookUrl = process.env.DISCORD_619_ARRIVES_WEBHOOK;
    if (!webhookUrl) {
      console.warn('[619arrives] DISCORD_619_ARRIVES_WEBHOOK が未設定です');
      return res.json({ ok: true, warning: 'Discord webhook URL not configured' });
    }

    await axios.post(webhookUrl, { content: message });
    console.log(`[619arrives] Discord通知完了 管理番号:${kanriNo} recordId:${recordId}`);
    res.json({ ok: true });

  } catch (e) {
    console.error('[619arrives] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── ③ Webhook: Kintone ──────────────────────────────────────────────────────

/**
 * POST /webhook/kintone
 * UPDATE_STATUS イベントで「対応完了」になった場合に1ヶ月後12:00をアクセス制限日時に設定
 */
app.post('/webhook/kintone', async (req, res) => {
  if (process.env.WEBHOOK_SECRET) {
    const provided = req.headers['x-webhook-secret'];
    if (!provided || provided !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }
  try {
    const { type, record } = req.body;

    // UPDATE_STATUS 以外は無視
    if (type !== 'UPDATE_STATUS') return res.json({ ok: true });

    const status = record?.進捗ステータス?.value;
    if (status === '対応完了') {
      const recordId = record['$id'].value;

      // 現在の日時から1ヶ月後の12:00（日本時間）
      // TODO: サーバーのタイムゾーンに依存するため、Railway の TZ 環境変数を Asia/Tokyo に設定推奨
      const oneMonthLater = new Date();
      oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
      oneMonthLater.setHours(12, 0, 0, 0);

      await updateRecord(recordId, {
        アクセス制限日時: { value: oneMonthLater.toISOString() },
      });
      console.log(`[webhook] レコード ${recordId} アクセス制限日時を設定: ${oneMonthLater.toISOString()}`);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook/kintone] Error:', e.stack || e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ─── Cron: 毎時0分 アクセス制限チェック ─────────────────────────────────────

/**
 * アクセス制限日時を過ぎたレコードのポータル公開フラグをクリアする
 * TODO: Kintone の DATETIME クエリは UTC で比較されます。
 *       Railway の TZ 環境変数を Asia/Tokyo に設定してもクエリの基準は UTC のままです。
 *       アクセス制限日時フィールドへの保存値（toISOString() = UTC）と整合しています。
 */
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    // アクセス制限日時が設定済み かつ 期限切れ かつ まだ公開中のレコードを取得
    // ※ アクセス制限日時が空のレコードは除外（空値は kintone で最古日時扱いとなるため誤検知防止）
    const records = await searchRecords(
      `アクセス制限日時 != "" and アクセス制限日時 <= "${now}" and ポータル公開フラグ in ("公開") limit 100`
    );

    if (!records.length) {
      console.log('[cron] アクセス制限対象レコードなし');
      return;
    }

    const updateData = records.map((rec) => ({
      id: rec['$id'].value,
      record: { ポータル公開フラグ: { value: [] } },
    }));
    await axios.put(
      `${KINTONE_BASE}/records.json`,
      { app: KINTONE_APP_ID, records: updateData },
      { headers: kintonePostHeaders }
    );

    console.log(`[cron] アクセス制限処理完了: ${records.length}件のポータルを非公開にしました`);
  } catch (e) {
    console.error('[cron] Error:', e.stack || e.message);
  }
});

// ─── サーバー起動 ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Kintone App: ${process.env.KINTONE_DOMAIN} / App${KINTONE_APP_ID}`);
  console.log(`Re:Lation: ${process.env.RELATION_SUBDOMAIN}.relationapp.jp`);
});
