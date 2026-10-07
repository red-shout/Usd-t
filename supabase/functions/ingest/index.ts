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

async function fetchOil(): Promise<string | null> {
  const html = await get("https://oilprice.com/oil-price-charts/46");
  const m = html.match(/class=["'][^"']*last_price[^"']*["'][^>]*>([\s\S]{0,120}?)</i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : null;
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
const FA = (s: string) =>
  String(s).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]).replace(/\./g, "٫").replace(/,/g, "٬");
const faInt = (n: number) => FA(Math.round(n).toLocaleString("en-US"));
const faDec = (n: number) => FA(n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const EMO: Record<string, string> = { usd: "💵", eur: "🇪🇺", gold_18k: "✨", coin_emami: "🪙", gold_ounce: "🌐", silver_ounce: "🥈", silver_gram: "🥈", oil: "⛽" };
const NAME: Record<string, string> = { usd: "دلار", eur: "یورو", gold_18k: "طلای ۱۸ع", coin_emami: "سکه امامی", gold_ounce: "انس طلا", silver_ounce: "انس نقره", silver_gram: "نقرهٔ ۹۲۵ (هر گرم)", oil: "نفت برنت" };

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
  const market: Record<string, any> = { usd: null, eur: null, gold_18k: null, gold_mesghal: null, gold_ounce: null, silver_ounce: null, silver_gram: null, coin_emami: null, coin_bahar: null, coin_half: null, coin_quarter: null, coin_gram: null, oil: null };
  const errors: string[] = [];

  const jobs: Promise<void>[] = [];
  jobs.push(fetchUsdFromAedPeg().then((v) => (market.usd = v)).catch((e) => errors.push(`usd: ${e.message}`)));
  jobs.push(fetchEur().then((v) => (market.eur = v)).catch((e) => errors.push(`eur: ${e.message}`)));
  jobs.push(fetchGoldAndCoins().then((d) => Object.assign(market, d)).catch((e) => errors.push(`gold: ${e.message}`)));
  jobs.push(fetchOil().then((v) => (market.oil = v)).catch((e) => errors.push(`oil: ${e.message}`)));
  await Promise.all(jobs);

  // نقرهٔ ۹۲۵ به تومان (هر گرم) = انس × دلار ÷ وزنِ انس (۳۱٫۱۰۳۴۷۶۸ گرم) × عیار (۰٫۹۲۵)
  if (market.usd && market.silver_ounce) {
    market.silver_gram = Math.round((Number(market.silver_ounce) * Number(market.usd)) / 31.1034768 * 0.925);
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
  const FIELDS = ["usd", "eur", "gold_18k", "gold_mesghal", "gold_ounce", "silver_ounce", "silver_gram", "coin_emami", "coin_bahar", "coin_half", "coin_quarter", "coin_gram", "oil"] as const;
  const row: Record<string, any> = { id: 1, updated_at: now.toISOString(), payload: market };
  for (const f of FIELDS) row[f] = market[f];
  await rest("market?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });

  const watched = ["usd", "eur", "gold_18k", "coin_emami", "gold_ounce", "silver_ounce", "silver_gram", "oil"];
  const rows = watched.filter((s) => market[s] !== null).map((s) => ({
    symbol: s, price: Number(market[s]), ts: now.toISOString(),
  }));
  await rest("rate_history", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });

  // ---- periodic Telegram digest (one message per cron cycle) + big-mover flags
  const thresholdPct = Number(Deno.env.get("ALERT_PCT") ?? "0.5");
  const cycleMin = Number(Deno.env.get("ALERT_CYCLE_MIN") ?? "30");

  const allStates = [...watched, "cycle"];
  const state = await rest(`alert_state?symbol=in.(${allStates.join(",")})&select=symbol,last_price,last_alert_ts`);
  const stateMap: Record<string, any> = Object.fromEntries((state ?? []).map((s) => [s.symbol, s]));

  // only send one digest per cycle: skip if we already sent within (cycleMin - 5min) tolerance
  const lastCycleTs = stateMap.cycle?.last_alert_ts ? new Date(stateMap.cycle.last_alert_ts).getTime() : 0;
  const due = now.getTime() - lastCycleTs >= (cycleMin - 5) * 60000;

  const badge = (d30: number | null): string =>
    d30 === null || Math.abs(d30) < 0.005 ? "" : ` <i>${d30 > 0 ? "↑" : "↓"}${FA(Math.abs(d30).toFixed(1))}٪</i>`;
  const line = (r: any): string => {
    const prev = stateMap[r.symbol]?.last_price ? Number(stateMap[r.symbol].last_price) : null;
    const d30 = prev ? ((r.price - prev) / prev) * 100 : null;
    const isDollar = r.symbol === "gold_ounce" || r.symbol === "silver_ounce" || r.symbol === "oil";
    const val = isDollar ? `${faDec(r.price)} دلار` : `${faInt(r.price)} تومان`;
    return `${EMO[r.symbol]} <b>${NAME[r.symbol]}</b>  ${val}${badge(d30)}`;
  };

  let tg: any = null;
  let sentDigest = false;
  if (wantsTest) {
    tg = await sendTelegram(
      `✅ <b>پالس بازار</b> — پیام تستی\n🕘 ${market.date_shamsi} · دلار ${market.usd ? faInt(market.usd) : "—"} تومان`
    );
  } else if (due) {
    const digestLines = rows.map(line).join("\n");
    // big movers over 2h window
    const since2h = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
    const prev2h = await rest(`rate_history?symbol=in.(${watched.join(",")})&ts=gte.${since2h}&select=symbol,price&order=ts.asc`);
    const first2h: Record<string, number> = {};
    for (const p of prev2h ?? []) if (!(p.symbol in first2h)) first2h[p.symbol] = Number(p.price);
    const big: string[] = [];
    for (const r of rows) {
      const base = first2h[r.symbol];
      if (!base) continue;
      const pct = ((r.price - base) / base) * 100;
      if (Math.abs(pct) >= thresholdPct) big.push(`🚨 <b>${NAME[r.symbol]}</b>  ${pct > 0 ? "▲" : "▼"}${FA(Math.abs(pct).toFixed(1))}٪ در ۲ ساعت`);
    }
    const alertBlock = big.length
      ? `\n\n<code>──────────────</code>\n<b>نوسان ۲ ساعته</b>\n${big.join("\n")}` : "";
    const body = `📊 <b>پالس بازار</b>\n🕘 ${market.date_shamsi} · ساعت ${FA(market.time)}\n\n${digestLines}${alertBlock}\n\n<code>به‌روزرسانی بعدی: ۳۰ دقیقه دیگه</code>`;
    tg = await sendTelegram(body);
    sentDigest = tg?.ok === true;
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
    const ch = ["usd", "eur", "gold_18k", "coin_emami", "gold_ounce", "silver_ounce", "silver_gram", "oil"];
    const lastN = "last90";
    const hist: Record<string, any[]> = {};
    for (const s of ch) {
      const h = await rest(`rate_history?symbol=eq.${s}&select=ts,price&order=ts.desc&limit=90`);
      hist[s] = (h ?? []).map((x) => ({ ts: x.ts, price: x.price }));
    }
    const payload = JSON.stringify({ updated_at: now.toISOString(), date_shamsi: market.date_shamsi, market, history: hist });
    const ghPath = Deno.env.get("GH_DATA_PATH") ?? "web/data.json";
    const did = await ghCommit(ghPath, payload, `auto: update ${lastN} dashboard data [skip ci]`);
    gh = { path: ghPath, updated: did };
  } catch (e) { gh = { error: (e as Error).message }; }

  return new Response(JSON.stringify({
    ok: true, ms: Date.now() - started, market, errors,
    history_rows: rows.length, digest_sent: sentDigest, telegram: tg, github: gh,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
