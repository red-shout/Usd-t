<div dir="rtl" align="center">

# 📊 پالس بازار

قیمتِ لحظه‌ایِ ارز، طلا، سکه، نقره و نفت + اعلانِ تلگرامی، هر ۳۰ دقیقه.

<br/>

</div>

<div dir="rtl">

## دسترسی زنده
- **داشبورد وب (موبایل‌پسند):** `https://red-shout.github.io/Usd-t/`
- **API خام:** `.../functions/v1/<slug>?format=json&symbol=usd&hours=4320` (روی Supabase)

## چرخه
- هر ۳۰ دقیقه (pg_cron) → اسکراپِ قیمت‌ها → ذخیره در Postgres → اعلان تلگرامی + refreshِ داده‌ی وب.
- **منبعِ داده‌ها:** [alanchand.com](https://alanchand.com) (دلار/یورو/طلا/سکه/نقره) و [oilprice.com](https://oilprice.com) (نفت برنت).

## شاخص‌ها
دلار، یورو، طلای ۱۸ع، مثقال، انس طلا، **انس نقره، نقره (هر گرم)**، سکه (امامی/بهار/نیم/ربع/گرمی)، نفت برنت.
> «نقره (هر گرم)» محاسبه‌شده است: `انس × دلار(تومان) ÷ ۳۱٫۱۰۳`.

## ساختارِ مخزن (منبعِ اصلیِ سیستمِ زنده)
```
supabase/functions/ingest/index.ts   # اسکراپ + DB + تلگرام + push داده
supabase/functions/web/index.ts       # داشبورد + API
supabase/schema.sql · deploy.py · project.ref · sync_repo.py
web/index.html · web/data.json       # آینهٔ GitHub Pages (داده فقط توسط ingest)
LIVE.md                              # مستندِ کامل
```

</div>
