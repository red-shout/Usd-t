# 📊 پالس بازار — سیستمِ زنده (Source of Truth)

این مخزن **منبعِ اصلی**ِ پروژهٔ «پالس بازار» است. منطقِ زنده روی **Supabase** اجرا می‌شود؛ این فایل‌ها همان کدی است که روی Supabase deploy شده و هر «آپدیت» از همینجا commit و deploy می‌شود.

## چرخهٔ کار
1. **منطق در Edge Function است** (`supabase/functions/`): `ingest` (اسکراپ + ذخیره + تلگرام + push داده) و `web` (داشبورد + API).
2. **هر ۱۵ دقیقه** `pg_cron → pg_net` → `ingest` را صدا می‌زند (cron jobid=1 روی Supabase).
3. `ingest` در هر چرخه:
   - قیمت‌ها را از `alanchand.com` + `oilprice.com` می‌کِشد و در Postgres (`market`/`rate_history`/`alert_state`) ذخیره می‌کند.
   - یک **اعلان تلگرامِ دوره‌ای** می‌فرستد (`@USDTIRTLIVE`) + فلگِ نوسانِ ۲ ساعته.
   - فایل `data.json` را به branch **`live`** همین ریپو push می‌کند تا آینهٔ **GitHub Pages** زنده بماند (`GH_BRANCH=live`, `GH_DATA_PATH=data.json` — مشاهده‌شده، نه حدس).
4. **لینک‌ها:**
   - زنده/سراسری: `https://<ref>.supabase.co/functions/v1/<slug_web>` (روی دستگاهی که `supabase.co` فلتر است، رست SNI می‌شود).
   - **موبایل‌پسند (GitHub Pages):** `https://red-shout.github.io/Usd-t/` — سروِ legacy build از branch **`live`**، ریشهٔ `/`؛ صفحهٔ `index.html` همان branch داده را از `./data.json` می‌خواند.

## بستهٔ اطمینان (۲۰۲۶-۱۱-۰۹)
سه لایه که جلوی تکرارِ خطاهای ۹ نوامبر (دلارِ ۷۲٬۳۳۰ به‌جای ۲۶۵٬۰۰۰؛ push ساکتِ آینه) را می‌گیرد:

1. **گاردریل قیمت در `ingest`** (قبل از ذخیره در DB): هر مقدارِ تازه باید (۱) نسبت به چرخهٔ قبل جهشِ ناممکن نداشته باشد (حدها در `MOVE_LIMIT`، عامدانه گشاده: ارزها ۸٪، طلای ۱۸ عیار/مثقال ۶٪، انس طلا ۳٪، نفت ۸٪ در ۱۵ دقیقه) و (۲) با قیمت‌های هم‌خانواده سازگار باشد: دلار ≈ درهم × ۳٫۶۷۲۵ (۲٪)، ۱۸ عیار ≈ انس × دلار ÷ ۳۱٫۱۰۳۵ × ۰٫۷۵ (باند ۰٫۹۰–۱٫۰۸). مقدارِ ردشده با مقدارِ قبلیِ خوب جایگزین می‌شود و دلیلش در `rejected` و `errors` می‌رود. توجه: مثقال = ۱۸ عیار × ۴٫۶۰۸ در دادهٔ منتشرشده برقرار نیست — قیمتِ ۱۸ عیارِ خرده‌فروشی شامل اجرت است و ~۶٪ بالاتر از مثقال ÷ ۴٫۶۰۸ است؛ پس چنین چکی ندارد (اولین تستِ زنده همین را نشان داد و چکِ اشتباه همان روز حذف شد).
2. **هشدار خرابی به تلگرامِ حامد** (نه کانالِ عمومی): اگر در چرخه‌ای خطایی باشد (اسکرِیپ، گاردریل، یا push گیت‌هاب ناموفق)، یک پیام هشدار به چتِ خصوصی می‌رود. سکرت: `TELEGRAM_ALERT_CHAT_ID` = آیدیِ عددیِ تلگرامِ حامد (از ربات `@userinfobot` گرفته می‌شود). یک مشکلِ تکراری حداکثر هر ۲ ساعت یک بار هشدار می‌دهد (امضایش در `alert_state` با نماد `health` ذخیره می‌شود). اگر سکرت تنظیم نشده باشد، هشدار فقط در پاسخِ JSON و `errors` می‌ماند.
3. **Pages فقط از branch `live`:** ورک‌فلوی `.github/workflows/static.yml` **حذف شد** — هر push به `main` آن را اجرا می‌کرد و محتوای main (بدون `data.json` در ریشه) را روی سایت می‌نشاند تا push بعدی به `live` درستش کند. هرگز یک deploy اکشنِ Pages اضافه نکن؛ سایت فقط با legacy build از branch `live` سرو می‌شود.

## deploy دستی (از طریقِ agent)
```
python3 supabase/deploy.py web ingest   # deploy + وصل‌کردنِ cron به slugِ جدید
```
سیکریت‌های لازم روی Supabase ذخیره‌اند: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALERT_CHAT_ID` (آیدی عددی حامد), `GITHUB_TOKEN`, `GITHUB_REPO=red-shout/Usd-t`, `GH_BRANCH=live`, `GH_DATA_PATH=data.json`.

## ساختار
```
supabase/functions/ingest/index.ts   # اسکراپ + گاردریل + DB + تلگرام + push داده
supabase/functions/web/index.ts      # داشبورد HTML + ?format=json
supabase/schema.sql                 # جداول
supabase/deploy.py                  # deploy + rewire cron (چرخه ۱۵ دقیقه)
supabase/project.ref                # ref پروژهٔ Supabase
web/index.html                      # کپیِ داشبوردِ فانکشنِ web (روی Pages سرو نمی‌شود)
web/data.json                       # قدیمی و بلااستفاده (آخرین به‌روز ۷ اکتبر ۲۰۲۶) — آینهٔ زنده data.json در ریشهٔ branch live است
```

> نکته: `data.json` در branch `live` را **دستی ویرایش نکن**؛ هر ۱۵ دقیقه توسط `ingest` بازنویسی می‌شود.
> فایل‌های قدیمی (`fetch_rates.py`, `market.json`, `.github/`, `web/data.json`) مرجعِ اولیه بودند و دیگر در چرخهٔ زنده استفاده نمی‌شوند.
> اعتماد به منابع (گفتهٔ حامد): tgju وب‌سایت اتحادیه/دولتی است و گاهی قیمت‌ها را دستکاری می‌کند؛ «الان چند» وب‌سایت آزاد است و قیمت‌ها را از منبع‌های مختلف چک می‌کند و یک قیمت واحد اعلام می‌کند — پس الان چند مرجع اصلی است و tgju فقط برای نقرهٔ ۹۲۵ استفاده می‌شود (تک‌منبع، نقطهٔ ضعف).
