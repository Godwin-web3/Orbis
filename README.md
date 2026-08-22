# Orbis

A modular EVM opportunity engine for discovering, classifying, simulating, ranking, and—only after explicit policy approval—executing NFT free mints. Multi-user Telegram bot: discovery is centralized; execution can be non-custodial (users keep their own wallets) or custodial (fleet relay).

## Safety boundary

The default mode is `dry-run`. Live execution is not wired into the application. Use a dedicated, low-balance wallet for any future execution work; never put a primary wallet key in this project.

The system is architecturally complete while integrations are enabled progressively. Discovery, chain clients, calldata construction, simulation, policy, signing, nonce management, broadcasting, verification, storage, metrics, and notifications are independent adapters.

## Structure

- `config/` chain and policy configuration
- `src/domain/` stable domain contracts
- `src/chains/` chain registry and clients
- `src/discovery/` RPC, contract, marketplace, API, RSS, webhook, and fixture adapters
- `src/core/` classification, opportunity ranking, and time-to-action metrics
- `src/simulation/` fixture and RPC simulation
- `src/execution/` policy, gas, nonce, signer, broadcaster, batch-executor, custodial relay, and non-custodial relay interfaces
- `src/users/` multi-user address registry
- `src/verification/` receipt and ownership verification
- `src/notifications/` Telegram and console adapters
- `src/storage/` persistence interfaces and in-memory implementation
- `src/app/` pipeline orchestration

## Run

```sh
cp .env.example .env
bun run dry-run
CANDIDATE_FILE=fixtures/nasty-cases.jsonl bun run dry-run
ENGINE_MODE=live-readonly ENABLED_CHAINS=base BASE_RPC_URL=https://your-rpc.example bun run dev
bun test
bun run typecheck
TESTNET_CHAIN_KEY=base TESTNET_RPC_URL=https://your-testnet-rpc TESTNET_CONTRACT=0x... TESTNET_FROM=0x... TESTNET_MINT_FUNCTION=mint bun run testnet-probe
```

The fixture path exercises the full pipeline without a wallet or chain. `testnet-probe` is the next safe step for one real testnet contract: it resolves the ABI, checks wallet eligibility, constructs calldata, runs `eth_estimateGas`/`eth_call`/optional tracing, scores policy, and writes a JSON report. It does not sign or broadcast. `live-readonly` uses configured RPC endpoints, discovers configured contracts (or via `DISCOVERY_MODE=blocks`, described below), inspects NFT interfaces, runs read-only simulation, persists candidates/events under `data/`, and never signs or broadcasts. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable alerts. `SIMULATION_FROM` is required for real RPC simulation because state-diff interpretation must be wallet-specific. Configure one or more comma-separated RPC URLs in each chain variable; the simulator rotates to a healthy provider when one fails.

## Real RPC simulation

`RpcSimulator` performs:

1. `eth_estimateGas`
2. `eth_gasPrice`
3. `eth_call`
4. optional `debug_traceCall` with `callTracer` and logs

When tracing is available, it extracts ERC-721/ERC-1155-style NFT transfers, ERC-20 transfers, approvals, approval-for-all calls, and nested external calls. A provider that supports `eth_call` but not tracing is still usable, but the result is marked without a state diff and should not pass a policy that requires proof of an NFT receipt.

The simulator deliberately does not claim that a plain `eth_call` proves post-state. It records the limitation instead. A production deployment should use a fork or a tracing-capable provider for state-diff enforcement and add contract-specific decoding for Merkle proofs, signatures, proxy implementations, quotas, and time/block windows.

## Discovery modes

- `DISCOVERY_MODE=contracts` (default) — only checks the addresses you list in each chain's `*_CONTRACTS` env var.
- `DISCOVERY_MODE=blocks` — auto-discovers mints without a curated list, by watching for **ERC-721 `Transfer` events where `from` is the zero address** (`src/discovery/rpc/block-source.ts`) — that event *is* a mint, emitted by any contract, new or deployed long ago, the moment someone mints from it. A single `eth_getLogs` call covers a whole block range per scan (capped at 50 blocks, retried at 10 on a provider error), and a persisted per-chain cursor (`BlockCursorStore` — JSONL file locally, Supabase's `kv_state` table on the Worker) tracks the last block scanned so consecutive scans cover contiguous ranges instead of missing everything between runs.

## Chain configuration

Configured network records include Ethereum, Base, Arbitrum, Optimism, Polygon, and Robinhood Chain. RPC URLs are supplied by environment variables; no public RPC endpoint is hardcoded. Robinhood Chain uses chain ID `4663` for mainnet and `46630` for testnet.

## Time-to-action

The engine records timestamps for detection, classification, simulation, decision, and future broadcast stages. Each result includes stage deltas and detection-to-decision latency, allowing detector quality to be evaluated alongside execution speed.

## Execution model

`discovery -> classifier -> calldata -> simulation -> asset diff -> EV -> policy -> gas/nonce -> signer -> broadcaster -> verification -> notifications`

A live executor must still be treated as financial automation: simulation is necessary but not sufficient. The policy engine rejects unknown or missing NFT receipts, approvals, non-zero asset outflows, unexpected external value transfers, excessive gas, failed simulation, and opportunities below the configured EV threshold.

## Live broadcast (Sepolia testnet)

`scripts/execute.ts` is the guarded, real broadcast path. It re-verifies the mint is free and open (price `0`, sale open, per-address limit not reached), builds `publicMint(qty)`, runs `estimateGas` + `eth_call` simulation, checks wallet balance, then signs and broadcasts with a viem wallet client, waits for the receipt, and confirms the NFT balance increase.

It refuses to run unless both are set:

```sh
# set your wallet private key via environment (never commit it)
EXECUTION_PRIVATE_KEY=<hex-key>
EXECUTION_ACK=true
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
TARGET_CONTRACT=0x8Ad8867126e7F541f6a16609B8263D043d6647f4
bun run execute
```

It hard-refuses any chain other than Sepolia (chain id `11155111`) and aborts if the mint is no longer free, closed, or exceeds the per-address limit. Prefer keeping the key out of shell history; read it from a secret store.

## Telegram command bot

`scripts/telegram-bot.ts` runs a long-polling bot that puts a human in the loop for every live broadcast by default. The engine scans, simulates, and prepares approved mints automatically; it signs and broadcasts on an explicit `/mint` (or, if a user opts into autonomous mode — see below — on its own). This is the intended path for mainnet: no black-box auto-broadcasting unless a user has explicitly turned it on for themselves.

Registration, `/mint`, `/sign`, `/submit`, and the `/auto*` commands are open to **any** chat — this is the multi-user surface. `/scan`, `/mint-all`, and `/ack` are restricted to `TELEGRAM_ADMIN_IDS` because they cost RPC/gas on every run or arm live broadcasting bot-wide; an unauthorized chat gets "This command is restricted to the bot operator."

```sh
# create a bot via @BotFather and paste its token
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_ADMIN_IDS=<your-telegram-id>        # comma-separated; falls back to TELEGRAM_CHAT_ID
EXECUTION_PRIVATE_KEY=<hex-key>              # optional until you mint
ENABLED_CHAINS=base,arbitrum                # see config/chains.ts; set the matching *_RPC_URL
bun run telegram-bot
```

Commands:

| Command | Effect |
| --- | --- |
| `/help` | List commands |
| `/status` | Wallet, fleet size, chains, execution guard state, registered users, prepared-mint count |
| `/register <address>` | Set the receive address for this chat — free mints via `/mint` land here; no private key needed |
| `/scan` **[admin]** | Run a discovery + simulation + prepare pass over enabled chains |
| `/target <address-or-url>` | Check one specific contract you already know about — raw `0x` address, OpenSea asset URL, Zora URL, or a block explorer's address URL — through the same classify/simulate/policy pipeline as auto-discovery |
| `/prepared` | List mints approved by policy that are ready to broadcast |
| `/mint <index>` | Mint to YOUR registered address: a fleet wallet mints (pays gas), then transfers the NFT to you |
| `/sign <index>` | Build the EXACT transaction for your wallet to sign — non-custodial, your key stays on your device |
| `/submit <signed-raw-tx>` | Relay a transaction you signed in your own wallet; the NFT lands in your wallet |
| `/mint-all` **[admin]** | Batch-broadcast every prepared mint in a single EIP-7702 transaction per chain (needs `BATCH_EXECUTOR_ADDRESS`) |
| `/ack <on\|off>` **[admin]** | Enable/disable the live-execution guard (persisted to `GUARD_STATE_PATH`) — also the master switch autonomous auto-mint depends on |
| `/autokey <privatekey>` | Register YOUR OWN burner wallet key (DM only) so the bot can auto-mint for you unattended — see [Autonomous auto-mint](#autonomous-auto-mint-opt-in-per-user) |
| `/auto <on\|off>` | Turn your personal auto-mint on/off. Off by default; requires `/autokey` first |
| `/autostatus` | Your burner wallet address and auto-mint state |
| `/forgetkey` | Delete your stored burner wallet key and disable auto-mint |

Before every `/mint`, `RpcExecutor` (`src/execution/executor.ts`) re-reads on-chain state and aborts unless the mint is still free, still open, the per-address limit is not reached, and the wallet can afford gas. It only broadcasts after those checks pass. `/scan`, `/mint-all`, and `/ack` only honor `TELEGRAM_ADMIN_IDS`; every other command is open to any chat.

`/mint-all` groups prepared mints by chain and sends them through one EIP-7702 authorization per chain: the batch groups each prepared mint's calldata into a single `execute((to,value,data)[])` call against `BATCH_EXECUTOR_ADDRESS`, the wallet signs a `[chainId, batchExecutor, nonce]` authorization delegating to that contract, and the authorized transaction is broadcast from the wallet's own address. Each mint is still re-checked against `guardAgainstStaleMint` before being batched. Set `BATCH_EXECUTOR_ADDRESS` to the deployed 7702 batch-delegate contract; without it, `/mint-all` refuses to run.

## Non-custodial execution (recommended for public products)

The custodial fleet relay is convenient but means **your backend fleet temporarily owns every NFT and controls every transaction** — a custody/security honeypot. For anything public, the architecture to pursue is **discovery centralized, execution non-custodial**:

```text
backend:  discover → ABI → eligibility → simulation → gas → opportunity
user:     approve this exact transaction → sign in own wallet → NFT → user
```

The backend builds the **exact** transaction (`src/execution/noncustodial.ts`, `NonCustodialRelay`); the user signs it with their **own** wallet (private key never leaves their device); the backend only relays the already-signed raw tx and verifies the NFT landed in the **user's** wallet.

Flow in the Telegram bot:

1. `/register <address>` — set the receive wallet (public address only, no key).
2. `/sign <index>` — backend re-verifies free/open/per-address-limit, then returns the exact unsigned transaction (chain, to, value, gas, gasPrice, nonce, `unsignedHex`) for the user to sign.
3. `/submit <signed-raw-tx>` — backend relays the user-signed tx and reports `NFT in your wallet: before → after`.

No fleet wallets, no NFT re-transfer, no `FLEET_PRIVATE_KEYS`. The backend never holds a key, so it cannot steal or spend user assets. Gas is currently paid by the user; the natural next step is ERC-4337 paymaster sponsorship so the platform can pay gas while the user remains the asset owner.

## Multi-user relay (custodial, no user keys)

The system supports a **multi-user minting service**: anyone can `/register <their-address>` and then `/mint <index>` a free mint they see posted by the bot. The NFT lands in *their* wallet — they never hold a private key, never install a wallet, and never pay gas.

Mechanics (`src/execution/relay.ts`):

1. `WalletFleet` loads a set of funded bot wallets from `FLEET_PRIVATE_KEYS` (comma-separated).
2. On `/mint`, `MintRelay.mintFor(user, prepared)` picks a fleet wallet with per-address headroom (`balanceOf < MAX_LIMIT_PER_PUBLIC_ADDRS`), re-verifies the mint is still free/open, and checks the fleet wallet can afford gas.
3. The fleet wallet calls the mint (absorbing gas), confirms the NFT arrived via `balanceOf`.
4. `MintRelay` reads the new `tokenId` via `tokenOfOwnerByIndex` and `safeTransferFrom`s the NFT to the user's registered address.

User addresses are stored in `USER_REGISTRY_PATH` (`data/users.jsonl`) keyed by Telegram chat ID via `JsonlUserRegistry` (`src/users/registry.ts`); the latest registration wins per chat.

The fleet is what clears **per-address mint caps**: each bot wallet can mint up to the contract's per-wallet allowance, so N wallets serve N×limit users on a capped mint. Configure both the executor and the relay to get the single-key path and the multi-user path.

```sh
FLEET_PRIVATE_KEYS=k1,k2,k3   # comma-separated funded bot wallets
USER_REGISTRY_PATH=data/users.jsonl
bun run telegram-bot
```

## Autonomous auto-mint (opt-in, per-user)

By default nothing broadcasts without an explicit `/mint`. Any user can additionally opt themselves into **autonomous** minting: the bot scans on an interval and mints for them without a command, even while they're not there. This is a third execution model alongside the non-custodial and fleet-relay paths above — each user supplies and controls their **own** key, so it doesn't touch fleet wallets or the operator's `EXECUTION_PRIVATE_KEY`.

```text
/autokey <burner-privatekey>   →  bot encrypts and stores the key (DM only)
/auto on                       →  opt in; OFF is always the default
[unattended] every scan pass   →  bot signs + broadcasts YOUR policy-approved mints from YOUR key
/auto off | /forgetkey         →  opt out / delete the key at any time
```

Mechanics (`src/execution/automint.ts`, `src/users/keystore.ts`):

1. `/autokey <privatekey>` derives the address with viem and stores the key AES-256-GCM-encrypted (`AUTO_MINT_ENCRYPTION_KEY`, 32 random bytes — `openssl rand -hex 32`) in `AUTO_MINT_KEYSTORE_PATH`. The bot best-effort deletes the Telegram message containing the raw key; you should also delete it yourself. **Use a burner wallet with only what you're willing to lose — this is a hot key held by the bot's server.**
2. `/auto on` opts the chat in. `AutoMintLoop` runs on `AUTO_MINT_SCAN_INTERVAL_MS` (default 2 min): for each opted-in user it builds an `RpcExecutor` from their decrypted key and attempts every `PASS` opportunity they haven't been tried against yet, re-verifying free/open/limit/gas exactly like a manual `/mint` would.
3. Every `(user, opportunity)` pair is attempted **at most once** — recorded in `AUTO_MINT_LOG_PATH` — win or lose, so a permanently-failing mint doesn't get retried and re-spend gas every interval.
4. Two caps bound the blast radius of running unattended: `AUTO_MINT_MAX_PER_USER_PER_SCAN` (default 1) and `AUTO_MINT_MAX_TOTAL_PER_SCAN` (default 10) across all users, per scan pass.
5. The operator's `/ack on` guard is still a hard prerequisite — autonomous mode never broadcasts while the guard is off, same as manual `/mint`.
6. Leave `AUTO_MINT_ENCRYPTION_KEY` unset to disable the feature entirely; `/autokey`, `/auto`, `/autostatus`, and `/forgetkey` will all say so instead of doing anything.

```sh
AUTO_MINT_ENCRYPTION_KEY=$(openssl rand -hex 32)
AUTO_MINT_SCAN_INTERVAL_MS=120000
AUTO_MINT_MAX_PER_USER_PER_SCAN=1
AUTO_MINT_MAX_TOTAL_PER_SCAN=10
bun run telegram-bot
```

## Serverless deployment (Cloudflare Workers + Supabase)

`scripts/telegram-bot.ts` needs a process that's always running (long-polling) and a writable filesystem (`data/*.jsonl`). `worker/index.ts` is the same bot re-pointed at a **webhook** and **Postgres**, so it can run on Cloudflare's free tier with no server to keep alive:

| | Always-on (`scripts/telegram-bot.ts`) | Serverless (`worker/index.ts`) |
| --- | --- | --- |
| Transport | Long-polling (`getUpdates`) | Telegram webhook → `POST /telegram-webhook` |
| Storage | `data/*.jsonl` files | Supabase (Postgres) |
| Scan / auto-mint interval | `setInterval` in the process | Cloudflare Cron Trigger (`scheduled()`), every 2 min by default |
| Encryption | Web Crypto (`src/users/crypto.ts`) | same — portable to both |

All the command logic (`src/telegram/bot.ts`), execution logic (`executor.ts`/`relay.ts`/`noncustodial.ts`/`automint.ts`), and the multi-user/autonomous features above are **unchanged** — only the storage adapters and the entrypoint differ. `src/storage/supabase.ts` implements the same ports (`UserRegistry`, `UserKeyStore`, `PreparedTransactionStore`, `CandidateStore`, `AutoMintLog`) as their `Jsonl*` counterparts.

**1. Database.** Apply `supabase/migrations/20260822000000_orbis_bot_storage.sql` to a Supabase project (`supabase db push`, or paste it into the SQL editor). This session already provisioned one for Orbis:
```
project: orbis (spxobcjspromgfmchmyj)
url:     https://spxobcjspromgfmchmyj.supabase.co
```
Grab the **service_role** key from that project's Settings → API in the Supabase dashboard (deliberately not something any automated tool hands out) — the Worker authenticates as service_role, since these tables have RLS enabled with no policies (default-deny for the publishable/anon key).

**2. Secrets** (`wrangler secret put <NAME>`, one at a time — never committed):
```
TELEGRAM_BOT_TOKEN
TELEGRAM_ADMIN_IDS
TELEGRAM_WEBHOOK_SECRET      # openssl rand -hex 32 — verifies webhook calls are really from Telegram
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
AUTO_MINT_ENCRYPTION_KEY     # optional, enables /autokey — openssl rand -hex 32
FLEET_PRIVATE_KEYS           # optional, enables the custodial relay
EXECUTION_PRIVATE_KEY        # optional, operator's own single-key mint path
BATCH_EXECUTOR_ADDRESS       # optional, needed for /mint-all
```
Plain (non-secret) config — RPC URLs, `ENABLED_CHAINS`, contract lists, policy thresholds — goes in `wrangler.toml`'s `[vars]` block; see `.env.example` for the full list, since every `process.env.*` read in `src/` works identically here (bridged in by `populateProcessEnv()` in `worker/index.ts`, which requires the `nodejs_compat` flag already set in `wrangler.toml`).

**3. Deploy and point Telegram at it:**
```sh
bunx wrangler login
bun run worker:deploy
# copy the printed *.workers.dev URL, then:
TELEGRAM_BOT_TOKEN=<token> WORKER_URL=https://orbis-telegram-bot.<subdomain>.workers.dev TELEGRAM_WEBHOOK_SECRET=<same as the secret above> bun run set-webhook
```
`bun run delete-webhook` switches Telegram back to no webhook (needed before going back to `bun run telegram-bot`'s long-polling — Telegram only delivers to one or the other). `bun run worker:typecheck` type-checks `worker/` against Workers' types instead of Bun's.

**Constraints worth knowing:** Workers have no persistent process, so the scan/auto-mint interval is now a cron tick (1-minute minimum granularity) instead of `setInterval`; a full discovery pass across many chains/contracts should comfortably fit Workers' free-tier CPU-time limits since RPC round-trips are I/O wait (not billed), but a very large contract list is untested here — watch the Cloudflare dashboard's CPU-time metrics after your first few scheduled runs and trim `ENABLED_CHAINS`/`*_CONTRACTS` if you see timeouts.

## Two-mode architecture

The system runs as two separate Telegram bots that share the same engine. The split keeps **public broadcast** (zero secrets, safe to expose) separate from **private execution** (your funded wallet key, locked to your DM).

**1. Public discovery bot** (`scripts/discovery-bot.ts`) — broadcast-only, **no private key required**. It continuously scans enabled chains on an interval, and for every policy-approved free mint it posts an alert to a public channel with the collection, chain, contract address, an explorer mint link, and a "connect your wallet and mint" call-to-action. Users mint with their **own** wallets — you never hold their funds. Runs on a scan interval (`SCAN_INTERVAL_MS`, default `120000`), and dedupes already-alerted mints via `data/alerted.jsonl` so it never spams the same one.

```sh
# create a bot via @BotFather; add it as an admin to a public channel
TELEGRAM_ALERT_BOT_TOKEN=<bot-token>      # falls back to TELEGRAM_BOT_TOKEN
TELEGRAM_ALERT_CHANNEL_ID=<channel-id>    # falls back to TELEGRAM_CHAT_ID
ENABLED_CHAINS=base,arbitrum              # see config/chains.ts; set the matching *_RPC_URL
SCAN_INTERVAL_MS=120000                   # optional
bun run discovery-bot
```

It only ever reads: discovery, classification, simulation, and policy. It never signs or broadcasts — there is nothing to lose if it's public.

**2. Private command bot** (`scripts/telegram-bot.ts`) — the execution surface. Hold your funded wallet key (`EXECUTION_PRIVATE_KEY`), run `/ack on` once, then every `/mint <index>` re-verifies the mint is still free/open/within limit, signs, broadcasts, and confirms ownership — all in one click. If you configure a `FLEET_PRIVATE_KEYS` relay or `AUTO_MINT_ENCRYPTION_KEY`, other users can `/register`/`/mint` or opt into their own autonomous mints through this same bot without touching your `EXECUTION_PRIVATE_KEY` — see [Multi-user relay](#multi-user-relay-custodial-no-user-keys) and [Autonomous auto-mint](#autonomous-auto-mint-opt-in-per-user). `/scan`, `/mint-all`, and `/ack` stay restricted to `TELEGRAM_ADMIN_IDS`; if no fleet is configured, `/mint` (which would otherwise spend your own key) is restricted too.
