-- پالس بازار · schema
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.market (
  id           int primary key default 1 check (id = 1),
  usd          bigint,
  eur          bigint,
  aed          bigint,
  gold_18k     bigint,
  gold_mesghal bigint,
  gold_ounce   numeric,
  silver_ounce numeric,
  silver_gram  bigint,
  coin_emami   bigint,
  coin_bahar   bigint,
  coin_half    bigint,
  coin_quarter bigint,
  coin_gram    bigint,
  oil          numeric,
  updated_at   timestamptz not null default now(),
  payload      jsonb not null default '{}'::jsonb
);

create table if not exists public.rate_history (
  id     bigserial primary key,
  symbol text   not null,
  price  numeric not null,
  ts     timestamptz not null default now()
);
create index if not exists rate_history_symbol_ts_idx on public.rate_history (symbol, ts desc);

create table if not exists public.alert_state (
  symbol        text primary key,
  last_price    numeric,
  last_alert_ts timestamptz
);

insert into public.market (id) values (1) on conflict (id) do nothing;
