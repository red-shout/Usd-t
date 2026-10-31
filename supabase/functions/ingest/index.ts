// پالس بازار · ingest — scrapes alanchand.com + oilprice.com, stores in Postgres, alerts on Telegram.
// Ported 1:1 from fetch_rates.py (JSON-LD parsing), reimplemented in Deno so no Python runtime is needed.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ---------------------------------------------------------------- helpers
async function get(url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function jsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      /* ignore malformed block */
    }
  }
  return out;
}

function attr(html: string, tagRe: RegExp): string | null {
  const m = html.match(tagRe);
  return m ? m[1] : null;
}

// gregorian -> jalali (same algorithm as the Python original)
function toJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = 0;
  let y = gy;
  if (gy > 1600) {
    jy = 979;
    y -= 1600;
  } else y -= 621;
  const gy2 = gm > 2 ? y : y - 1;
  let days = 365 * y + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) - 80 + gd + gdm[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let jm: number, jd: number;
  if (days < 186) {
    jm = 1 + Math.floor(days / 31);
    jd = 1 + (days % 31);
  } else {
    jm = 7 + Math.floor((days - 186) / 30);
    jd = 1 + ((days - 186) % 30);
  }
  return [jy, jm, jd];
}

// ---------------------------------------------------------------- scrapers
async function fetchUsdFromAedPeg(): Promise<number | null> {
  const [aedHtml, usdHtml] = await Promise.all([
    get("https://alanchand.com/en/currencies-price/aed"),
    get("https://alanchand.com/en/exchange-rates/aed-usd"),
  ]);

  let usdRate = Number(
    attr(usdHtml, /id=["'](?:inputCalcValue|outputCalcValue)["'][^>]*data-rate=["']([\d.]+)["']/i) ?? "0",
  );
  if (!usdRate) usdRate = Number(attr(usdHtml, /data-rate=["']([\d.]+)["']/i) ?? "0") || 0.2723;

  const raw =
    attr(aedHtml, /<input[^>]*data-curr=["']tmn["'][^>]*data-price=["']([\d,.]+)["']/i) ??
    attr(aedHtml, /<input[^>]*data-curr=["']tmn["'][^>]*value=["']([\d,.]+)["']/i);
  if (!raw) return null;

  const aedToman = Number(raw.replace(/,/g, "").trim()) / 10;
  return Math.round(aedToman / usdRate);
}

// درهم امارات (تومان). همان صفحه‌ای که fetchUsdFromAedPeg برای نرخِ برج پگ می‌خواند،
// پس قیمتِ مستقیمِ درهم را از همان می‌گیریم — بدون درخواستِ اضافه.
async function fetchAed(): Promise<number | null> {
  const html = await get("https://alanchand.com/en/currencies-price/aed");
  for (const c of jsonLd(html)) {
    if (c["@type"] === "Product" && c.sku === "AED") {
      const p = Number(c?.offers?.price ?? 0);
      if (p > 0) return Math.round(p / 10);
    }
  }
  const raw =
    attr(html, /<input[^>]*data-curr=["']tmn["'][^>]*data-price=["']([\d,.]+)["']/i) ??
    attr(html, /<input[^>]*data-curr=["']tmn["'][^>]*value=["']([\d,.]+)["']/i);
  return raw ? Math.round(Number(raw.replace(/,/g, "")) / 10) : null;
}

async function fetchEur(): Promise<number | null> {
  const html = await get("https://alanchand.com/en/currencies-price/eur");
  for (const c of jsonLd(html)) {
    if (c["@type"] === "Product" && c.sku === "EUR") {
      const p = Number(c?.offers?.price ?? 0);
      if (p > 0) return Math.round(p / 10);
    }
  }
  const raw =
    attr(html, /<input[^>]*data-curr=["']tmn["'][^>]*data-price=["']([\d,.]+)["']/i) ??
    attr(html, /<input[^>]*data-curr=["']tmn["'][^>]*value=["']([\d,.]+)["']/i);
  return raw ? Math.round(Number(raw.replace(/,/g, "")) / 10) : null;
}

async function fetchGoldAndCoins(): Promise<Record<string, number | string>> {
  const data: Record<string, number | string> = {};
  const html = await get("https://alanchand.com/en/gold-price");

  for (const c of jsonLd(html)) {
    if (c["@type"] !== "ItemList") continue;
    for (const el of c.itemListElement ?? []) {
      const item = el?.item ?? {};
      const name: string = item.name ?? "";
      const offers = item.offers ?? {};
      if (!offers.price) continue;
      const isIrr = offers.priceCurrency === "IRR";
      const v: number | string = isIrr ? Math.round(Number(offers.price) / 10) : String(offers.price);
      if (name.includes("Mesghal")) data.gold_mesghal = v as number;
      else if (name.includes("18K Gold")) data.gold_18k = v as number;
      else if (name.includes("Full Coin") || name.includes("Imami")) data.coin_emami = v as number;
      else if (name.includes("Bahar Azadi")) data.coin_bahar = v as number;
      else if (name.includes("Half Coin")) data.coin_half = v as number;
      else if (name.includes("Quarter Coin")) data.coin_quarter = v as number;
      else if (name.toLowerCase().includes("gram sekke")) data.coin_gram = v as number;
      else if (name.includes("Gold Ounce")) data.gold_ounce = v;
      else if (name.includes("Silver Ounce")) data.silver_ounce = v;
    }
  }

  // table fallback
  if (!data.gold_18k || !data.coin_emami) {
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = trRe.exec(html))) {
      const cells = [...tm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, "").trim().toLowerCase()
      );
      if (cells.length < 2) continue;
      const m = cells[1].replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
      if (!m) continue;
      const n = Number(m[1]) / 10;
      const set = (k: string) => { if (!(k in data)) data[k] = Math.round(n); };
      if (cells[0].includes("18k gold")) set("gold_18k");
      else if (cells[0].includes("mesghal")) set("gold_mesghal");
      else if (cells[0].includes("full coin")) set("coin_emami");
      else if (cells[0].includes("bahar")) set("coin_bahar");
      else if (cells[0].includes("half coin")) set("coin_half");
      else if (cells[0].includes("quarter coin")) set("coin_quarter");
      else if (cells[0].includes("gram sekke")) set("coin_gram");
      else if (cells[0].includes("silver ounce")) set("silver_ounce");
    }
  }
  return data;
}

// Single TradingView symbol quote via the public scanner endpoint (15s timeout).
async function tvClose(id: string): Promise<number | null> {
  const url = `https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(id)}&fields=close&no_404=true`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, "accept": "application/json", "origin": "https://www.tradingview.com", "referer": "https://www.tradingview.com/" },
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j?.close;
    return v != null && Number(v) > 0 ? Number(v) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Which oil source actually supplied the price this run (for verification).
let OIL_SRC = "none";
// Raw responses from the BlackBull candidates, only surfaced when ?debug_oil=1.
let OIL_DEBUG: string[] = [];

// BLACKBULL:BRENT = "Crude Oil Brent (Cash)", a Commodity CFD listed on the
// BLACKBULL OTC exchange. It is NOT in the public scanner API, but TradingView's
// chart-data endpoint serves it. This box SNI-blocks data.tradingview.com, so it
// may be unreachable here — but the Supabase edge (clean network) can reach it.
async function fetchBlackBullBrent(): Promise<number | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const from = nowSec - 86400 * 7;
  const headers = {
    "user-agent": UA,
    "accept": "application/json",
    "origin": "https://www.tradingview.com",
    "referer": "https://www.tradingview.com/",
  };
  const candidates = [
    `https://data.tradingview.com/BLACKBULL/BRENT/intraday_data?period=0&resolution=D&from=${from}&to=${nowSec}`,
    "https://data.tradingview.com/BLACKBULL/BRENT/",
  ];
  for (const url of candidates) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { headers, signal: ctl.signal });
      const bodyText = await r.text();
      OIL_DEBUG.push(`${new URL(url).pathname}?... -> HTTP ${r.status} | ${bodyText.slice(0, 240)}`);
      if (!r.ok) continue;
      const j = JSON.parse(bodyText);
      const rows: any[] = j?.d;
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const last = rows[rows.length - 1];
      const cols: string[] | null = Array.isArray(j?.c) ? j.c : null;
      let ci = cols ? cols.lastIndexOf("c") : 4; // daily [ts,o,h,l,c,v] -> close=4
      if (ci < 0) ci = 4;
      const close = Number(last[ci]);
      // sanity: Brent cash lives in a wide band; reject a wrong-field parse
      if (Number.isFinite(close) && close > 30 && close < 500) return close;
    } catch (e) {
      OIL_DEBUG.push(`fetch threw: ${(e as Error).name}`);
      /* unreachable -> next candidate */
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

async function fetchOil(): Promise<string | null> {
  // Brent Crude (Cash). Previously this silently returned WTI (~104) while the
  // line was labelled "نفت برنت" — about 8% low. Priority: the requested
  // BlackBull cash feed, then a reachable Brent cash CFD, then Brent futures,
  // then Yahoo Brent. First positive value wins.
  const bb = await fetchBlackBullBrent();
  if (bb) { OIL_SRC = "BLACKBULL:BRENT (data.tradingview.com)"; return bb.toFixed(3); }
  const tv = ["FX:UKOIL", "NYMEX:BZ1!", "ICEEUR:BRN1!"];
  for (const id of tv) {
    const v = await tvClose(id);
    if (v) { OIL_SRC = id; return v.toFixed(2); }
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=1d", {
      headers: { "user-agent": UA },
      signal: ctl.signal,
    });
    if (r.ok) {
      const j = await r.json();
      const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (p != null && Number(p) > 0) { OIL_SRC = "Yahoo BZ=F"; return Number(p).toFixed(2); }
    }
  } catch (_) { /* no source available */ } finally {
    clearTimeout(t);
  }
  return null;
}

// نقرهٔ ۹۲۵ (هر گرم، تومان) — منبعِ اصلی: tgju (بازارِ محلی). با retry برای عبور از rate-limit.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fetchSilver925FromTgju(): Promise<{ v: number | null; err?: string }> {
  const attempts = 3;
  let lastErr = "unknown";
  for (let i = 0; i < attempts; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch("https://api.tgju.org/v1/market/indicator/summary-table-data/silver_925", {
        headers: { "user-agent": UA, "accept": "application/json" },
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) { lastErr = `HTTP ${r.status}`; await sleep(3000); continue; }
      const j = await r.json();
      const last = j?.data?.[0]?.[0];
      if (!last) { lastErr = "no data[0][0]"; await sleep(3000); continue; }
      const n = Number(String(last).replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(n)) { lastErr = "bad number"; await sleep(3000); continue; }
      return { v: Math.round(n) };
    } catch (e) {
      lastErr = (e as Error).name + ":" + (e as Error).message;
      await sleep(3000);
    }
  }
  return { v: null, err: lastErr };
}

// ---------------------------------------------------------------- db
async function rest(path: string, opts: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`REST ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

// ---------------------------------------------------------------- telegram
// All digits in messages are Latin. The % sign stays ASCII on purpose:
// Telegram renders "٪" inconsistently inside <b> tags.
const FA = (s: unknown) => String(s);
const faInt = (n: number) => Math.round(n).toLocaleString("en-US");
const faDec = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// price text, no digit substitution
const intTxt = (n: number) => Math.round(n).toLocaleString("en-US");
const decTxt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EMO: Record<string, string> = { usd: "💵", eur: "🇪🇺", aed: "🇦🇪", gold_18k: "✨", gold_mesghal: "⚖️", coin_emami: "🪙", coin_gram: "🪙", gold_ounce: "🌐", silver_ounce: "🥈", silver_gram: "🥈", oil: "⛽" };
const NAME: Record<string, string> = { usd: "دلار", eur: "یورو", aed: "درهم", gold_18k: "طلای 18ع", gold_mesghal: "مثقال طلا", coin_emami: "سکه امامی", coin_gram: "سکه گرمی", gold_ounce: "انس طلا", silver_ounce: "انس نقره", silver_gram: "نقرهٔ 925 (هر گرم)", oil: "نفت برنت" };

async function sendTelegram(text: string) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chat = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chat) return { skipped: "no telegram secrets set" };
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  });
  return { status: r.status, ok: r.ok };
}

// ---- GitHub Pages data push (keeps github.io copy live)
async function ghCommit(path: string, content: string, msg: string): Promise<boolean> {
  const token = Deno.env.get("GITHUB_TOKEN");
  const repo = Deno.env.get("GITHUB_REPO");
  const branch = Deno.env.get("GH_BRANCH") ?? "main";
  if (!token || !repo) return false;
  const api = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;
  const hdr = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let sha: string | null = null;
  try {
    const cur = await fetch(api, { headers: hdr });
    if (cur.ok) sha = (await cur.json()).sha;
  } catch { /* new file */ }
  const body = { message: msg, content: btoa(unescape(encodeURIComponent(content))), branch };
  if (sha) body.sha = sha;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { method: "PUT", headers: hdr, body: JSON.stringify(body) });
    return r.ok || r.status === 200;
  } catch { return false; }
}

// ---------------------------------------------------------------- main
Deno.serve(async (req) => {
  const started = Date.now();
  const wantsTest = new URL(req.url).searchParams.get("test") === "1";
  const wantsDebugOil = new URL(req.url).searchParams.get("debug_oil") === "1";
  const market: Record<string, any> = { usd: null, eur: null, aed: null, gold_18k: null, gold_mesghal: null, gold_ounce: null, silver_ounce: null, silver_gram: null, coin_emami: null, coin_bahar: null, coin_half: null, coin_quarter: null, coin_gram: null, oil: null };
  const errors: string[] = [];

  const jobs: Promise<void>[] = [];
  jobs.push(fetchUsdFromAedPeg().then((v) => (market.usd = v)).catch((e) => errors.push(`usd: ${e.message}`)));
  jobs.push(fetchEur().then((v) => (market.eur = v)).catch((e) => errors.push(`eur: ${e.message}`)));
  jobs.push(fetchAed().then((v) => (market.aed = v)).catch((e) => errors.push(`aed: ${e.message}`)));
  jobs.push(fetchGoldAndCoins().then((d) => Object.assign(market, d)).catch((e) => errors.push(`gold: ${e.message}`)));
  jobs.push(fetchOil().then((v) => (market.oil = v)).catch((e) => errors.push(`oil: ${e.message}`)));
  const silverPromise = fetchSilver925FromTgju();
  await Promise.all(jobs);
  const silverRes = await silverPromise;

  // نقرهٔ ۹۲۵ = نوارِ داخلیِ ~۵ میلیون (منبع: tgju). «فرمولِ جهانیِ انس» WRONG است
  // (نقطهٔ ~۴۷۰ هزار = اسپاتِ بین‌المللی، نه بازارِ داخلیِ ایران). پس fallback = آخرین مقدارِ خوبِ tgju، وگرنه null.
  if (silverRes.v !== null) {
    market.silver_gram = silverRes.v;
  } else {
    const prev = await rest("market?id=eq.1&select=silver_gram") as any[];
    const prevSilver = prev?.[0]?.silver_gram;
    if (prevSilver != null && Number(prevSilver) > 1000000) {
      market.silver_gram = Number(prevSilver);
      errors.push(`silver_925: tgju unavailable (${silverRes.err}), kept last good ${prevSilver}`);
    } else {
      errors.push(`silver_925: tgju unavailable (${silverRes.err}), no last-good`);
    }
  }

  const now = new Date();
  const tehran = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(now);
  const [dPart, tPart] = tehran.split(" ");
  const [gy, gm, gd] = dPart.split("-").map(Number);
  const [jy, jm, jd] = toJalali(gy, gm, gd);
  market.updated_iso = now.toISOString();
  market.updated_at = `${dPart} ${tPart}`;
  market.date = dPart;
  market.time = tPart.slice(0, 5);
  market.date_shamsi = `${jy}/${String(jm).padStart(2, "0")}/${String(jd).padStart(2, "0")}`;

  const ok = Object.entries(market).some(([k, v]) =>
    !["updated_iso", "updated_at", "date", "time", "date_shamsi"].includes(k) && v !== null
  );
  if (!ok) return new Response(JSON.stringify({ ok: false, errors, market }), {
    status: 502, headers: { "Content-Type": "application/json" },
  });

  // snapshot + history  (only the real numeric columns go to the table;
  // updated_iso/date/time live inside `payload` only)
  const FIELDS = ["usd", "eur", "aed", "gold_18k", "gold_mesghal", "gold_ounce", "silver_ounce", "silver_gram", "coin_emami", "coin_bahar", "coin_half", "coin_quarter", "coin_gram", "oil"] as const;
  const row: Record<string, any> = { id: 1, updated_at: now.toISOString(), payload: market };
  for (const f of FIELDS) row[f] = market[f];
  await rest("market?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });

  const watched = ["usd", "eur", "aed", "gold_18k", "gold_mesghal", "coin_emami", "coin_gram", "gold_ounce", "silver_gram", "oil"];
  const rows = watched.filter((s) => market[s] !== null).map((s) => ({
    symbol: s, price: Number(market[s]), ts: now.toISOString(),
  }));
  await rest("rate_history", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });

  // ---- periodic Telegram digest: sectioned, Persian-format, quiet unless it moves
  const thresholdPct = Number(Deno.env.get("ALERT_PCT") ?? "0.5");
  const quietPct = Number(Deno.env.get("ALERT_QUIET_PCT") ?? "0.2");
  const cycleMin = Number(Deno.env.get("ALERT_CYCLE_MIN") ?? "30");
  const volatilityWindowMin = Number(Deno.env.get("VOL_WINDOW_MIN") ?? "60");
  // Per-symbol threshold multiplier: a symbol that rarely moves (coin, gold gram)
  // should not fire on its ordinary noise, while an active one (usd) should.
  const dynThresholdMul = Number(Deno.env.get("ALERT_DYN_MUL") ?? "1.6");
  const dynThresholdFloor = Number(Deno.env.get("ALERT_DYN_FLOOR") ?? "0.35");
  // Heartbeat floor: even in a completely calm market, guarantee a digest if
  // nothing has been sent for this many hours. Prevents the "5 hours of
  // silence" feeling like the system is dead. 0 disables the floor.
  const floorHours = Number(Deno.env.get("ALERT_FLOOR_H") ?? "8");

  const allStates = [...watched, "cycle"];
  const state = await rest(`alert_state?symbol=in.(${allStates.join(",")})&select=symbol,last_price,last_alert_ts`);
  const stateMap: Record<string, any> = Object.fromEntries((state ?? []).map((s) => [s.symbol, s]));
  const lastPrice = (s: string) => (stateMap[s]?.last_price ? Number(stateMap[s].last_price) : null);

  // at most one digest per cycle
  const lastCycleTs = stateMap.cycle?.last_alert_ts ? new Date(stateMap.cycle.last_alert_ts).getTime() : 0;
  const due = now.getTime() - lastCycleTs >= (cycleMin - 5) * 60000;

  const isDollar = (s: string) => s === "gold_ounce" || s === "oil";
  const fmtVal = (s: string, p: number) => (isDollar(s) ? `${faDec(p)} دلار` : `${faInt(p)} تومان`);
  // Per-line percentage is intentionally omitted: the message stays scannable and
  // the only percentage the user sees is the volatility block further down.
  const badge = (_d: number | null) => "";
  const firstOf = (arr: any[], s: string) => { for (const p of arr ?? []) if (p.symbol === s) return Number(p.price); return null; };

  // Volatility window: peak step between consecutive 15-min polls inside the
  // window. Endpoints-only comparison silently misses a spike that retraced,
  // which is exactly the move worth reporting.
  const winMs = volatilityWindowMin * 60 * 1000;
  const rowsWin = await rest(`rate_history?symbol=in.(${watched.join(",")})&ts=gte.${new Date(now.getTime() - winMs).toISOString()}&select=symbol,price,ts&order=ts.asc&limit=2000`);
  const bySym: Record<string, { p: number; t: string }[]> = {};
  for (const r of rowsWin ?? []) (bySym[r.symbol] ??= []).push({ p: Number(r.price), t: r.ts });

  const big2h: { s: string; p: number; thr: number }[] = [];
  for (const s of watched) {
    const arr = (bySym[s] ?? []).filter((x) => Number.isFinite(x.p));
    const cur = Number(market[s]);
    if (arr.length && Number.isFinite(cur)) arr.push({ p: cur, t: now.toISOString() });
    let peak = 0;
    for (let i = 1; i < arr.length; i++) {
      const prevP = arr[i - 1].p;
      if (!prevP) continue;
      const step = ((arr[i].p - prevP) / prevP) * 100;
      if (Math.abs(step) > Math.abs(peak)) peak = step;
    }
    // Dynamic bar: max(floor, multiplier x p90 of this symbol's own 15-min steps).
    // A fixed 0.5% would either spam quiet symbols or hide real dollar moves.
    let dyn = thresholdPct;
    if (dynThresholdMul > 0) {
      const steps: number[] = [];
      for (let i = 1; i < arr.length; i++) {
        const prevP = arr[i - 1].p;
        if (prevP) steps.push(Math.abs(((arr[i].p - prevP) / prevP) * 100));
      }
      if (steps.length >= 8) {
        steps.sort((a, b) => a - b);
        const p90 = steps[Math.min(steps.length - 1, Math.floor(steps.length * 0.9))];
        dyn = Math.max(dynThresholdFloor, p90 * dynThresholdMul);
      }
    }
    if (peak && Math.abs(peak) >= dyn) big2h.push({ s, p: peak, thr: dyn });
  }

  // quiet gate: max move since the last digest
  let moveMax = 0;
  for (const s of watched) { const lp = lastPrice(s); const c = Number(market[s]); if (lp && c) moveMax = Math.max(moveMax, Math.abs((c - lp) / lp) * 100); }

  const SECTIONS = [
    { t: "#ارزها", s: ["usd", "eur", "aed"] },
    { t: "#طلاوسکه", s: ["gold_18k", "gold_mesghal", "gold_ounce", "coin_emami", "coin_gram"] },
    { t: "#نقره", s: ["silver_gram"] },
    { t: "#انرژی", s: ["oil"] },
  ];
  const sectionBlock = SECTIONS.map(({ t, s }) => {
    const lines = s.filter((x) => market[x] !== null).map((x) => {
      const c = Number(market[x]); const lp = lastPrice(x); const d30 = lp ? ((c - lp) / lp) * 100 : null;
      return `${EMO[x]} <b>${NAME[x]}</b>  ${fmtVal(x, c)}${badge(d30)}`;
    });
    return lines.length ? `${t}\n${lines.join("\n")}` : "";
  }).filter(Boolean).join("\n\n");

  const alertBlock = big2h.length
    ? `<b>🚨 نوسانِ ${volatilityWindowMin === 60 ? "1 ساعته" : `${volatilityWindowMin} ساعته`}</b>\n${big2h.map((a) => `${NAME[a.s]} ${a.p > 0 ? "▲" : "▼"}${decTxt(Math.abs(a.p))}%`).join("\n")}`
    : "";

  let tg: any = null;
  let sentDigest = false;
  if (wantsTest) {
    tg = await sendTelegram(`✅ <b>پالس بازار</b> — پیام تستی\n📅 ${market.date_shamsi} · دلار ${market.usd ? faInt(market.usd) : "—"} تومان`);
  } else {
    const hasBaseline = watched.some((s) => lastPrice(s) != null);
    // quiet = market has moved less than quietPct since the last cycle AND no
    // 1h spike. The floor override forces a heartbeat if we've been silent for
    // floorHours, so a calm market never means "forever no message".
    const floorElapsed = floorHours > 0 && (now.getTime() - lastCycleTs) >= floorHours * 3600 * 1000;
    const quiet = hasBaseline && moveMax < quietPct && big2h.length === 0 && !floorElapsed;
    if (due && !quiet) {
      const parts = [`📅 ${market.date_shamsi}\n🕐 ساعت ${FA(market.time)}`];
      parts.push(sectionBlock);
      if (alertBlock) parts.push(alertBlock);
      parts.push(`<code>به‌روزرسانی بعدی: ${FA(cycleMin)} دقیقه دیگه</code>`);
      tg = await sendTelegram(parts.join("\n\n"));
      sentDigest = tg?.ok === true;
    }
  }

  // record per-symbol last price + the cycle timestamp so the next run compares 30-min deltas
  await rest("alert_state", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      ...rows.map((r) => ({ symbol: r.symbol, last_price: r.price, last_alert_ts: now.toISOString() })),
      { symbol: "cycle", last_price: null, last_alert_ts: sentDigest ? now.toISOString() : (stateMap.cycle?.last_alert_ts ?? now.toISOString()) },
    ]),
  });

  // keep the GitHub Pages mirror live (github.io copy of the dashboard)
  let gh = null;
  try {
    const ch = ["usd", "eur", "aed", "gold_18k", "coin_emami", "gold_ounce", "silver_gram", "oil"];
  // Evenly pick at most `n` points, always keeping the newest one.
function downsample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

  const lastN = "last90";
    const hist: Record<string, any[]> = {};
    for (const s of ch) {
      // Sample across the whole window, not just the newest N rows: 90 evenly
      // spaced points over 90 days, so the chart shows real history instead of
      // a couple of days that happen to be in the table.
      const h90 = await rest(`rate_history?symbol=eq.${s}&ts=gte.${new Date(now.getTime() - 90 * 864e5).toISOString()}&select=ts,price&order=ts.asc&limit=2000`);
      hist[s] = downsample((h90 ?? []).map((x) => ({ ts: x.ts, price: Number(x.price) })), 90);
    }
    const payload = JSON.stringify({ updated_at: now.toISOString(), date_shamsi: market.date_shamsi, market, history: hist });
    const ghPath = Deno.env.get("GH_DATA_PATH") ?? "web/data.json";
    const did = await ghCommit(ghPath, payload, `auto: update ${lastN} dashboard data [skip ci]`);
    gh = { path: ghPath, updated: did };
  } catch (e) { gh = { error: (e as Error).message }; }

  return new Response(JSON.stringify({
    ok: true, ms: Date.now() - started, market, errors,
    history_rows: rows.length, digest_sent: sentDigest, telegram: tg, github: gh, oil_source: OIL_SRC,
    ...(wantsDebugOil ? { oil_debug: OIL_DEBUG } : {}),
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
