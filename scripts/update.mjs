// Benex 景品入荷情報の取得・差分検出・出力
// 使い方: node scripts/update.mjs            (サイトから取得)
//        node scripts/update.mjs prizes.html (保存済みHTMLから。テスト用)
// 依存: kuromoji（読み仮名生成）, wanakana（ローマ字→かな） / Node 18+
//
// 2026-11 サイト改修への対応:
//   ページに最初から載るのは「今後の入荷予定（約300件・画像なし）」と「直近数日分（画像あり）」だけになり、
//   過去分は載らなくなった。そのため取得結果を data/prizes.json に蓄積し、画面はそこから作る。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import kuromoji from "kuromoji";
import * as wanakana from "wanakana";

const SITE = "https://benex.co.jp";
const SOURCE_URL = `${SITE}/prizes`;
const ALIASES_PATH = "data/aliases.json"; // 手動の読み・愛称辞書
const ENGLISH_PATH = "data/english.json"; // 英単語の読み辞書
const STATE_PATH = "data/state.json";     // 初回検出日・入荷日変更の履歴（リポジトリにコミット）
const CACHE_PATH = "data/prizes.json";    // 取得した景品の蓄積（リポジトリにコミット）
const OUT_PATH = "site/data.json";        // スマホ画面が読むデータ
const KEEP_PAST_DAYS = 60;                // 画面に載せる過去分の日数
const CACHE_PAST_DAYS = 120;              // 蓄積に残す過去分の日数
const MIN_EXPECTED = 50;                  // これ未満なら抽出失敗とみなす
const DETAIL_FETCH_LIMIT = 40;            // 1回の実行で画像を取りに行く詳細ページの上限
const UA = "Mozilla/5.0 (personal arrival checker; twice a day)";

const STORE_NAMES = {
  kawagoe: "川越", kawasaki: "川崎", urawa: "浦和", hiratsuka: "平塚", yamato: "大和",
};
const STORE_BY_LABEL = Object.fromEntries(Object.entries(STORE_NAMES).map(([k, v]) => [v + "店", k]));

// JSTの日付文字列 (YYYY-MM-DD)
function jstDate(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadHtml() {
  const localPath = process.argv[2];
  if (localPath) return readFile(localPath, "utf8");
  const res = await fetch(SOURCE_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------- 抽出 ----------

// RSCペイロード（self.__next_f.push の中身）をつなげた文字列
function readFlight(html) {
  const re = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
  let flight = "";
  for (const m of html.matchAll(re)) {
    try {
      const arr = JSON.parse(m[1]);
      if (typeof arr[1] === "string") flight += arr[1];
    } catch { /* 解析できない断片は無視 */ }
  }
  return flight;
}

// str[start] が [ か { のとき、対応する閉じ括弧までをJSONとして読む
function readJsonAt(str, start) {
  const open = str[start], close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(str.slice(start, i + 1));
  }
  throw new Error("JSONの終わりが見つかりません");
}

function storesFromLabel(label) {
  return String(label).split("、").map((s) => s.trim()).filter(Boolean)
    .map((s) => STORE_BY_LABEL[s] ?? s.replace(/店$/, ""));
}

// 方法A: RSC内の一覧項目 ["$","li","new-prize-NNNN",…]（今後の入荷予定。ID・店舗あり、画像なし）
function extractListItems(flight) {
  const out = [];
  const re = /\["\$","li","(new-prize-\d+)",/g;
  for (const m of flight.matchAll(re)) {
    let node;
    try { node = readJsonAt(flight, m.index); } catch { continue; }
    const texts = { h3: [], p: [] };
    (function walk(n) {
      if (!Array.isArray(n)) return;
      if (n[0] === "$" && typeof n[1] === "string") {
        const children = n[3]?.children;
        if (n[1] === "h3" || n[1] === "p") texts[n[1]].push(flat(children));
        else walk(children);
        return;
      }
      n.forEach(walk);
    })(node);
    const name = texts.h3[0];
    const dateText = texts.p.find((t) => t.includes("入荷日")) ?? "";
    const storeText = texts.p.find((t) => t.includes("取扱店舗")) ?? "";
    const date = dateText.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!name || !date) continue;
    out.push({ id: m[1], name, date, stores: storesFromLabel(storeText.replace(/^.*?取扱店舗:\s*/, "")), image: null });
  }
  return out;
}
function flat(c) {
  if (c == null) return "";
  if (typeof c === "string" || typeof c === "number") return String(c);
  if (Array.isArray(c)) {
    if (c[0] === "$" && typeof c[1] === "string") return flat(c[3]?.children);
    return c.map(flat).join("");
  }
  return "";
}

// 方法B: RSC内の "prizes":[…]（以前は全件、今は直近数日分。画像・店舗スラッグあり）
function extractPrizesArray(flight) {
  const key = '"prizes":[';
  const start = flight.indexOf(key);
  if (start < 0) return [];
  const list = readJsonAt(flight, start + key.length - 1);
  return list.map((p) => ({
    id: p.id, name: p.name, date: p.date, stores: p.stores ?? [], image: p.images?.[0] ?? null,
  }));
}

// 方法C（予備）: HTMLの一覧 <article>（IDなし）
function extractArticles(html) {
  const re = /<article><h3>(.*?)<\/h3><p>入荷日: (?:<!-- -->)?(.*?)<\/p><p>取扱店舗:(?:<!-- -->)? (?:<!-- -->)?(.*?)<\/p><\/article>/g;
  const out = [];
  for (const [, rawName, date, stores] of html.matchAll(re)) {
    const name = decodeEntities(rawName);
    out.push({ id: `name:${date}:${name}`, name, date, stores: storesFromLabel(decodeEntities(stores)), image: null });
  }
  return out;
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// ページ内にある画像URL（ID → URL）。JSON-LD・RSCのどちらに出ていても拾う
function extractImages(text) {
  const map = {};
  const re = /https:\/\/images\.microcms-assets\.io\/assets\/[0-9a-f]+\/[0-9a-f]+\/(new-prize-\d+)\.(?:jpe?g|png|webp|gif)/g;
  for (const m of text.matchAll(re)) map[m[1]] ??= m[0];
  return map;
}

function extractAll(html) {
  const flight = readFlight(html);
  const fromList = extractListItems(flight);
  let fromArray = [];
  try { fromArray = extractPrizesArray(flight); } catch (e) { console.warn("prizes配列の解析失敗:", e.message); }
  const images = extractImages(html + flight);

  const byId = new Map();
  for (const p of [...fromList, ...fromArray]) {
    const prev = byId.get(p.id);
    byId.set(p.id, prev ? { ...prev, ...p, image: p.image ?? prev.image } : p);
  }
  let method = `list ${fromList.length}件 + prizes ${fromArray.length}件`;
  if (byId.size < MIN_EXPECTED) {
    const arts = extractArticles(html);
    if (arts.length > byId.size) {
      method = `article ${arts.length}件（予備・IDなし）`;
      byId.clear();
      for (const p of arts) byId.set(p.id, p);
    }
  }
  for (const p of byId.values()) p.image ??= images[p.id] ?? null;
  return { prizes: [...byId.values()], method };
}

// ---------- 蓄積 ----------

// 初回だけ: 公開中の data.json（改修前に作られた過去分を含む）から引き継ぐ
async function seedCache() {
  const local = process.env.SEED_PATH;
  let url = process.env.SEED_URL;
  if (!url && process.env.GITHUB_REPOSITORY) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
    url = `https://${owner.toLowerCase()}.github.io/${repo}/data.json`;
  }
  try {
    let data;
    if (local) data = JSON.parse(await readFile(local, "utf8"));
    else if (url) {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } else return {};
    const cache = {};
    for (const p of data.prizes ?? []) {
      if (p.id && p.date) cache[p.id] = { name: p.name, date: p.date, stores: p.stores ?? [], image: p.image ?? null };
    }
    console.log(`公開中のデータから ${Object.keys(cache).length}件を引き継ぎました`);
    return cache;
  } catch (e) {
    console.warn("引き継ぎできませんでした（過去分なしで続行）:", e.message);
    return {};
  }
}

// 詳細ページから画像URLを取る（新しく見つかった平塚の景品を優先。失敗しても続行）
async function fillImagesFromDetail(cache, today) {
  if (process.argv[2]) return 0; // 保存済みHTMLでのテスト中は取りに行かない
  const targets = Object.entries(cache)
    .filter(([id, p]) => !p.image && !p.noImage && id.startsWith("new-prize-") && p.date >= addDays(today, -7))
    .sort(([, a], [, b]) => Number(b.stores.includes("hiratsuka")) - Number(a.stores.includes("hiratsuka")) || a.date.localeCompare(b.date))
    .slice(0, DETAIL_FETCH_LIMIT);
  let found = 0;
  for (const [id, p] of targets) {
    try {
      const res = await fetch(`${SITE}/prizes/detail/new_${id}`, { headers: { "User-Agent": UA } });
      if (res.ok) {
        const html = await res.text();
        const url = extractImages(html)[id]
          ?? html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
        if (url && url.includes(id)) { p.image = url.split("?")[0]; found++; }
        else p.imageTries = (p.imageTries ?? 0) + 1;
      } else if (res.status === 404) p.noImage = true;
    } catch { /* 次回また試す */ }
    if ((p.imageTries ?? 0) >= 3) p.noImage = true;
    await sleep(500);
  }
  return found;
}

async function main() {
  const html = await loadHtml();
  const { prizes, method } = extractAll(html);
  if (prizes.length < MIN_EXPECTED) {
    // 0件のまま上書きしない。GitHub Actions上では失敗扱いになりメール通知が届く
    throw new Error(`抽出件数が少なすぎます (${prizes.length}件)。サイト構造が変わった可能性があります`);
  }

  const today = jstDate();
  const cache = existsSync(CACHE_PATH) ? JSON.parse(await readFile(CACHE_PATH, "utf8")) : await seedCache();

  // 今回の取得結果で上書き（画像は既知のものを残す）
  const seen = new Set();
  for (const p of prizes) {
    seen.add(p.id);
    const prev = cache[p.id];
    cache[p.id] = { ...prev, name: p.name, date: p.date, stores: p.stores, image: p.image ?? prev?.image ?? null };
  }
  // 掲載から消えた予定を外す: 今回取れた日付の範囲内（最終日は件数上限で欠ける可能性があるので除く）にあるのに見つからないもの
  const fetchedDates = prizes.map((p) => p.date).sort();
  const lo = fetchedDates[0], hi = fetchedDates.at(-1);
  let removed = 0;
  for (const [id, p] of Object.entries(cache)) {
    if (!seen.has(id) && p.date >= today && p.date >= lo && p.date < hi && id.startsWith("new-prize-")) { delete cache[id]; removed++; }
    else if (p.date < addDays(today, -CACHE_PAST_DAYS)) delete cache[id];
  }
  const imagesFound = await fillImagesFromDetail(cache, today);

  // 差分検出（以前と同じ）
  const state = existsSync(STATE_PATH) ? JSON.parse(await readFile(STATE_PATH, "utf8")) : {};
  const firstRun = Object.keys(state).length === 0;
  const added = [], changed = [];
  for (const [id, p] of Object.entries(cache)) {
    const s = state[id];
    if (!s) {
      state[id] = { firstSeen: firstRun ? null : today, date: p.date };
      if (!firstRun) added.push(p);
    } else if (s.date !== p.date) {
      s.prevDate = s.date;
      s.date = p.date;
      s.dateChangedAt = today;
      changed.push(p);
    }
  }

  const from = addDays(today, -KEEP_PAST_DAYS);
  const view = Object.entries(cache)
    .filter(([, p]) => p.date >= from)
    .map(([id, p]) => ({ id, name: p.name, date: p.date, stores: p.stores, image: p.image ?? null,
      ...pick(state[id], ["firstSeen", "prevDate", "dateChangedAt"]) }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, "ja"));

  await addReadings(view);

  // 未知の店舗が出てきても表示できるようにする
  const storeNames = { ...STORE_NAMES };
  for (const p of view) for (const s of p.stores) storeNames[s] ??= s;

  await mkdir("data", { recursive: true });
  await mkdir("site", { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache));
  await writeFile(STATE_PATH, JSON.stringify(state));
  await writeFile(OUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), today, storeNames, prizes: view }));

  const hira = (list) => list.filter((p) => p.stores.includes("hiratsuka")).length;
  const noImg = view.filter((p) => !p.image && p.stores.includes("hiratsuka")).length;
  console.log(`取得方法: ${method} / 今回${prizes.length}件 / 蓄積${Object.keys(cache).length}件 / 画面用${view.length}件`);
  console.log(`新規 ${added.length}件（うち平塚 ${hira(added)}件） / 入荷日変更 ${changed.length}件（うち平塚 ${hira(changed)}件） / 掲載終了 ${removed}件`);
  console.log(`詳細ページから画像取得 ${imagesFound}件 / 画像なし（平塚） ${noImg}件`);
}

// 読み仮名（ひらがな）を作る: 形態素解析の読み + 愛称辞書
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
function buildTokenizer() {
  const require = createRequire(import.meta.url);
  const dicPath = path.join(path.dirname(require.resolve("kuromoji")), "..", "dict");
  return new Promise((ok, ng) => kuromoji.builder({ dicPath }).build((e, t) => (e ? ng(e) : ok(t))));
}
async function addReadings(list) {
  const aliases = existsSync(ALIASES_PATH) ? JSON.parse(await readFile(ALIASES_PATH, "utf8")) : {};
  const aliasKeys = Object.keys(aliases).filter((k) => !k.startsWith("_"));
  const english = existsSync(ENGLISH_PATH) ? JSON.parse(await readFile(ENGLISH_PATH, "utf8")) : {};
  const tokenizer = await buildTokenizer();
  for (const p of list) {
    const name = p.name.normalize("NFKC");
    const lower = name.toLowerCase();
    const auto = tokenizer.tokenize(name)
      .map((t) => (t.reading && t.reading !== "*" ? t.reading : t.surface_form)).join("");
    const extra = aliasKeys.filter((k) => lower.includes(k.normalize("NFKC").toLowerCase())).flatMap((k) => aliases[k]);
    // 英字の単語: 辞書にあればその読み、ローマ字として読めれば平仮名に変換（OKKOTSU → おっこつ）
    const latin = [];
    for (const w of lower.match(/[a-z][a-z'&.\-]*[a-z]|[a-z]/g) ?? []) {
      if (english[w]) { latin.push(...english[w]); continue; }
      for (const part of w.split(/[-.&']/)) {
        if (english[part]) { latin.push(...english[part]); continue; }
        const h = wanakana.toHiragana(part);
        if (part.length >= 2 && !/[a-z]/.test(h)) latin.push(h);
      }
    }
    p.kana = [toHira(auto), ...extra, ...latin].join(" ");
  }
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj?.[k]) o[k] = obj[k];
  return o;
}

main().catch((e) => { console.error(e); process.exit(1); });
