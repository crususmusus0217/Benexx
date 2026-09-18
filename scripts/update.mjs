// Benex 景品入荷情報の取得・差分検出・出力
// 使い方: node scripts/update.mjs            (サイトから取得)
//        node scripts/update.mjs prizes.html (保存済みHTMLから。テスト用)
// 依存: kuromoji（読み仮名生成） / Node 18+

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import kuromoji from "kuromoji";

const SOURCE_URL = "https://benex.co.jp/prizes";
const ALIASES_PATH = "data/aliases.json"; // 手動の読み・愛称辞書
const STATE_PATH = "data/state.json";   // 初回検出日・入荷日変更の履歴（リポジトリにコミット）
const OUT_PATH = "site/data.json";      // スマホ画面が読むデータ
const KEEP_PAST_DAYS = 60;              // 画面に載せる過去分の日数
const MIN_EXPECTED = 50;                // これ未満なら抽出失敗とみなす

const STORE_NAMES = {
  kawagoe: "川越", kawasaki: "川崎", urawa: "浦和", hiratsuka: "平塚", yamato: "大和",
};

// JSTの日付文字列 (YYYY-MM-DD)
function jstDate(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function loadHtml() {
  const localPath = process.argv[2];
  if (localPath) return readFile(localPath, "utf8");
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (personal arrival checker; once a day)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 方法1: RSCペイロード内の "prizes":[...] を取り出す（全件・店舗スラッグ・画像つき）
function extractFromFlight(html) {
  const re = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
  let flight = "";
  for (const m of html.matchAll(re)) {
    try {
      const arr = JSON.parse(m[1]);
      if (typeof arr[1] === "string") flight += arr[1];
    } catch { /* 解析できない断片は無視 */ }
  }
  const key = '"prizes":[';
  const start = flight.indexOf(key);
  if (start < 0) return null;
  let i = start + key.length - 1, depth = 0, inStr = false, esc = false;
  for (; i < flight.length; i++) {
    const c = flight[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  const list = JSON.parse(flight.slice(start + key.length - 1, i + 1));
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    date: p.date,
    stores: p.stores ?? [],
    image: p.images?.[0] ?? null,
  }));
}

// 方法2（予備）: スクリーンリーダー用の一覧（直近約300件、画像なし）
function extractFromSrList(html) {
  const re = /<article><h3>(.*?)<\/h3><p>入荷日: <!-- -->(.*?)<\/p><p>取扱店舗:<!-- --> <!-- -->(.*?)<\/p><\/article>/g;
  const rev = Object.fromEntries(Object.entries(STORE_NAMES).map(([k, v]) => [v + "店", k]));
  const out = [];
  for (const [, name, date, stores] of html.matchAll(re)) {
    const decoded = name.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    out.push({
      id: `name:${date}:${decoded}`,
      name: decoded,
      date,
      stores: stores.split("、").map((s) => rev[s.trim()]).filter(Boolean),
      image: null,
    });
  }
  return out;
}

async function main() {
  const html = await loadHtml();
  let prizes = null, method = "flight";
  try { prizes = extractFromFlight(html); } catch (e) { console.warn("flight解析失敗:", e.message); }
  if (!prizes || prizes.length < MIN_EXPECTED) {
    method = "sr-list";
    prizes = extractFromSrList(html);
  }
  if (prizes.length < MIN_EXPECTED) {
    // 0件のまま上書きしない。GitHub Actions上では失敗扱いになりメール通知が届く
    throw new Error(`抽出件数が少なすぎます (${prizes.length}件)。サイト構造が変わった可能性があります`);
  }

  const today = jstDate();
  const state = existsSync(STATE_PATH) ? JSON.parse(await readFile(STATE_PATH, "utf8")) : {};
  const firstRun = Object.keys(state).length === 0;
  const added = [], changed = [];

  for (const p of prizes) {
    const s = state[p.id];
    if (!s) {
      state[p.id] = { firstSeen: firstRun ? null : today, date: p.date };
      if (!firstRun) added.push(p);
    } else if (s.date !== p.date) {
      s.prevDate = s.date;
      s.date = p.date;
      s.dateChangedAt = today;
      changed.push(p);
    }
  }

  const from = addDays(today, -KEEP_PAST_DAYS);
  const view = prizes
    .filter((p) => p.date >= from)
    .map((p) => ({ ...p, ...pick(state[p.id], ["firstSeen", "prevDate", "dateChangedAt"]) }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, "ja"));

  await addReadings(view);

  await mkdir("data", { recursive: true });
  await mkdir("site", { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state));
  await writeFile(OUT_PATH, JSON.stringify({
    updatedAt: new Date().toISOString(),
    today,
    storeNames: STORE_NAMES,
    prizes: view,
  }));

  const hira = (list) => list.filter((p) => p.stores.includes("hiratsuka")).length;
  console.log(`取得方法: ${method} / 全${prizes.length}件 / 画面用${view.length}件`);
  console.log(`新規 ${added.length}件（うち平塚 ${hira(added)}件） / 入荷日変更 ${changed.length}件（うち平塚 ${hira(changed)}件）`);
}

// 読み仮名（ひらがな）を作る: 形態素解析の読み + 愛称辞書
const toHira = (s) => s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
function buildTokenizer() {
  const require = createRequire(import.meta.url);
  const dicPath = path.join(path.dirname(require.resolve("kuromoji")), "..", "dict");
  return new Promise((ok, ng) => kuromoji.builder({ dicPath }).build((e, t) => (e ? ng(e) : ok(t))));
}
async function addReadings(list) {
  const aliases = existsSync(ALIASES_PATH) ? JSON.parse(await readFile(ALIASES_PATH, "utf8")) : {};
  const aliasKeys = Object.keys(aliases).filter((k) => !k.startsWith("_"));
  const tokenizer = await buildTokenizer();
  for (const p of list) {
    const name = p.name.normalize("NFKC");
    const auto = tokenizer.tokenize(name)
      .map((t) => (t.reading && t.reading !== "*" ? t.reading : t.surface_form)).join("");
    const extra = aliasKeys.filter((k) => name.includes(k.normalize("NFKC"))).flatMap((k) => aliases[k]);
    p.kana = [toHira(auto), ...extra].join(" ");
  }
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj?.[k]) o[k] = obj[k];
  return o;
}

main().catch((e) => { console.error(e); process.exit(1); });
