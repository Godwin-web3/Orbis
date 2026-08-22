-- Storage for the webhook/serverless deployment of the Orbis Telegram bot
-- (worker/index.ts). Mirrors the local JSONL stores used by the always-on
-- long-polling bot (scripts/telegram-bot.ts) one-for-one. Apply with the
-- Supabase CLI (`supabase db push`) or paste into the SQL editor.
--
-- Access model: only the service_role key touches these tables (from the
-- Worker backend). RLS is enabled with no policies, i.e. default-deny for
-- the publishable/anon key.

-- Registered receive addresses (latest wins per Telegram chat)
create table public.users (
  user_id text primary key,
  address text not null,
  registered_at timestamptz not null default now()
);
alter table public.users enable row level security;

-- Encrypted per-user burner keys for autonomous auto-mint (AES-256-GCM ciphertext only; never plaintext)
create table public.automint_keys (
  user_id text primary key,
  address text not null,
  enc_iv text not null,
  enc_data text not null,
  auto_mint_enabled boolean not null default false,
  removed boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.automint_keys enable row level security;

-- At-most-once ledger of (user, opportunity) auto-mint attempts
create table public.automint_log (
  id bigserial primary key,
  user_id text not null,
  tx_key text not null,
  status text not null check (status in ('success', 'failed', 'error')),
  tx_hash text,
  error text,
  at timestamptz not null default now(),
  unique (user_id, tx_key)
);
alter table public.automint_log enable row level security;

-- Policy-approved mints ready to broadcast; bigint-valued fields stored as text to avoid
-- JSON-number precision loss on large wei amounts (PostgREST serializes numeric as JSON number)
create table public.prepared_transactions (
  id bigserial primary key,
  chain_key text not null,
  chain_id integer not null,
  to_address text not null,
  data text not null,
  value text not null,
  from_address text,
  gas text not null,
  gas_price_wei text not null,
  simulation_mode text not null,
  policy text not null check (policy in ('PASS', 'REJECT', 'SKIP')),
  reasons jsonb not null default '[]'::jsonb,
  prepared_at timestamptz not null,
  candidate_id text,
  mint_function text,
  abi jsonb,
  unique (chain_id, to_address, data)
);
alter table public.prepared_transactions enable row level security;

-- Discovered mint candidates, keyed by candidate id
create table public.candidates (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.candidates enable row level security;

-- Small generic key/value store (currently just the live-execution guard flag)
create table public.kv_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.kv_state enable row level security;
