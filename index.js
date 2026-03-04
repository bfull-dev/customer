require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const FormData = require('form-data');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;

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
  console.log('[searchRecords] query:', query);
  console.log('[searchRecords] URL:', `${KINTONE_BASE}/records.json`);
  const res = await axios.get(`${KINTONE_BASE}/records.json`, {
    headers: kintoneGetHeaders,
    params: { app: KINTONE_APP_ID, query },
  });
  console.log('[searchRecords] response:', JSON.stringify(res.data));
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
    console.error('Kintone API Error:', error.response?.data);
    console.error('Request URL:', error.config?.url);
    console.error('Request Params:', error.config?.params);
    console.error('Kintone API Error detail:', JSON.stringify(error.response?.data));
    console.error('Request headers:', JSON.stringify(error.config?.headers));
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
        status_cd: 'open',
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

const notifyDiscord = async (message) => {
  if (!process.env.DISCORD_WEBHOOK_URL) return;
  await axios.post(process.env.DISCORD_WEBHOOK_URL, { content: message });
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

  await updateRecord(recordId, fields);
  return { ok: true };
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

  // Discord 通知
  await notifyDiscord(
    `📩 お客様からメッセージが届きました\n管理番号: ${管理番号}\n本文:\n${message}`
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

  const progressHistory = rec['進捗履歴'].value || [];
  const 最新進捗 =
    progressHistory.length > 0
      ? progressHistory[progressHistory.length - 1].value['進捗内容'].value
      : '';

  const messageHistory = rec['メッセージ履歴'].value || [];
  const lastMsg = messageHistory.length > 0 ? messageHistory[messageHistory.length - 1] : null;
  const 直近メッセージ = lastMsg
    ? {
        送信者区分: lastMsg.value['送信者区分'].value,
        メッセージ本文: lastMsg.value['メッセージ本文'].value,
        送信日時: lastMsg.value['送信日時'].value,
      }
    : null;

  const progressNoteOptions = (process.env.STATUS_OPTIONS || '').split(',').filter(Boolean);

  return {
    ok: true,
    data: {
      進捗ステータス: rec['進捗ステータス'].value,
      最新進捗,
      お客様メール: rec['お客様メールアドレス'].value,
      直近メッセージ,
      次回連絡日: rec['次回ご連絡予定日'].value,
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
        id: null,
        value: {
          進捗内容: { value: progressNote },
          進捗記載日時: { value: new Date().toISOString() },
          進捗担当者: { value: '' }, // TODO: 担当者名を渡す場合はリクエストボディに追加してください
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

  for (let i = 0; i < 3; i++) {
    try {
      const rec = await getRecord(recordId);
      const revision = rec['$revision'].value;

      // ファイルアップロード
      const uploadedFileKeys = [];
      for (const file of files) {
        const fileKey = await uploadFile(file.name, file.type, file.data);
        uploadedFileKeys.push({ fileKey });
      }

      // メッセージ履歴サブテーブルに追記
      const existingMessages = rec['メッセージ履歴'].value || [];
      const newRow = {
        id: null,
        value: {
          送信者区分: { value: '担当者' },
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

      // Re:Lation でお客様へメール送信
      const brand = rec['ブランド'].value;
      const { mailboxId, mailAccountId } = getRelationMailbox(brand);
      const email = rec['お客様メールアドレス'].value;
      const 管理番号 = rec['管理番号'].value;

      await sendRelationMail({
        mailboxId,
        mailAccountId,
        to: email,
        subject: `【${管理番号}】担当者よりメッセージが届いています`,
        body: message,
      });

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

  for (let i = 0; i < 3; i++) {
    try {
      const rec = await getRecord(recordId);
      const revision = rec['$revision'].value;

      const fields = {
        次回ご連絡予定日: { value: date },
      };
      if (note !== undefined) {
        fields['次回予定'] = { value: note };
      }

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
 * getStatusOptions
 * 進捗内容の選択肢を返す
 */
const getStatusOptions = async () => {
  const options = (process.env.STATUS_OPTIONS || '').split(',').filter(Boolean);
  return { ok: true, options };
};

// ─── Router ───────────────────────────────────────────────────────────────────

const router = async (req, res) => {
  const params = { ...req.query, ...req.body };
  const action = params.action;

  try {
    let result;
    switch (action) {
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
      // 担当者向け
      case 'getRecordForStaff':
        result = await getRecordForStaff(params);
        break;
      case 'updateProgress':
        result = await updateProgress(params);
        break;
      case 'sendStaffMessage':
        result = await sendStaffMessage(params);
        break;
      case 'setNextContactDate':
        result = await setNextContactDate(params);
        break;
      case 'getStatusOptions':
        result = await getStatusOptions();
        break;
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

// ─── ③ Webhook: Kintone ──────────────────────────────────────────────────────

/**
 * POST /webhook/kintone
 * UPDATE_STATUS イベントで「対応完了」になった場合に1ヶ月後12:00をアクセス制限日時に設定
 */
app.post('/webhook/kintone', async (req, res) => {
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

    // アクセス制限日時 <= 現在 かつ まだ公開中のレコードを取得
    const records = await searchRecords(
      `アクセス制限日時 <= "${now}" and ポータル公開フラグ in ("公開") limit 100`
    );

    if (!records.length) {
      console.log('[cron] アクセス制限対象レコードなし');
      return;
    }

    for (const rec of records) {
      const recordId = rec['$id'].value;
      await updateRecord(recordId, {
        ポータル公開フラグ: { value: [] }, // チェックボックスをすべて外す
      });
    }

    console.log(`[cron] アクセス制限処理完了: ${records.length}件のポータルを非公開にしました`);
  } catch (e) {
    console.error('[cron] Error:', e.stack || e.message);
  }
});

// ─── サーバー起動 ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Token length:', process.env.KINTONE_API_TOKEN?.length);
  console.log('Token first 10 chars:', process.env.KINTONE_API_TOKEN?.substring(0, 10));
  console.log(`Kintone App: ${process.env.KINTONE_DOMAIN} / App${KINTONE_APP_ID}`);
  console.log(`Re:Lation: ${process.env.RELATION_SUBDOMAIN}.relationapp.jp`);
});
