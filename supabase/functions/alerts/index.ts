// پالس بازار · alerts — monitors hazard sources and posts significant events
// (earthquakes + strong weather warnings) to the market Telegram channel,
// deduplicated, IMMEDIATELY when they appear — never batched with the
// 15-minute price digest (an alert 15 minutes late is a joke).
//
// Sources (all free, no key):
//   - Earthquake: USGS FDSN feed (global, structured, reachable). IRNO is the
//     official Iranian feed but is SNI-blocked here; USGS is the reliable proxy.
//   - Weather: IRIMETS (irimo.ir) "هشدار هواشناسی" red/orange warnings.
//     Fallback while irimo is unreachable: Open-Meteo forecast (free, no
//     key) for Tehran + Karaj, with fixed thresholds — gusts >= 80 km/h
//     (next 6h), rain >= 20 mm / 6h or >= 30 mm / 24h, hail thunderstorm
//     (WMO 96/99, next 6h), snow >= 10 cm / 12h. The fallback runs ONLY
//     when the irimo fetch fails; when irimo is back it stops by itself
//     (irimo stays the primary source). irimo backoff: after 3 consecutive
//     failures it is checked at most once an hour (counter in alert_state,
//     symbol irimo:fail); Open-Meteo covers the gap meanwhile. Forecast-
//     derived alerts are labelled as such in the message — they are NOT
//     official warnings.
//
// Scope (Hamed, 2026-11-09): Tehran + Alborz only, for now.
//   - Quakes: epicentre inside the Tehran+Alborz box (lat 35.2–36.4, lon 50.3–52.6).
//   - Weather: the warning's detail page must mention Tehran or Alborz.
//
// Polling: pg_cron every 5 minutes (alerts-5min). Each run posts fresh
// candidates to Telegram at once; nothing waits for the price cycle.
//
// Safety: a source that fails to fetch posts nothing for that source — we
// never post a half-parsed or fabricated alert. But the failure is NOT
// silent: it goes into `errors`, the response, and (throttled 6h) a private
// notice to Hamed, so a dead source is visible instead of looking like
// "no alerts".
//
// Fixes vs the deployed v3 (2026-11-09):
//   1. dedup bug: rest() did JSON.parse(opts.body) on an already-stringified
//      body, so fetch sent "[object Object]" and the published row never
//      recorded -> the same alert would re-post next run. Body is now passed
//      through as a string.
//   2. weather fetch errors were swallowed (catch {} -> []); now returned
//      and reported.
//   3. no province filter: any province's red/orange warning would post.
//      Now Tehran+Alborz only (detail-page check).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TG_CHAT = Deno.env.get("TELEGRAM_CHAT_ID");
const TG_ALERT_CHAT = Deno.env.get("TELEGRAM_ALERT_CHAT_ID");

async function rest(path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method ?? "GET",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: opts.body ?? undefined,
  });
  if (!r.ok) throw new Error(`rest ${r.status}: ${await r.text()}`);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

async function sendTG(chat: string | undefined, text: string) {
  if (!TG_TOKEN || !chat) return { ok: false, err: "telegram not configured" };
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  });
  const j = await r.json();
  return { ok: !!j.ok, status: r.status };
}

// Throttled private notice (max once per 6h per source) when a source is down.
async function noteSourceDown(kind: string, detail: string): Promise<void> {
  try {
    const sym = `alerts:${kind}`;
    const rows = await rest(`alert_state?symbol=eq.${encodeURIComponent(sym)}&select=last_alert_ts`) as any[];
    const last = rows?.[0]?.last_alert_ts ? Date.parse(rows[0].last_alert_ts) : 0;
    if (Date.now() - last < 6 * 3600 * 1000) return;
    const r = await sendTG(TG_ALERT_CHAT, `⚠️ <b>پالس بازار — منبع هشدار قطع است</b>\n${kind}: ${detail}\nهشدارهای این منبع تا رفع مشکل منتشر نمی‌شوند.`);
    if (!r.ok) return;
    const body = JSON.stringify({ symbol: sym, last_alert_ts: new Date().toISOString() });
    await rest(`alert_state?on_conflict=symbol`, {
      method: "POST",
      body,
      headers: { Prefer: "resolution=merge-duplicates" },
    });
  } catch (_) { /* notice failure must never break the alert run */ }
}

// ---------------------------------------------------------------- earthquake
async function fetchQuakes(minMag: number): Promise<any[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=${minMag}&limit=100`,
      { headers: { "user-agent": "pulsar-market/1.0" }, signal: ctl.signal },
    );
    if (!r.ok) throw new Error(`USGS HTTP ${r.status}`);
    const j = await r.json();
    return j?.features ?? [];
  } finally {
    clearTimeout(t);
  }
}

// Tehran + Alborz box (Hamed, 2026-11-09 — for now; Qom etc. excluded).
function inScope(c: number[]) {
  const [lon, lat] = c;
  return lon >= 50.3 && lon <= 52.6 && lat >= 35.2 && lat <= 36.4;
}

function tehranTime(ms: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit",
  }).format(new Date(ms));
}

function faNum(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

// USGS place strings are English ("10 km E of Damavand, Iran"). Render them
// in Persian when the city is known (Tehran+Alborz box); otherwise keep the
// original English so nothing is lost.
const QUAKE_CITIES: Record<string, string> = {
  Tehran: "تهران", Karaj: "کرج", Damavand: "دماوند", Demavend: "دماوند",
  Firouzkouh: "فیروزکوه", Firuzkuh: "فیروزکوه", Lavasan: "لواسان",
  Shemshak: "شمشک", Pardis: "پردیس", Shahriar: "شهریار",
  Eslamshahr: "اسلامشهر", "Robat Karim": "رباط‌کریم", Varamin: "ورامین",
  Pakdasht: "پاکدشت", Savojbolagh: "ساوجبلاغ", Hashtgerd: "هشتگرد",
  Taleghan: "طالقان", Fasham: "فشم", Rudehen: "رودهن", Bumehen: "بومهن",
  Absard: "آبسرد", Kilan: "کیلان", Arjomand: "ارجمند", Abali: "آب‌علی",
  Jajrud: "جاجرود", Shemiran: "شمیران", Ray: "ری", Qods: "قدس",
  Malard: "ملارد", Andisheh: "اندیشه", Parand: "پرند", Nazarabad: "نظرآباد",
  Eshtehard: "اشتهارد", Chaharbagh: "چهارباغ", Mohammadshahr: "محمدشهر",
  "Meshkin Dasht": "مشکین‌دشت", "Kamal Shahr": "کمال‌شهر",
  Garmdarreh: "گرمدره", Garmsar: "گرمسار", Aradan: "آرادان",
  Sorkheh: "سرخه", Eyvanekey: "ایوانکی",
};
const QUAKE_DIRS: Record<string, string> = {
  N: "شمال", S: "جنوب", E: "شرق", W: "غرب",
  NE: "شمال‌شرق", NW: "شمال‌غرب", SE: "جنوب‌شرق", SW: "جنوب‌غرب",
};
function placeFa(place: string): string {
  const m = place.match(/^(\d+)\s*km\s+([NSEW]{1,2})\s+of\s+(.+?)(?:,\s*Iran)?$/i);
  if (m) {
    const city = QUAKE_CITIES[m[3].trim()] ?? m[3].trim();
    const dir = QUAKE_DIRS[m[2].toUpperCase()] ?? m[2];
    return `${faNum(m[1])} کیلومتری ${dir} ${city}`;
  }
  const bare = place.replace(/,\s*Iran$/i, "").trim();
  if (QUAKE_CITIES[bare]) return QUAKE_CITIES[bare];
  return place;
}

// ---------------------------------------------------------------- weather
async function fetchWeatherWarnings(): Promise<{ id: string; level: string; text: string }[]> {
  // IRIMETS homepage lists the most recent "هشدار هواشناسی" news items with a
  // colour level. Post only red/orange (the "important" tiers), deduped by id,
  // and only when the warning's detail page names Tehran or Alborz.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const out: { id: string; level: string; text: string }[] = [];
  try {
    const r = await fetch("https://www.irimo.ir/", { headers: { "user-agent": "Mozilla/5.0" }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`irimo HTTP ${r.status}`);
    const html = await r.text();
    // links: /far/services/news/<id>-هشدار-هواشناسی-سطح-<level>-...
    const re = /irimo\.ir\/far\/services\/news\/(\d+)-هشدار-هواشناسی(?:-دریایی)?-سطح-(قرمز|نارنجی|زرد)[^"']*/g;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    const lvl: Record<string, string> = { "قرمز": "red", "نارنجی": "orange", "زرد": "yellow" };
    while ((m = re.exec(html)) !== null) {
      const [, id, word] = m;
      if (seen.has(id)) continue;
      seen.add(id);
      const level = lvl[word];
      if (level !== "red" && level !== "orange") continue;
      const link = `https://www.irimo.ir/far/services/news/${id}`;
      // Province check: the detail page names the province/region.
      let detail = "";
      try {
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 10000);
        try {
          const r2 = await fetch(link, { headers: { "user-agent": "Mozilla/5.0" }, signal: c2.signal, redirect: "follow" });
          if (r2.ok) detail = await r2.text();
        } finally {
          clearTimeout(t2);
        }
      } catch (_) { /* detail fetch failed -> province unverified, skip below */ }
      if (!detail) throw new Error(`irimo detail ${id}: unreachable (province unverified)`);
      const title = (detail.match(/<title>(.*?)<\/title>/s)?.[1] ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 120);
      if (!/تهران|البرز/.test(detail)) continue; // other province -> not our scope
      const head = title ? `\n${title}` : "";
      out.push({ id, level, text: `<b>⚠️ هشدار هواشناسی — سطح ${word}</b>${head}\nجزئیات: ${link}` });
    }
  } finally {
    clearTimeout(t);
  }
  return out;
}

// ---------------------------------------------------------------- weather fallback (Open-Meteo)
// Free forecast API, no key. Runs ONLY when the irimo fetch fails.
// Thresholds (Hamed-approved defaults, 2026-11-09):
//   gusts >= 80 km/h (next 6h) | rain >= 20 mm / 6h or >= 30 mm / 24h
//   hail thunderstorm WMO 96/99 (next 6h) | snow >= 10 cm (next 12h)
const OM_LOCS = [
  { name: "تهران", lat: 35.6892, lon: 51.389 },
  { name: "کرج (البرز)", lat: 35.84, lon: 50.9391 },
];
const OM_GUST_KMH = 80;
const OM_RAIN_6H_MM = 20;
const OM_RAIN_24H_MM = 30;
const OM_SNOW_12H_CM = 10;

async function fetchOpenMeteoAlerts(): Promise<{ key: string; text: string }[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=35.6892,35.84&longitude=51.389,50.9391&hourly=precipitation,wind_gusts_10m,snowfall,weather_code&forecast_days=2&timezone=Asia%2FTehran";
    const r = await fetch(url, { headers: { "user-agent": "pulsar-market/1.0" }, signal: ctl.signal });
    if (!r.ok) throw new Error(`open-meteo HTTP ${r.status}`);
    const data = await r.json();
    const locs = Array.isArray(data) ? data : [data];
    // Current hour in Tehran as "YYYY-MM-DDTHH" (Tehran = UTC+3:30).
    const cur = new Date(Date.now() + 3.5 * 3600 * 1000).toISOString().slice(0, 13);
    const out: { key: string; text: string }[] = [];
    const tag = "منبع: Open-Meteo (جایگزین موقت — هشدار رسمی نیست)";
    for (let li = 0; li < locs.length; li++) {
      const loc = OM_LOCS[li] ?? { name: `نقطه ${li + 1}` };
      const h = locs[li]?.hourly;
      if (!h?.time) continue;
      const times: string[] = h.time;
      let start = times.findIndex((s: string) => s.slice(0, 13) >= cur);
      if (start < 0) start = 0;
      const sum = (arr: number[], n: number) => arr.slice(start, start + n).reduce((a, b) => a + (Number(b) || 0), 0);
      const onset = (idx: number) => times[start + idx]?.slice(11, 16) ?? "";
      const first6 = times[start]?.slice(0, 13) ?? "";
      // wind gusts (next 6h)
      const gusts = (h.wind_gusts_10m ?? []).slice(start, start + 6);
      const gi = gusts.findIndex((v: number) => Number(v) >= OM_GUST_KMH);
      if (gi >= 0) {
        out.push({ key: `${loc.name}:wind:${times[start + gi]?.slice(0, 13)}`, text: `<b>⚠️ هشدار هواشناسی — پیش‌بینی</b>\n${loc.name}: تندباد شدید، تا ${Math.round(Number(gusts[gi]))} کیلومتر بر ساعت، از ساعت ${onset(gi)}\n${tag}` });
      }
      // rain (next 6h or 24h)
      const rain6 = sum(h.precipitation ?? [], 6);
      const rain24 = sum(h.precipitation ?? [], 24);
      if (rain6 >= OM_RAIN_6H_MM || rain24 >= OM_RAIN_24H_MM) {
        const amt = rain6 >= OM_RAIN_6H_MM ? `${Math.round(rain6)} میلی‌متر در ۶ ساعت` : `${Math.round(rain24)} میلی‌متر در ۲۴ ساعت`;
        out.push({ key: `${loc.name}:rain:${first6}`, text: `<b>⚠️ هشدار هواشناسی — پیش‌بینی</b>\n${loc.name}: بارش سنگین، ${amt}\n${tag}` });
      }
      // hail thunderstorm (next 6h)
      const codes = (h.weather_code ?? []).slice(start, start + 6);
      const hi = codes.findIndex((c: number) => c === 96 || c === 99);
      if (hi >= 0) {
        out.push({ key: `${loc.name}:hail:${times[start + hi]?.slice(0, 13)}`, text: `<b>⚠️ هشدار هواشناسی — پیش‌بینی</b>\n${loc.name}: رگبار تگرگ، از ساعت ${onset(hi)}\n${tag}` });
      }
      // snow (next 12h)
      const snow12 = sum(h.snowfall ?? [], 12);
      if (snow12 >= OM_SNOW_12H_CM) {
        out.push({ key: `${loc.name}:snow:${first6}`, text: `<b>⚠️ هشدار هواشناسی — پیش‌بینی</b>\n${loc.name}: برف سنگین، ${Math.round(snow12)} سانتی‌متر در ۱۲ ساعت\n${tag}` });
      }
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

//   - MahsaAlert: public, unauthenticated REST feed
//     (api.mahsaalert.app/api/v1/features/feed — their own client polls it
//     every 30s; rate limit 800/min). Scope (Hamed, 2026-11-09): all of
//     Iran, layers 32 (حملات), 13 (حملات - ج۱۲روزه), 14 (هشدار تخلیه -
//     ج۱۲روزه), 42 (گزارش میدانی) only, ANY verification tag — the tag is
//     always shown in the message, never hidden. Detail per fresh item gives the Persian
//     description (info is a JSON string), city/province, coordinates.

// ---------------------------------------------------------------- mahsaalert
// Emoji per severity: 🚨 attacks / evacuation, 📍 field reports (the bulk)
// — so 🚨 keeps its urgency and the channel stays scannable at a glance.
const MAHSA_LAYERS: Record<number, { title: string; emoji: string }> = {
  32: { title: "حملات", emoji: "🚨" },
  13: { title: "حملات - ج۱۲روزه", emoji: "🚨" },
  14: { title: "هشدار تخلیه - ج۱۲روزه", emoji: "🚨" },
  42: { title: "گزارش میدانی", emoji: "📍" },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function tagFa(tag: string | null | undefined): string {
  if (tag === "verified") return "تأییدشده";
  if (tag === "not-verified") return "تأییدنشده";
  return tag ? esc(tag) : "نامشخص";
}

async function fetchMahsaAlerts(): Promise<{ key: string; text: string }[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch("https://api.mahsaalert.app/api/v1/features/feed?limit=50", {
      headers: { "user-agent": "pulsar-market/1.0" }, signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`mahsa feed HTTP ${r.status}`);
    const j = await r.json();
    const items = (j?.data ?? []).filter((it: any) => MAHSA_LAYERS[it?.layerId]);
    if (items.length === 0) return [];
    // Skip what we already published before fetching details.
    const recent = await rest(`alerts_published?select=event_key&limit=1000`);
    const done = new Set<string>((recent ?? []).map((x: any) => x.event_key));
    const fresh = items.filter((it: any) => !done.has(`mahsa:${it.id}`));
    const out: { key: string; text: string }[] = [];
    for (const it of fresh) {
      try {
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 10000);
        let det: any;
        try {
          const r2 = await fetch(`https://api.mahsaalert.app/api/v1/features/${it.id}`, {
            headers: { "user-agent": "pulsar-market/1.0" }, signal: c2.signal,
          });
          if (!r2.ok) throw new Error(`mahsa detail HTTP ${r2.status}`);
          det = await r2.json();
        } finally {
          clearTimeout(t2);
        }
        if (det?.status && det.status !== "active") continue;
        let info: any = {};
        try { info = JSON.parse(det?.info ?? "{}"); } catch (_) { info = {}; }
        const desc = String(info.description ?? "").trim().slice(0, 800);
        const city = String(info.city ?? it.city ?? "").trim();
        const prov = String(info.province ?? it.province ?? "").trim();
        const layer = MAHSA_LAYERS[det?.layerId ?? it.layerId] ?? { title: "هشدار", emoji: "⚠️" };
        const where = [city, prov].filter(Boolean).join("، ");
        out.push({
          key: `mahsa:${it.id}`,
          text: `<b>${layer.emoji} ${esc(layer.title)}</b>${where ? `\n${esc(where)}` : ""}${desc ? `\n${esc(desc)}` : ""}\nوضعیت تأیید: ${tagFa(det?.verificationTag)} | منبع: MahsaAlert`,
        });
      } catch (_) { /* one bad detail must not kill the rest */ }
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- main
Deno.serve(async (req) => {
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const posted: { key: string; kind: string; text: string }[] = [];
  const errors: string[] = [];
  const sources: Record<string, string> = {};

  const minMag = Number(Deno.env.get("ALERTS_EQ_MIN_MAG") ?? "4.5");

  // irimo backoff: while irimo is down, every run waited out its 15s timeout
  // for nothing (288 wasted waits a day). After 3 failures in a row, check
  // it at most once an hour; Open-Meteo covers the gap meanwhile. A success
  // resets the counter. The counter lives in alert_state (irimo:fail).
  let irimoFails = 0;
  let irimoSkip = false;
  try {
    const rows = await rest(`alert_state?symbol=eq.irimo:fail&select=last_price,last_alert_ts`) as any[];
    const r0 = rows?.[0];
    irimoFails = Number(r0?.last_price ?? 0);
    const lastFail = r0?.last_alert_ts ? Date.parse(r0.last_alert_ts) : 0;
    irimoSkip = irimoFails >= 3 && Date.now() - lastFail < 3600 * 1000;
  } catch (_) { /* backoff state unreadable -> check normally */ }
  const wxTask: Promise<{ items: { id: string; level: string; text: string }[]; skipped: boolean }> = irimoSkip
    ? Promise.resolve({ items: [], skipped: true })
    : fetchWeatherWarnings().then((items) => ({ items, skipped: false }));

  const [quakeRes, wxRes, mahsaRes] = await Promise.allSettled([fetchQuakes(minMag), wxTask, fetchMahsaAlerts()]);

  // 1) build candidate alerts — quake + weather + mahsa in parallel, so a
  // slow irimo never delays the earthquake check.
  type Cand = { key: string; kind: string; text: string };
  const cands: Cand[] = [];
  if (quakeRes.status === "fulfilled") {
    sources.quake = "ok";
    for (const f of quakeRes.value) {
      const mag = Number(f.properties?.mag ?? 0);
      if (!inScope(f.geometry?.coordinates ?? []) || mag < minMag) continue;
      const place = String(f.properties?.place ?? "ایران");
      const when = f.properties?.time ? tehranTime(Number(f.properties.time)) : "";
      const depth = Math.round(Number(f.geometry?.coordinates?.[2]) || 0);
      cands.push({
        key: `quake:${f.id}`,
        kind: "earthquake",
        text: `<b>🚨 زلزله M${mag}</b>\n📍 ${esc(placeFa(place))}\nعمق ${faNum(depth)} کیلومتر${when ? ` | ساعت ${faNum(when)}` : ""}\nمنبع: USGS`,
      });
    }
  } else {
    sources.quake = "error";
    errors.push(`quake: ${quakeRes.reason?.message ?? quakeRes.reason}`);
  }
  if (wxRes.status === "fulfilled" && !wxRes.value.skipped) {
    sources.weather = "ok";
    if (irimoFails > 0) {
      // irimo is back: clear the failure counter (fire-and-forget).
      await rest(`alert_state?on_conflict=symbol`, {
        method: "POST",
        body: JSON.stringify({ symbol: "irimo:fail", last_price: 0 }),
        headers: { Prefer: "resolution=merge-duplicates" },
      }).catch(() => null);
    }
    for (const w of wxRes.value.items) cands.push({ key: `wx:${w.id}`, kind: "weather", text: w.text });
  } else {
    if (wxRes.status === "rejected") {
      // irimo failed again: bump the consecutive-failure counter.
      await rest(`alert_state?on_conflict=symbol`, {
        method: "POST",
        body: JSON.stringify({ symbol: "irimo:fail", last_price: irimoFails + 1, last_alert_ts: new Date().toISOString() }),
        headers: { Prefer: "resolution=merge-duplicates" },
      }).catch(() => null);
    }
    // irimo down (or in backoff) -> Open-Meteo forecast fallback (temporary, labelled).
    try {
      const om = await fetchOpenMeteoAlerts();
      sources.weather = "fallback";
      for (const w of om) cands.push({ key: `wxom:${w.key}`, kind: "weather-forecast", text: w.text });
    } catch (e: any) {
      sources.weather = "error";
      const irimoErr = wxRes.status === "rejected" ? `irimo: ${wxRes.reason?.message ?? wxRes.reason}; ` : "";
      errors.push(`weather: ${irimoErr}open-meteo: ${e?.message ?? e}`);
    }
  }

  if (mahsaRes.status === "fulfilled") {
    sources.mahsa = "ok";
    for (const w of mahsaRes.value) cands.push({ key: w.key, kind: "mahsa", text: w.text });
  } else {
    sources.mahsa = "error";
    errors.push(`mahsa: ${mahsaRes.reason?.message ?? mahsaRes.reason}`);
  }

  // 2) dedup against what we've already published
  const recent = await rest(`alerts_published?select=event_key&limit=1000`);
  const done = new Set<string>((recent ?? []).map((x: any) => x.event_key));
  const fresh = cands.filter((c) => !done.has(c.key));

  // 3) post immediately (or, in dry mode, just report)
  for (const item of fresh) {
    if (dry) { posted.push({ ...item, text: `[DRY] ${item.text}` }); continue; }
    const r = await sendTG(TG_CHAT, item.text);
    if (r.ok) {
      posted.push(item);
      await rest(`alerts_published`, {
        method: "POST",
        body: JSON.stringify({ event_key: item.key, kind: item.kind, payload: { text: item.text } }),
      });
    } else {
      errors.push(`post ${item.key}: ${JSON.stringify(r)}`);
    }
  }

  // 4) source failures get a throttled private notice (never silent).
  if (!dry) {
    if (sources.quake === "error") await noteSourceDown("quake", errors.find((e) => e.startsWith("quake:")) ?? "USGS unreachable");
    if (sources.weather === "error") await noteSourceDown("weather", errors.find((e) => e.startsWith("weather:")) ?? "irimo unreachable");
    if (sources.mahsa === "error") await noteSourceDown("mahsa", errors.find((e) => e.startsWith("mahsa:")) ?? "mahsa feed unreachable");
  }

  return new Response(
    JSON.stringify({ ok: true, dry, would_post: posted.length, posted: posted.length, candidates: cands.length, already: done.size, sources, errors }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
