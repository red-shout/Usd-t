# 📊 پالس بازار — سیستمِ زنده (Source of Truth)

این مخزن **منبعِ اصلی**ِ پروژهٔ «پالس بازار» است. منطقِ زنده روی **Supabase** اجرا می‌شود؛ این فایل‌ها همان کدی است که روی Supabase deploy شده و هر «آپدیت» از همینجا commit و deploy می‌شود.

## چرخهٔ کار
1. **منطق در Edge Function است** (`supabase/functions/`): `ingest` (اسکراپ + ذخیره + تلگرام + push داده) و `web` (داشبورد + API).
2. **هر ۳۰ دقیقه** `pg_cron → pg_net` → `ingest` را صدا می‌زند (cron jobid=1 روی Supabase).
3. `ingest` در هر چرخه:
   - قیمت‌ها را از `alanchand.com` + `oilprice.com` می‌کِشد و در Postgres (`market`/`rate_history`/`alert_state`) ذخیره می‌کند.
   - یک **اعلان تلگرامِ دوره‌ای** می‌فرستد (`@USDTIRTLIVE`) + فلگِ نوسانِ ۲ ساعته.
   - فایل `web/data.json` را به همین ریپو push می‌کند تا آینهٔ **GitHub Pages** زنده بماند.
4. **لینک‌ها:**
   - زنده/سراسری: `https://<ref>.supabase.co/functions/v1/<slug_web>` (روی دستگاهی که `supabase.co` فلتر است، رست SNI می‌شود).
   - **موبایل‌پسند (GitHub Pages):** `https://red-shout.github.io/Usd-t/` (سروِ `web/` از branch `main`، folder `/web`).

## deploy دستی (از طریقِ agent)
```
python3 supabase/deploy.py web ingest   # deploy + وصل‌کردنِ cron به slugِ جدید
```
سیکریت‌های لازم روی Supabase ذخیره‌اند: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GITHUB_TOKEN`, `GITHUB_REPO=red-shout/Usd-t`, `GH_DATA_PATH=web/data.json`.

## ساختار
```
supabase/functions/ingest/index.ts   # اسکراپ + DB + تلگرام + push داده
supabase/functions/web/index.ts      # داشبورد HTML + ?format=json
supabase/schema.sql                 # جداول
supabase/deploy.py                  # deploy + rewire cron
supabase/project.ref                # ref پروژهٔ Supabase
web/index.html                      # داشبوردِ GitHub Pages (داده از data.json)
web/data.json                       # دادهٔ زنده (هر ۳۰ دقیقه به‌روز — فقط توسط ingest)
```

> نکته: `web/data.json` را **دستی ویرایش نکن**؛ هر ۳۰ دقیقه توسط `ingest` بازنویسی می‌شود.
> فایل‌های قدیمی (`fetch_rates.py`, `market.json`, `.github/`) مرجعِ اولیه بودند و دیگر در چرخهٔ زنده استفاده نمی‌شوند.
