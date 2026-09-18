/**
 * 平塚 入荷メモ: 在庫状態の同期用 Apps Script
 * スプレッドシートの「状態」シートに id / 状態 / 更新時刻 / 商品名 を保存する。
 * スクリプトプロパティ KEY に合言葉を設定しておくこと。
 */
const SHEET_NAME = "状態";

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(["id", "状態", "更新時刻(ms)", "商品名", "更新日時"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function authorized_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty("KEY");
  return !!expected && key === expected;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function readAll_() {
  const values = sheet_().getDataRange().getValues();
  const out = {};
  for (let i = 1; i < values.length; i++) {
    const [id, s, t] = values[i];
    if (id) out[id] = { s: String(s || ""), t: Number(t) || 0 };
  }
  return out;
}

function doGet(e) {
  if (!authorized_(e.parameter.key)) return json_({ error: "unauthorized" });
  return json_({ statuses: readAll_() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: "bad request" }); }
  if (!authorized_(body.key)) return json_({ error: "unauthorized" });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    const values = sh.getDataRange().getValues();
    const rowOf = {};
    for (let i = 1; i < values.length; i++) rowOf[values[i][0]] = i + 1;

    for (const u of body.updates || []) {
      if (!u || !u.id) continue;
      const row = rowOf[u.id];
      if (row && Number(values[row - 1][2]) >= u.t) continue; // 新しい方を残す
      const record = [u.id, u.s || "", u.t, u.name || "", new Date(u.t)];
      if (row) sh.getRange(row, 1, 1, record.length).setValues([record]);
      else { sh.appendRow(record); rowOf[u.id] = sh.getLastRow(); }
    }
  } finally {
    lock.releaseLock();
  }
  return json_({ statuses: readAll_() });
}
