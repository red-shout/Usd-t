// پالس بازار · web — dashboard HTML + ?format=json read API, one function.
const URL_ = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest<T = any>(path: string): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`REST ${r.status} ${await r.text()}`);
  return r.json() as T;
}
const FA_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const FA = (s: string) => s.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
function toJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = 0, y = gy;
  if (gy > 1600) { jy = 979; y -= 1600; } else y -= 621;
  const gy2 = gm > 2 ? y : y - 1;
  let days = 365 * y + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) - 80 + gd + gdm[gm - 1];
  jy += 33 * Math.floor(days / 12053); days %= 12053;
  jy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  return days < 186 ? [jy, 1 + Math.floor(days / 31), 1 + (days % 31)]
    : [jy, 7 + Math.floor((days - 186) / 30), 1 + ((days - 186) % 30)];
}

async function serveApi(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const symbol = u.searchParams.get("symbol") ?? "usd";
  const hours = Number(u.searchParams.get("hours") ?? 24 * 90);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const [market, history] = await Promise.all([
    rest("market?id=eq.1&select=*"),
    rest(`rate_history?symbol=eq.${symbol}&ts=gte.${since}&select=ts,price&order=ts.asc&limit=5000`),
  ]);
  const m: any = market[0] ?? {};
  let shamsi = (m.payload ?? {}).date_shamsi ?? "";
  if (!shamsi && m.updated_at) {
    const teh = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(m.updated_at));
    const [gy, gm, gd] = teh.split("-").map(Number);
    const [jy, jm, jd] = toJalali(gy, gm, gd);
    shamsi = `${FA(jd)} ${FA_MONTHS[jm - 1]} ${FA(jy)}`;
  }
  const prices = history.map((h: any) => Number(h.price));
  const change = prices.length > 1 ? ((prices.at(-1)! - prices[0]) / prices[0]) * 100 : 0;
  return new Response(JSON.stringify({
    symbol, updated_at: m.updated_at, date_shamsi: shamsi,
    market: {
      usd: m.usd, eur: m.eur, gold_18k: m.gold_18k, gold_mesghal: m.gold_mesghal,
      gold_ounce: m.gold_ounce, silver_ounce: m.silver_ounce, silver_gram: m.silver_gram, coin_emami: m.coin_emami, coin_bahar: m.coin_bahar,
      coin_half: m.coin_half, coin_quarter: m.coin_quarter, coin_gram: m.coin_gram, oil: m.oil,
    },
    latest: prices.at(-1) ?? null,
    change_pct: Number(change.toFixed(2)),
    history,
  }), { headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
}

const HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>پالس بازار</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css"/>
<style>
  :root{--bg:#0b1120;--card:#131c31;--line:#22304d;--txt:#e8eefc;--dim:#8fa3c8;--up:#f87171;--down:#34d399;--acc:#60a5fa}
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#0b1120,#0f172a 40%);color:var(--txt);font-family:Vazirmatn,system-ui,sans-serif;min-height:100vh;padding:20px 14px 40px}
  header{max-width:980px;margin:0 auto 18px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  h1{font-size:22px;margin:0;font-weight:800}
  .meta{color:var(--dim);font-size:13px}
  .live{margin-inline-start:auto;display:flex;align-items:center;gap:7px;color:var(--dim);font-size:12px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--dim)}
  .dot.on{background:#34d399;box-shadow:0 0 0 4px #34d39922;animation:p 2s infinite}
  @keyframes p{50%{opacity:.35}}
  main{max-width:980px;margin:0 auto}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;position:relative;overflow:hidden}
  .card::after{content:"";position:absolute;inset-inline-start:0;top:0;bottom:0;width:3px;background:var(--acc);opacity:.55}
  .card .lbl{color:var(--dim);font-size:12.5px;margin-bottom:7px}
  .card .val{font-size:20px;font-weight:700}
  .card .chg{font-size:12px;margin-top:5px;color:var(--dim)}
  .up{color:var(--up)}.down{color:var(--down)}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .panel h2{font-size:15px;margin:0 0 4px;font-weight:700}
  .panel .sub{color:var(--dim);font-size:12px;margin-bottom:12px}
  svg{width:100%;height:230px;display:block}
  .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  .tab{background:#18233d;border:1px solid var(--line);color:var(--dim);border-radius:9px;padding:6px 13px;font:inherit;font-size:13px;cursor:pointer}
  .tab.on{background:#1d4ed8;border-color:#3b82f6;color:#fff}
  footer{max-width:980px;margin:18px auto 0;color:#55688c;font-size:11.5px;text-align:center;line-height:1.9}
  code{background:#18233d;padding:1px 6px;border-radius:5px;font-size:11px;direction:ltr;display:inline-block}
</style>
</head>
<body>
<header>
  <h1>📊 پالس بازار</h1>
  <span class="meta" id="stamp">—</span>
  <span class="live"><span class="dot" id="dot"></span><span id="liveTxt">در حال اتصال…</span></span>
</header>
<main>
  <div class="grid" id="grid"></div>
  <div class="panel">
    <h2>روند <span id="chartName">دلار آمریکا</span></h2>
    <div class="sub" id="chartSub">در حال بارگذاری…</div>
    <div class="tabs" id="tabs"></div>
    <div id="chartWrap"></div>
  </div>
</main>
<footer>داده‌ها هر ۳۰ دقیقه به‌روزرسانی می‌شود · API: <code>?format=json&amp;symbol=usd&amp;hours=2160</code></footer>
<script>
const FA=s=>String(s).replace(/\\d/g,d=>"۰۱۲۳۴۵۶۷۸۹"[d]);
const NF=n=>FA(Math.round(n).toLocaleString("en-US"));
const CARDS=[["usd","🇺🇸","دلار آمریکا","toman"],["eur","🇪🇺","یورو اروپا","toman"],
["gold_18k","✨","طلای ۱۸ عیار","toman"],["gold_mesghal","⚖️","مثقال طلا","toman"],
["gold_ounce","🌐","انس جهانی طلا","usd"],["silver_ounce","🥈","انس جهانی نقره","usd"],["silver_gram","🥈","نقرهٔ ۹۲۵ (هر گرم)","toman"],["coin_emami","🟡","سکه امامی","toman"],
["coin_bahar","🟡","سکه بهار آزادی","toman"],["coin_half","🟡","نیم‌سکه","toman"],
["coin_quarter","🟡","ربع‌سکه","toman"],["coin_gram","🟡","سکه گرمی","toman"],
["oil","⛽","نفت برنت","usd"]];
const CHARTABLE=["usd","eur","gold_18k","coin_emami","gold_ounce","silver_ounce","silver_gram","oil"];
let cur="usd",last=null;
function pct(d){const p=(d.history||[]).map(h=>Number(h.price));return p.length>1?((p.at(-1)-p[0])/p[0])*100:0}
function drawGrid(){
  if(!last)return;
  document.getElementById("grid").innerHTML=CARDS.map(([k,ico,lbl,unit])=>{
    const v=last.market[k];
    const shown=v==null?"—":(unit==="toman"?NF(v)+" <small style='font-size:12px;color:#8fa3c8'>تومان</small>":FA(v)+" <small style='font-size:12px;color:#8fa3c8'>دلار</small>");
    const chg=k===cur?pct(last):null;
    return \`<div class="card"><div class="lbl">\${ico} \${lbl}</div><div class="val">\${shown}</div>\${chg===null?"":\`<div class="chg \${chg>=0?"up":"down"}">\${chg>=0?"▲":"▼"} \${FA(Math.abs(chg).toFixed(2))}٪</div>\`}</div>\`;
  }).join("");
}
function chart(){
  const h=(last?.history||[]).map(x=>({t:new Date(x.ts),p:Number(x.price)}));
  const w=document.getElementById("chartWrap");
  if(h.length<2){w.innerHTML='<div class="sub">داده کافی برای نمودار وجود ندارد.</div>';return}
  const W=900,H=230,P={t:16,r:14,b:26,l:58};
  const ps=h.map(x=>x.p),min=Math.min(...ps),max=Math.max(...ps);
  const pad=(max-min)*0.12||1,lo=min-pad,hi=max+pad;
  const X=i=>P.l+(W-P.l-P.r)*(i/(h.length-1));
  const Y=p=>P.t+(H-P.t-P.b)*(1-(p-lo)/(hi-lo));
  const line=h.map((x,i)=>\`\${i?"L":"M"}\${X(i).toFixed(1)},\${Y(x.p).toFixed(1)}\`).join(" ");
  const area=\`\${line} L\${X(h.length-1).toFixed(1)},\${H-P.b} L\${X(0).toFixed(1)},\${H-P.b} Z\`;
  let grid="";
  for(let i=0;i<=4;i++){const v=lo+(hi-lo)*i/4,y=Y(v);
    grid+=\`<line x1="\${P.l}" y1="\${y.toFixed(1)}" x2="\${W-P.r}" y2="\${y.toFixed(1)}" stroke="#22304d" stroke-dasharray="4 5"/>
    <text x="\${W-P.r+2}" y="\${(y+4).toFixed(1)}" fill="#6f83a8" font-size="10" text-anchor="start">\${FA(Math.round(v).toLocaleString("en-US"))}</text>\`;}
  const lbl=h.map((x,i)=>{
    if(i%(Math.ceil(h.length/6))!==0&&i!==h.length-1)return"";
    const d=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tehran",month:"2-digit",day:"2-digit"}).format(x.t);
    return \`<text x="\${X(i).toFixed(1)}" y="\${H-8}" fill="#6f83a8" font-size="10" text-anchor="middle">\${d}</text>\`;
  }).join(" ");
  const li=h.length-1;
  document.getElementById("chartSub").textContent=\`\${h.length} نقطه · کمینه \${NF(min)} · بیشینه \${NF(max)} · تغییر کل \${FA(Math.abs(pct(last)).toFixed(2))}٪\`;
  w.innerHTML=\`<svg viewBox="0 0 \${W} \${H}" preserveAspectRatio="none">\${grid}
  <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity=".38"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>
  <path d="\${area}" fill="url(#g)"/>
  <path d="\${line}" fill="none" stroke="#60a5fa" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="\${X(li).toFixed(1)}" cy="\${Y(ps.at(-1)).toFixed(1)}" r="4.5" fill="#1d4ed8" stroke="#93c5fd" stroke-width="2"/>
  \${lbl}</svg>\`;
}
async function load(){
  try{
    const r=await fetch("./?format=json&symbol="+cur+"&hours=2160");
    if(!r.ok)throw new Error("HTTP "+r.status);
    last=await r.json();
    document.getElementById("stamp").textContent="آخرین بروزرسانی: "+(last.date_shamsi||"")+" — "+FA((last.updated_at||"").slice(11,16));
    document.getElementById("dot").classList.add("on");
    document.getElementById("liveTxt").textContent="زنده";
    document.getElementById("chartName").textContent=(CARDS.find(c=>c[0]===cur)||[])[2]||cur;
    drawGrid();chart();
  }catch(e){document.getElementById("liveTxt").textContent="خطا: "+e.message;}
}
document.getElementById("tabs").innerHTML=CHARTABLE.map(s=>\`<button class="tab \${s===cur?"on":""}" data-s="\${s}">\${(CARDS.find(c=>c[0]===s)||[])[2]||s}</button>\`).join("");
document.getElementById("tabs").onclick=e=>{const b=e.target.closest(".tab");if(!b)return;cur=b.dataset.s;[...document.querySelectorAll(".tab")].forEach(t=>t.classList.toggle("on",t===b));load();};
load();setInterval(load,60000);
</script>
</body></html>`;

Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get("format") === "json") return serveApi(req);
  return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
});
