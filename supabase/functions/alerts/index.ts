// پالس بازار · alerts — monitors hazard sources and posts significant events
// (earthquakes + strong weather warnings) to the market Telegram channel,
// deduplicated, IMMEDIATELY when they appear — never batched with the
// 15-minute price digest (an alert 15 minutes late is a joke).
//
// Sources (all free, no key):
//   - Earthquake: USGS FDSN feed (global, structured, reachable). IRNO is the
//     official Iranian feed but is SNI-blocked here; USGS is the reliable proxy.
//   - Weather: IRIMETS (irimo.ir) "هشدار هواشناسی" red/orange warnings.
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
async function fetchQuakes(): Promise<any[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(
      "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=4.0&limit=100",
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

// ---------------------------------------------------------------- main
Deno.serve(async (req) => {
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const posted: { key: string; kind: string; text: string }[] = [];
  const errors: string[] = [];
  const sources: Record<string, string> = {};

  const minMag = Number(Deno.env.get("ALERTS_EQ_MIN_MAG") ?? "4.5");

  // 1) build candidate alerts — quake + weather in parallel, so a slow irimo
  // never delays the earthquake check.
  type Cand = { key: string; kind: string; text: string };
  const cands: Cand[] = [];

  const [quakeRes, wxRes] = await Promise.allSettled([fetchQuakes(), fetchWeatherWarnings()]);
  if (quakeRes.status === "fulfilled") {
    sources.quake = "ok";
    for (const f of quakeRes.value) {
      const mag = Number(f.properties?.mag ?? 0);
      if (!inScope(f.geometry?.coordinates ?? []) || mag < minMag) continue;
      const place = String(f.properties?.place ?? "ایران");
      const when = f.properties?.time ? tehranTime(Number(f.properties.time)) : "";
      cands.push({
        key: `quake:${f.id}`,
        kind: "earthquake",
        text: `<b>🚨 زلزله</b>\nقدرت: M${mag}\nمحل: ${place}${when ? `\nساعت: ${when}` : ""}\nعمق: ${Math.round(Number(f.geometry?.coordinates?.[2]) || 0)} کیلومتر`,
      });
    }
  } else {
    sources.quake = "error";
    errors.push(`quake: ${quakeRes.reason?.message ?? quakeRes.reason}`);
  }
  if (wxRes.status === "fulfilled") {
    sources.weather = "ok";
    for (const w of wxRes.value) cands.push({ key: `wx:${w.id}`, kind: "weather", text: w.text });
  } else {
    sources.weather = "error";
    errors.push(`weather: ${wxRes.reason?.message ?? wxRes.reason}`);
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
  }

  return new Response(
    JSON.stringify({ ok: true, dry, would_post: posted.length, posted: posted.length, candidates: cands.length, already: done.size, sources, errors }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
