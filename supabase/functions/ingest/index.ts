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
// درهم به دلار، نرخِ ثابتِ (PEG) بانک مرکزی امارات از ۱۹۹۷: 1 USD = 3.6725 AED.
// قبلاً نرخ را از صفحهٔ aed-usd اسکرِیپ می‌کردیم؛ صفحه عوض شد و regex اول
// دیگر match نمی‌دهد، پس fallback اولین data-rate (= "1") را می‌گرفت ⇒
// usdRate=1 ⇒ دلار = قیمتِ درهم (۷۲٬۳۳۰). پگ ثابت است، پس اصلاً اسکرِیپ
// نمی‌شود — فقط قیمتِ زندهٔ درهم خوانده و در ۳٫۶۷۲۵ ضرب می‌شود.
const AED_USD_PEG = 3.6725;

// پریمیومِ بازارِ نقرهٔ ۹۲۵ روی ارزشِ فلزِ خالصِ بورس کالا (تصمیم حامد،
// ۲۰۲۶-۱۱-۰۹): قیمتِ منتشرشده قیمتی است که کاربرِ نهایی با آن می‌خرد.
// راستی‌آزمایی: tgju (بازار) ۴۳۸٬۲۶۹ در برابر مشتقِ بورس کالا ۴۱۴٬۱۴۴ ⇒
// ۱٫۰۵۸؛ نرخ‌آرا ۹۹۹ِ بازار ۴۷۲٬۰۷۰ در برابر ۹۹۹ِ بورس کالا ۴۴۷٬۷۲۳ ⇒
// ۱٫۰۵۴؛ پریمیومِ مشابه در طلای ۱۸ عیارِ خرده‌فروشی ~۶٪ است. پس ۱٫۰۶.
const SILVER_BAZAAR_PREMIUM = 1.06;
async function fetchUsdFromAedPeg(): Promise<number | null> {
  const aedHtml = await get("https://alanchand.com/en/currencies-price/aed");

  const raw =
    attr(aedHtml, /<input[^>]*data-curr=["']tmn["'][^>]*data-price=["']([\d,.]+)["']/i) ??
    attr(aedHtml, /<input[^>]*data-curr=["']tmn["'][^>]*value=["']([\d,.]+)["']/i);
  if (!raw) return null;

  const aedToman = Number(raw.replace(/,/g, "").trim()) / 10;
  return Math.round(aedToman * AED_USD_PEG);
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
  // تا ۳ تلاش: صفحهٔ طلا گاهی بدون ItemList برمی‌گردد (rate-limit یا صفحهٔ
  // موقت) و قبلاً بی‌صدا {} برمی‌گشت — همهٔ فیلدهای طلا null می‌شدند بدون
  // هیچ خطایی. حالا اگر طلای ۱۸ عیار هیچ‌وقت parse نشد، throw می‌کند تا
  // خطا ثبت و هشدار برود؛ اگر فقط بعضی فیلدها آمدند، بهترینِ تلاش‌ها برمی‌گردد.
  let best: Record<string, number | string> = {};
  for (let attempt = 0; attempt < 3; attempt++) {
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
    if (Object.keys(data).length > Object.keys(best).length) best = data;
    if (data.gold_18k && data.coin_emami) return data;
    await sleep(3000);
  }
  if (best.gold_18k) return best;
  throw new Error("gold page parsed no prices (empty ItemList/table after 3 attempts)");
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

// نقرهٔ ۹۲۵ (هر گرم، تومان) — منبعِ اصلی: بورس کالا، از صفحهٔ silver-price
// الان چند. tgju از ۲۰۲۶-۱۱-۰۹ کاملاً حذف شد (تصمیم حامد: سایت دولتی، قیمت
// را دستکاری/فریز/حذف می‌کند). با retry برای عبور از rate-limit.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// قیمت ۹۲۵ از بورس کالا: صفحه قیمتِ شمش ۹۹۹.۹ را می‌دهد؛ ۹۲۵ = همان نرخ × ۰٫۹۲۵.
// توجه: این قیمت ~۶٪ پایین‌تر از قیمتِ بازارِ ۹۲۵ است (بدون پریمیومِ
// خرده‌فروشی) — نمودارِ نقره در تاریخِ تغییرِ منبع یک پلهٔ ~۶٪ به پایین نشان
// می‌دهد؛ تغییرِ منبع است، نه سقوطِ قیمت.
function faDigitsToNum(s: string): number | null {
  const en = s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[٬,]/g, "");
  const n = Number(en);
  return Number.isFinite(n) ? n : null;
}
async function fetchSilver925FromAlanchand(): Promise<{ v: number | null; v999?: number; err?: string }> {
  const attempts = 2;
  let lastErr = "unknown";
  for (let i = 0; i < attempts; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch("https://alanchand.com/silver-price", {
        headers: { "user-agent": UA, "accept": "text/html" },
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) { lastErr = `HTTP ${r.status}`; await sleep(3000); continue; }
      const h = await r.text();
      // JSON-LD description: "قیمت هر گرم نقرهٔ ۹۹۹ امروز ۴۴۷,۷۲۳ تومان در بورس کالا"
      const m = h.match(/۹۹۹ امروز\s*([۰-۹٠-٩,٬]+)\s*تومان/) ?? h.match(/نقرهٔ ۹۹۹ امروز\s*([۰-۹٠-٩,٬]+)/);
      if (!m) { lastErr = "999 price not found in page"; await sleep(3000); continue; }
      const v999 = faDigitsToNum(m[1]);
      if (v999 === null || v999 < 100000 || v999 > 2000000) { lastErr = `implausible 999: ${m[1]}`; await sleep(3000); continue; }
      return { v: Math.round(v999 * 0.925), v999 };
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

// هشدارِ خرابی به چتِ خصوصیِ حامد (نه کانالِ عمومی). سکرت:
// TELEGRAM_ALERT_CHAT_ID = آیدیِ عددیِ تلگرامِ حامد (از @userinfobot).
// اگر تنظیم نشده باشد، هشدار فقط در `errors` و پاسخِ JSON می‌ماند.
async function sendAlert(text: string) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chat = Deno.env.get("TELEGRAM_ALERT_CHAT_ID");
  if (!token || !chat) return { skipped: "no TELEGRAM_ALERT_CHAT_ID set" };
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
  const wantsAlertTest = new URL(req.url).searchParams.get("alert_test") === "1";
  const wantsDebugOil = new URL(req.url).searchParams.get("debug_oil") === "1";
  const market: Record<string, any> = { usd: null, eur: null, aed: null, gold_18k: null, gold_mesghal: null, gold_ounce: null, silver_ounce: null, silver_gram: null, coin_emami: null, coin_bahar: null, coin_half: null, coin_quarter: null, coin_gram: null, oil: null };
  const errors: string[] = [];

  const jobs: Promise<void>[] = [];
  jobs.push(fetchUsdFromAedPeg().then((v) => (market.usd = v)).catch((e) => errors.push(`usd: ${e.message}`)));
  jobs.push(fetchEur().then((v) => (market.eur = v)).catch((e) => errors.push(`eur: ${e.message}`)));
  jobs.push(fetchAed().then((v) => (market.aed = v)).catch((e) => errors.push(`aed: ${e.message}`)));
  jobs.push(fetchGoldAndCoins().then((d) => Object.assign(market, d)).catch((e) => errors.push(`gold: ${e.message}`)));
  jobs.push(fetchOil().then((v) => (market.oil = v)).catch((e) => errors.push(`oil: ${e.message}`)));
  const silverPromise = fetchSilver925FromAlanchand();
  await Promise.all(jobs);
  const silverRes = await silverPromise;

  // مقدارهای چرخهٔ قبل — هم برای fallback نقره، هم برای گاردریل. اگر خوانده
  // نشد (اولین اجرا یا قطعی DB) گاردریل رد می‌شود، نه کل چرخه.
  let prev: Record<string, any> | null = null;
  try {
    const prevRows = await rest("market?id=eq.1&select=usd,eur,aed,gold_18k,gold_mesghal,gold_ounce,silver_ounce,silver_gram,coin_emami,coin_bahar,coin_half,coin_quarter,coin_gram,oil") as any[];
    prev = prevRows?.[0] ?? null;
  } catch (_) { /* no previous row -> guards skip */ }

  // نقرهٔ ۹۲۵ = مشتق از شمش ۹۹۹.۹ بورس کالا (صفحهٔ silver-price الان چند).
  // از ۲۰۲۶-۱۱-۰۹ tgju کاملاً حذف شد (تصمیم حامد). روی مقدارِ بورس کالا
  // پریمیومِ بازار اضافه می‌شود (SILVER_BAZAAR_PREMIUM) چون قیمتِ منتشرشده
  // قیمتی است که کاربرِ نهایی با آن می‌خرد — ارزشِ فلزِ خالص نیست.
  // fallback = آخرین مقدارِ خوبِ منتشرشده، وگرنه null.
  let silverBase: number | null = null;
  if (silverRes.v !== null) {
    silverBase = silverRes.v;
    market.silver_gram = Math.round(silverRes.v * SILVER_BAZAAR_PREMIUM);
  } else {
    const prevSilver = prev?.silver_gram;
    if (prevSilver != null && Number(prevSilver) > 100000) {
      market.silver_gram = Number(prevSilver);
      errors.push(`silver_925: alanchand silver page unavailable (${silverRes.err}), kept last good ${market.silver_gram}`);
    } else {
      errors.push(`silver_925: alanchand silver page unavailable (${silverRes.err}), no last-good`);
    }
  }

  // ---- گاردریل قیمت (بستهٔ اطمینان، ۲۰۲۶-۱۱-۰۹)
  // هر مقدارِ تازه باید (۱) نسبت به چرخهٔ قبل جهشِ ناممکن نداشته باشد و
  // (۲) با قیمت‌های هم‌خانواده سازگار باشد. در غیر این صورت مقدارِ قبلیِ خوب
  // نگه داشته می‌شود و دلیلش در `rejected` می‌رود (برای هشدار + پاسخ JSON).
  // حدها عامدانه گشاده‌اند: کارشان گرفتنِ خطاهای بزرگ (مثل دلارِ ۷۲٬۳۳۰
  // به‌جای ۲۶۵٬۰۰۰) است، نه نوسانِ واقعیِ بازار.
  const MOVE_LIMIT: Record<string, number> = {
    usd: 0.08, eur: 0.08, aed: 0.08,
    gold_18k: 0.06, gold_mesghal: 0.06, gold_ounce: 0.03, silver_ounce: 0.05,
    silver_gram: 0.08, coin_emami: 0.06, coin_bahar: 0.06, coin_half: 0.06,
    coin_quarter: 0.06, coin_gram: 0.06, oil: 0.08,
  };
  const rejected: string[] = [];
  const prevNum = (s: string): number | null => {
    const v = prev ? Number((prev as any)[s]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  function rejectSymbol(s: string, reason: string) {
    rejected.push(`${s}: ${reason}`);
    market[s] = prevNum(s);
  }
  for (const s of Object.keys(MOVE_LIMIT)) {
    const v = market[s];
    if (v === null || v === undefined) continue;
    const cur = Number(v);
    const pv = prevNum(s);
    if (!Number.isFinite(cur)) { rejectSymbol(s, `not-a-number (${String(v)})`); continue; }
    if (pv !== null && Math.abs(cur - pv) / pv > MOVE_LIMIT[s]) {
      rejectSymbol(s, `${pv.toLocaleString("en-US")} -> ${cur.toLocaleString("en-US")} (${((cur - pv) / pv * 100).toFixed(1)}%, limit ${(MOVE_LIMIT[s] * 100).toFixed(0)}%)`);
    }
  }
  // (۲) دلار باید نزدیک درهم × پگ باشد (رگرسیونِ همان باگِ ۷۲٬۳۳۰)
  if (market.usd != null && market.aed != null) {
    const implied = Number(market.aed) * AED_USD_PEG;
    if (implied > 0 && Math.abs(Number(market.usd) - implied) / implied > 0.02) {
      rejectSymbol("usd", `vs aed-peg: usd=${market.usd} aed*3.6725=${Math.round(implied)}`);
    }
  }
  // (۴) طلای ۱۸ عیار باید نزدیک انس × دلار باشد (با تلورانسِ پریمیومِ داخلی)
  const moveOf = (s: string): number => {
    const pv = prevNum(s);
    return pv !== null && market[s] != null ? Math.abs(Number(market[s]) - pv) / pv : 0;
  };
  if (market.gold_18k != null && market.gold_ounce != null && market.usd != null) {
    const implied18k = Number(market.gold_ounce) * Number(market.usd) / 31.1035 * 0.75;
    const ratio = Number(market.gold_18k) / implied18k;
    if (implied18k > 0 && (ratio < 0.90 || ratio > 1.08)) {
      rejectSymbol(moveOf("gold_18k") >= moveOf("gold_ounce") ? "gold_18k" : "gold_ounce",
        `18k/ounce ratio ${ratio.toFixed(3)} (want 0.90-1.08)`);
    }
  }
  if (rejected.length) errors.push(`guardrail rejected: ${rejected.join(" | ")}`);

  // ---- کراس‌چک نقره (۲۰۲۶-۱۱-۰۹): مقدارِ بورس کالا در برابر انسِ جهانی.
  // ۹۲۵ مشتق‌شده از شمشِ بورس کالا باید نزدیک انسِ نقره × دلار باشد
  // (۹۲۵ = انس × دلار ÷ ۳۱٫۱۰۳۵ × ۰٫۹۲۵). باند عامدانه گشاده است چون بورس
  // کالا فقط در ساعتِ معاملات به‌روز می‌شود و انس شبانه‌روز حرکت می‌کند؛
  // اگر از باند خارج شد، یا صفحهٔ الان چند یا انسِ جهانی اشتباه می‌کند ⇒
  // خطا (⇒ هشدار). کراس‌چک روی مقدارِ پایه (پیش از پریمیوم) است.
  let silverXcheck: { ime_derived: number; spot_derived: number; ratio: number; published: number } | null = null;
  // انس و دلار اگر این چرخه null بودند، از چرخهٔ قبل می‌آیند (انس در ۱۵ دقیقه
  // کم حرکت می‌کند) تا کراس‌چک با یک گپِ موقتِ طلا از کار نیفتد.
  const ozForX = market.silver_ounce ?? prev?.silver_ounce;
  const usdForX = market.usd ?? prev?.usd;
  if (silverBase != null && ozForX != null && usdForX != null) {
    const spot = Number(ozForX) * Number(usdForX) / 31.1035 * 0.925;
    const ratio = silverBase / spot;
    silverXcheck = { ime_derived: silverBase, spot_derived: Math.round(spot), ratio: Math.round(ratio * 1000) / 1000, published: Number(market.silver_gram) };
    if (spot > 0 && (ratio < 0.93 || ratio > 1.07)) {
      errors.push(`silver_xcheck: ime ${silverBase} vs spot-derived ${silverXcheck.spot_derived} (ratio ${silverXcheck.ratio}, want 0.93-1.07)`);
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
  const cycleMin = Number(Deno.env.get("ALERT_CYCLE_MIN") ?? "15");
  const volatilityWindowMin = Number(Deno.env.get("VOL_WINDOW_MIN") ?? "60");
  // Per-symbol threshold multiplier: a symbol that rarely moves (coin, gold gram)
  // should not fire on its ordinary noise, while an active one (usd) should.
  const dynThresholdMul = Number(Deno.env.get("ALERT_DYN_MUL") ?? "1.6");
  const dynThresholdFloor = Number(Deno.env.get("ALERT_DYN_FLOOR") ?? "0.35");
  // Heartbeat floor: even in a completely calm market, guarantee a digest if
  // nothing has been sent for this many hours. Prevents the "5 hours of
  // silence" feeling like the system is dead. 0 disables the floor.
  const floorHours = Number(Deno.env.get("ALERT_FLOOR_H") ?? "8");

  const allStates = [...watched, "cycle", "health"];
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
      // جهشِ بیش از ۱۵٪ در ۱۵ دقیقه آرتیفکتِ داده است (مثلاً بعد از اصلاحِ
      // منبع — دلار ۲۶۷٪ و نقره ۹۰٪ در ۹ نوامبر) نه نوسانِ بازار؛ نادیده بگیر.
      if (Math.abs(step) > 15) continue;
      if (Math.abs(step) > Math.abs(peak)) peak = step;
    }
    // Dynamic bar: max(floor, multiplier x p90 of this symbol's own 15-min steps).
    // A fixed 0.5% would either spam quiet symbols or hide real dollar moves.
    let dyn = thresholdPct;
    if (dynThresholdMul > 0) {
      const steps: number[] = [];
      for (let i = 1; i < arr.length; i++) {
        const prevP = arr[i - 1].p;
        // همان فیلترِ آرتیفکت: وگرنه یک جهشِ ۲۶۷٪ آستانهٔ پویا را خراب می‌کند.
        if (prevP) { const st = Math.abs(((arr[i].p - prevP) / prevP) * 100); if (st <= 15) steps.push(st); }
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
  // بخش‌ها هرگز ناپدید نمی‌شوند: اگر مقدارِ تازه null بود، آخرین قیمتِ خوب
  // با برچسبِ «آخرین قیمت» می‌آید، و اگر هیچ سابقه‌ای نبود «—».
  const sectionBlock = SECTIONS.map(({ t, s }) => {
    const lines = s.map((x) => {
      if (market[x] !== null && market[x] !== undefined) {
        const c = Number(market[x]); const lp = lastPrice(x); const d30 = lp ? ((c - lp) / lp) * 100 : null;
        return `${EMO[x]} <b>${NAME[x]}</b>  ${fmtVal(x, c)}${badge(d30)}`;
      }
      const lp = lastPrice(x);
      if (lp !== null && lp !== undefined) {
        return `${EMO[x]} <b>${NAME[x]}</b>  ${fmtVal(x, Number(lp))} <i>(آخرین قیمت)</i>`;
      }
      return `${EMO[x]} <b>${NAME[x]}</b>  —`;
    });
    return `${t}\n${lines.join("\n")}`;
  }).join("\n\n");

  const alertBlock = big2h.length
    ? `<b>🚨 نوسانِ ${volatilityWindowMin === 60 ? "1 ساعته" : `${volatilityWindowMin} ساعته`}</b>\n${big2h.map((a) => `${NAME[a.s]} ${a.p > 0 ? "▲" : "▼"}${decTxt(Math.abs(a.p))}%`).join("\n")}`
    : "";

  let tg: any = null;
  let sentDigest = false;
  let testMessage: string | null = null;
  if (wantsTest) {
    // تست دیگر به کانالِ عمومی نمی‌رود (قبلاً هر فراخوانیِ تست یک پیامِ اضافه
    // در کانال می‌ساخت)؛ متنِ پیام در پاسخ برمی‌گردد.
    testMessage = `✅ <b>پالس بازار</b> — پیام تستی\n📅 ${market.date_shamsi} · دلار ${market.usd ? faInt(market.usd) : "—"} تومان`;
    tg = { skipped: "test mode: not sent to channel" };
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

  // record per-symbol last price + the cycle timestamp so the next run compares 15-min deltas
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

  // ---- هشدار خرابی (بستهٔ اطمینان): فقط به چتِ هشدارِ حامد، نه کانالِ عمومی.
  // یک مشکلِ تکراری حداکثر هر ۲ ساعت یک بار هشدار می‌دهد (امضایش در
  // alert_state با نماد `health` ذخیره می‌شود). در حالتِ تست هشدار نمی‌رود.
  let alert: any = null;
  const ghFailed = !(gh && (gh as any).updated === true);
  if (!wantsTest && (errors.length > 0 || ghFailed)) {
    const otherErrors = errors.filter((e) => !e.startsWith("guardrail rejected"));
    const sig = [
      ...rejected.map((r) => "guard:" + r.split(":")[0]),
      ...otherErrors.map((e) => "err:" + e.split(":")[0]),
      ...(ghFailed ? ["gh-push"] : []),
    ].sort().join(",");
    let sigHash = 0;
    for (let i = 0; i < sig.length; i++) sigHash = (sigHash * 31 + sig.charCodeAt(i)) >>> 0;
    const lastHealth = stateMap.health;
    const sameProblem = lastHealth?.last_price != null && Number(lastHealth.last_price) === sigHash;
    const throttled = sameProblem && lastHealth?.last_alert_ts &&
      (now.getTime() - new Date(lastHealth.last_alert_ts).getTime()) < 2 * 3600 * 1000;
    if (!throttled) {
      const lines = [`⚠️ <b>پالس بازار — هشدار سیستم</b>`, `📅 ${market.date_shamsi} · 🕐 ${FA(market.time)}`];
      if (rejected.length) lines.push(`🚫 رد شده توسط گاردریل:\n${rejected.map((r) => `• ${r}`).join("\n")}`);
      if (otherErrors.length) lines.push(`❌ خطاها:\n${otherErrors.map((e) => `• ${e}`).join("\n")}`);
      if (ghFailed) lines.push(`❌ push آینهٔ گیت‌هاب ناموفق بود (data.json تازه نشد)`);
      alert = await sendAlert(lines.join("\n\n"));
      await rest("alert_state", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ symbol: "health", last_price: sigHash, last_alert_ts: now.toISOString() }]),
      }).catch(() => null);
    } else {
      alert = { skipped: "same problem alerted <2h ago" };
    }
  }

  // تستِ دستیِ هشدار: ?alert_test=1 یک پیامِ تست به چتِ هشدار می‌فرستد
  // (برای اثباتِ اینکه آیدیِ TELEGRAM_ALERT_CHAT_ID درست است).
  if (wantsAlertTest) {
    alert = await sendAlert(`✅ <b>پالس بازار — تست هشدار</b>\nاین پیامِ تستِ هشدارِ خرابی است؛ اگر آن را می‌بینی، هشدارها به چتِ درست می‌رسند.`);
  }

  return new Response(JSON.stringify({
    ok: true, ms: Date.now() - started, market, errors, rejected, alert, silver_xcheck: silverXcheck, test_message: testMessage,
    history_rows: rows.length, digest_sent: sentDigest, telegram: tg, github: gh, oil_source: OIL_SRC,
    ...(wantsDebugOil ? { oil_debug: OIL_DEBUG } : {}),
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
