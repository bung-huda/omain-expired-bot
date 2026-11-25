// =============================================================
//  Updater harian List Domain Expired — Bung Huda Web Tools
//  Sumber: GoDaddy Auctions Inventory (publik, tanpa login, update harian)
//  Dijalankan otomatis oleh GitHub Actions (.github/workflows/update.yml)
//  Node 18+ (fetch bawaan). Butuh perintah `unzip` (sudah ada di runner Ubuntu).
// =============================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";

const ENV = process.env;
const CFG = {
  BASE: (ENV.INVENTORY_BASE || "https://inventory.auctions.godaddy.com/").replace(/\/?$/, "/"),
  // Pola nama file yang dicari (urutan = prioritas). Bisa diganti via env FILE_PATTERNS="expir,closeout"
  PATTERNS: (ENV.FILE_PATTERNS || "^expiring_service_no_adult_auctions\\.csv,^expiring_service_auctions\\.csv,^expiring_auctions_non_adult\\.json,expir").split(",").map((s) => s.trim()).filter(Boolean),
  MAX_PER_DAY: +(ENV.MAX_PER_DAY || 1500),   // domain baru maksimal per hari
  MIN_AGE: +(ENV.MIN_AGE || 1),              // umur domain minimal (tahun), jika data umur tersedia
  TLDS: (ENV.TLDS || "").split(",").map((s) => s.trim().toLowerCase().replace(/^\.?/, ".")).filter((s) => s !== "."),
  NO_HYPHEN: ENV.NO_HYPHEN !== "0",          // buang domain berisi tanda "-"
  MAX_DIGITS: +(ENV.MAX_DIGITS ?? 2),        // buang domain dengan angka lebih dari ini
  MAX_LEN: +(ENV.MAX_LEN || 25),             // panjang nama (tanpa TLD) maksimal
  KEEP_DAYS: +(ENV.KEEP_DAYS || 365),        // file harian lebih lama dari ini dihapus
  SEEN_DAYS: +(ENV.SEEN_DAYS || 45),         // domain yang sudah tampil dalam N hari tidak diulang
  OPR_KEY: ENV.OPR_KEY || "",                // opsional: API key Open PageRank
  DATA_DIR: ENV.DATA_DIR || path.resolve(process.cwd(), "data"),
  TZ_OFFSET: +(ENV.TZ_OFFSET ?? 7),          // WIB
};

const log = (...a) => console.log("[update]", ...a);
const today = () => {
  const d = new Date(Date.now() + CFG.TZ_OFFSET * 3600e3);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};
const readJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

async function get(url, type = "json") {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "bunghuda-expired-domain-list/1.0" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return type === "json" ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      log(`gagal ambil ${url} (percobaan ${i}): ${e.message}`);
      if (i === 3) throw e;
      await new Promise((s) => setTimeout(s, 5000 * i));
    }
  }
}

/* ---------- 1. Cari file inventaris lewat metadata.json ---------- */
function collectFiles(node, out = [], parent = null) {
  if (typeof node === "string") {
    if (/\.(zip|json|csv)(\?|$)/i.test(node)) out.push({ name: node.split("/").pop().split("?")[0], url: node, meta: parent });
  } else if (Array.isArray(node)) node.forEach((n) => collectFiles(n, out, parent));
  else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectFiles(v, out, node);
  }
  return out;
}
async function pickFile() {
  const meta = await get(CFG.BASE + "metadata.json");
  const seen = new Set();
  const files = collectFiles(meta).filter((f) => !seen.has(f.url) && seen.add(f.url) && !/metadata\.json$/i.test(f.name));
  log(`metadata.json berisi ${files.length} file:`, files.map((f) => f.name).join(", "));
  for (const p of CFG.PATTERNS) {
    const re = new RegExp(p, "i");
    const cand = files.filter((f) => re.test(f.name));
    if (!cand.length) continue;
    cand.sort((a, b) => (/csv/i.test(b.name) - /csv/i.test(a.name)) || (/json/i.test(b.name) - /json/i.test(a.name)));
    const f = cand[0];
    f.url = /^https?:/i.test(f.url) ? f.url : new URL(f.url.replace(/^\//, ""), CFG.BASE).href;
    return f;
  }
  throw new Error(`Tidak ada file yang cocok dengan pola ${CFG.PATTERNS.join(", ")}. Cek daftar file di log lalu atur FILE_PATTERNS.`);
}

/* ---------- 2. Unduh & baca isi file secara streaming (file GoDaddy bisa > 500 MB) ---------- */
async function download(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
  const out = path.join(dir, url.split("/").pop().split("?")[0] || "file");
  const buf = await get(url, "buf");
  fs.writeFileSync(out, buf);
  log(`terunduh ${(buf.length / 1048576).toFixed(1)} MB`);
  return out;
}
// Menghasilkan aliran teks (chunk string) dari file biasa atau isi ZIP
function textStream(file) {
  if (!/\.zip$/i.test(file)) return { name: file, stream: fs.createReadStream(file, { encoding: "utf8" }) };
  const list = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter((n) => /\.(json|csv|txt)$/i.test(n));
  if (!list.length) throw new Error("ZIP tidak berisi file JSON/CSV");
  const p = spawn("unzip", ["-p", file, list[0]]);
  p.stdout.setEncoding("utf8");
  return { name: list[0], stream: p.stdout };
}
// CSV streaming: memanggil onRow(objek) per baris
function csvParser(onRow) {
  let head = null, row = [], f = "", q = false, pendingQuote = false, skipLF = false;
  const emit = () => {
    row.push(f); f = "";
    if (!head) head = row.map((h) => h.replace(/^﻿/, "").trim());
    else if (row.length > 1) { const o = {}; for (let i = 0; i < head.length; i++) o[head[i]] = row[i]; onRow(o); }
    row = [];
  };
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (skipLF) { skipLF = false; if (c === "\n") continue; }
        if (pendingQuote) { pendingQuote = false; if (c === '"') { f += '"'; continue; } q = false; }
        if (q) { if (c === '"') pendingQuote = true; else f += c; continue; }
        if (c === '"') q = true;
        else if (c === ",") { row.push(f); f = ""; }
        else if (c === "\n") emit();
        else if (c === "\r") { emit(); skipLF = true; }
        else f += c;
      }
    },
    end() { if (pendingQuote) q = false; if (f !== "" || row.length) emit(); },
  };
}
// JSON streaming: mengambil setiap objek yang menjadi elemen array, tanpa memuat seluruh file
function jsonParser(onRow) {
  const stack = []; let inStr = false, esc = false, buf = null, depthAtStart = -1;
  return {
    push(chunk) {
      let start = buf !== null ? 0 : -1;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === "{" || c === "[") {
          if (c === "{" && buf === null && stack[stack.length - 1] === "[") { buf = ""; start = i; depthAtStart = stack.length; }
          stack.push(c);
        } else if (c === "}" || c === "]") {
          stack.pop();
          if (c === "}" && buf !== null && stack.length === depthAtStart) {
            buf += chunk.slice(start, i + 1);
            try { onRow(JSON.parse(buf)); } catch {}
            buf = null; start = -1;
          }
        }
      }
      if (buf !== null) buf += chunk.slice(start < 0 ? 0 : start);
    },
    end() {},
  };
}
async function streamRecords(file, onRow) {
  const { name, stream } = textStream(file);
  let parser = null, n = 0;
  const wrap = (o) => { n++; onRow(o); };
  for await (const chunk of stream) {
    if (!parser) {
      const isJSON = /\.json$/i.test(name) || /^\s*[\[{]/.test(chunk);
      parser = isJSON ? jsonParser(wrap) : csvParser(wrap);
      log(`membaca ${name} sebagai ${isJSON ? "JSON" : "CSV"} (streaming)`);
    }
    parser.push(chunk);
  }
  if (parser) parser.end();
  return n;
}

/* ---------- 3. Normalisasi kolom (nama kolom GoDaddy bisa berubah) ---------- */
const ALIAS = {
  d: ["domainname", "domain", "name", "fqdn"],
  age: ["domainage", "age", "ageyears"],
  bids: ["numberofbids", "bids", "bidcount", "bidders"],
  price: ["price", "currentprice", "currentbid", "minbid", "buynowprice", "bidamount"],
  traffic: ["traffic", "pageviews", "monthlytraffic", "visits"],
  val: ["valuation", "estimatedvalue", "gdvaluation", "appraisal", "value"],
  end: ["auctionendtime", "auctionenddate", "endtime", "enddate", "auctionend", "expires"],
  link: ["link", "url", "listingurl", "auctionurl"],
  adult: ["isadult", "adult"],
};
function buildMap(sample) {
  const keys = Object.keys(sample), m = {};
  for (const [field, list] of Object.entries(ALIAS)) {
    const k = list.map((a) => keys.find((x) => norm(x) === a)).find(Boolean)
      || keys.find((x) => list.some((a) => a.length > 4 && norm(x).includes(a)));
    if (k) m[field] = k;
  }
  return m;
}
const num = (v) => { if (v == null || v === "") return 0; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
function ageYears(v) {
  if (v == null || v === "") return 0;
  const s = String(v);
  if (/^\d{4}-\d{2}/.test(s)) return Math.max(0, Math.floor((Date.now() - Date.parse(s)) / 31557600000)); // tanggal registrasi
  return Math.floor(num(s));
}
function cleanDomain(v) {
  return String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
}
function keep(d) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return false; // buang IDN/karakter aneh
  const i = d.indexOf("."), name = d.slice(0, i), tld = d.slice(i);
  if (CFG.TLDS.length && !CFG.TLDS.includes(tld)) return false;
  if (CFG.NO_HYPHEN && name.includes("-")) return false;
  if ((name.match(/\d/g) || []).length > CFG.MAX_DIGITS) return false;
  if (name.length > CFG.MAX_LEN) return false;
  return true;
}
const score = (r) => r.age * 10 + Math.log10(1 + r.traffic) * 15 + Math.log10(1 + r.val) * 8 + r.bids * 3 + (r.opr || 0) * 20;

/* ---------- 4. Open PageRank (opsional) ---------- */
async function addOPR(items) {
  if (!CFG.OPR_KEY || !items.length) return;
  log(`mengambil Open PageRank untuk ${items.length} domain...`);
  const map = new Map(items.map((r) => [r.d, r]));
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100).map((r) => r.d);
    try {
      const r = await fetch("https://openpagerank.keywordseverywhere.com/v1/domains/bulk", {
        method: "POST",
        headers: { Authorization: "Bearer " + CFG.OPR_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ domains: batch, include_history: false }),
      });
      if (!r.ok) { log("Open PageRank berhenti: HTTP " + r.status + " " + (await r.text()).slice(0, 200)); return; }
      const j = await r.json();
      for (const x of j.results || []) {
        const it = map.get(x.domain);
        if (it && x.found) { it.opr = x.open_page_rank ?? 0; it.rd = x.referring_domains ?? 0; }
      }
    } catch (e) { log("Open PageRank error: " + e.message); return; }
    await new Promise((s) => setTimeout(s, 1100)); // batas per menit
  }
}

/* ---------- 5. Main ---------- */
async function main() {
  const K = today();
  const D = CFG.DATA_DIR, dayDir = path.join(D, "d");
  const index = readJSON(path.join(D, "index.json"), { days: [], months: {}, total: 0 });
  const seen = readJSON(path.join(D, "seen.json"), {});

  const file = await pickFile();
  log("mengunduh " + file.url);
  const local = await download(file.url);

  // buang domain yang sudah pernah tampil dalam SEEN_DAYS terakhir
  const kd = (k) => Date.parse(String(k).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"));
  for (const [d, k] of Object.entries(seen)) if ((kd(K) - kd(k)) / 864e5 > CFG.SEEN_DAYS) delete seen[d];

  const already = readJSON(path.join(dayDir, K + ".json"), { items: [] }).items;
  const inToday = new Set(already.map((r) => r.d));
  const uniq = new Map();
  let M = null;
  const total = await streamRecords(local, (x) => {
    if (!M) {
      M = buildMap(x);
      log("kolom tersedia: " + Object.keys(x).join(", "));
      log("kolom terdeteksi: " + JSON.stringify(M));
      if (!M.d) throw new Error("Kolom nama domain tidak ditemukan. Kolom tersedia: " + Object.keys(x).join(", "));
    }
    const d = cleanDomain(x[M.d]);
    if (!d || uniq.has(d) || inToday.has(d) || (seen[d] && seen[d] !== K) || !keep(d)) return;
    if (M.adult && /^(true|1|yes|y)$/i.test(String(x[M.adult]).trim())) return;
    const r = {
      d,
      age: M.age ? ageYears(x[M.age]) : 0,
      bids: M.bids ? Math.round(num(x[M.bids])) : 0,
      price: M.price ? num(x[M.price]) : 0,
      traffic: M.traffic ? Math.round(num(x[M.traffic])) : 0,
      val: M.val ? Math.round(num(x[M.val])) : 0,
      end: M.end ? String(x[M.end] || "").slice(0, 16) : "",
      link: M.link ? String(x[M.link] || "") : "",
    };
    if (M.age && r.age < CFG.MIN_AGE) return;
    uniq.set(d, r);
  });
  log(`${total} baris dibaca, ${uniq.size} lolos saringan.`);
  if (!total) throw new Error("File inventaris kosong / format tidak dikenali");
  let items = [...uniq.values()].sort((a, b) => score(b) - score(a));
  items = items.slice(0, Math.max(0, CFG.MAX_PER_DAY - already.length));
  await addOPR(items);
  const now = new Date(Date.now() + CFG.TZ_OFFSET * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  items.forEach((r) => { r.t = now; seen[r.d] = K; });
  // buang field kosong agar file kecil
  items = items.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== 0 && v !== "")));

  const all = already.concat(items).sort((a, b) => score({ age: 0, traffic: 0, val: 0, bids: 0, ...b }) - score({ age: 0, traffic: 0, val: 0, bids: 0, ...a }));
  writeJSON(path.join(dayDir, K + ".json"), { k: K, src: "GoDaddy Auctions", file: file.name, items: all });

  // hapus file harian lama
  const keepFrom = new Date(Date.now() - CFG.KEEP_DAYS * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
  for (const f of fs.existsSync(dayDir) ? fs.readdirSync(dayDir) : []) if (f.slice(0, 8) < keepFrom) fs.unlinkSync(path.join(dayDir, f));

  // susun ulang index
  const vipOf = (arr) => arr.filter((r) => (r.age || 0) >= 10 || (r.opr || 0) >= 3).length;
  const days = index.days.filter((x) => x.k !== K && x.k >= keepFrom);
  days.push({ k: K, n: all.length, vip: vipOf(all) });
  days.sort((a, b) => (a.k < b.k ? 1 : -1));
  const months = { ...index.months };
  const prevToday = index.days.find((x) => x.k === K);
  months[K.slice(0, 6)] = (months[K.slice(0, 6)] || 0) - (prevToday ? prevToday.n : 0) + all.length;
  const grand = (index.total || 0) - (prevToday ? prevToday.n : 0) + all.length;
  writeJSON(path.join(D, "index.json"), {
    updated: now, src: "GoDaddy Auctions", fields: Object.keys(M).filter((k) => k !== "d" && k !== "adult").concat(CFG.OPR_KEY ? ["opr", "rd"] : []),
    total: grand, days, months,
  });
  writeJSON(path.join(D, "seen.json"), seen);
  log(`selesai: ${items.length} domain baru untuk ${K} (total hari ini ${all.length}, total semua ${grand}).`);
}

main().catch((e) => { console.error("[update] GAGAL:", e.message); process.exit(1); });
