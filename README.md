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

The fixture path exercises the full pipeline without a wallet or chain. `testnet-probe` is the next safe step for one real testnet contract: it resolves the ABI, checks wallet eligibility, constructs calldata, runs `eth_estimateGas`/`eth_call`/optional tracing, scores policy, and writes a JSON report. It does not sign or broadcast. `live-readonly` uses configured RPC endpoints, discovers configured contracts (or recent deployments with `DISCOVERY_MODE=blocks`), inspects NFT interfaces, runs read-only simulation, persists candidates/events under `data/`, and never signs or broadcasts. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable alerts. `SIMULATION_FROM` is required for real RPC simulation because state-diff interpretation must be wallet-specific. Configure one or more comma-separated RPC URLs in each chain variable; the simulator rotates to a healthy provider when one fails.

## Real RPC simulation

`RpcSimulator` performs:

1. `eth_estimateGas`
2. `eth_gasPrice`
3. `eth_call`
4. optional `debug_traceCall` with `callTracer` and logs

When tracing is available, it extracts ERC-721/ERC-1155-style NFT transfers, ERC-20 transfers, approvals, approval-for-all calls, and nested external calls. A provider that supports `eth_call` but not tracing is still usable, but the result is marked without a state diff and should not pass a policy that requires proof of an NFT receipt.

The simulator deliberately does not claim that a plain `eth_call` proves post-state. It records the limitation instead. A production deployment should use a fork or a tracing-capable provider for state-diff enforcement and add contract-specific decoding for Merkle proofs, signatures, proxy implementations, quotas, and time/block windows.

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

`scripts/telegram-bot.ts` runs a long-polling bot that puts a human in the loop for every live broadcast. The engine scans, simulates, and prepares approved mints automatically; it only signs and broadcasts on an explicit `/mint` from an authorized chat. This is the intended path for mainnet: no black-box auto-broadcasting.

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
| `/scan` | Run a discovery + simulation + prepare pass over enabled chains |
| `/prepared` | List mints approved by policy that are ready to broadcast |
| `/mint <index>` | Mint to YOUR registered address: a fleet wallet mints (pays gas), then transfers the NFT to you |
| `/sign <index>` | Build the EXACT transaction for your wallet to sign — non-custodial, your key stays on your device |
| `/submit <signed-raw-tx>` | Relay a transaction you signed in your own wallet; the NFT lands in your wallet |
| `/mint-all` | Batch-broadcast every prepared mint in a single EIP-7702 transaction per chain (needs `BATCH_EXECUTOR_ADDRESS`) |
| `/ack <on\|off>` | Enable/disable the live-execution guard (persisted to `GUARD_STATE_PATH`) |

Before every `/mint`, `RpcExecutor` (`src/execution/executor.ts`) re-reads on-chain state and aborts unless the mint is still free, still open, the per-address limit is not reached, and the wallet can afford gas. It only broadcasts after those checks pass. The bot only honors commands from `TELEGRAM_ADMIN_IDS`.

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

## Two-mode architectureThe system runs as two separate Telegram bots that share the same engine. The split keeps **public broadcast** (zero secrets, safe to expose) separate from **private execution** (your funded wallet key, locked to your DM).

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

**2. Private command bot** (`scripts/telegram-bot.ts`) — owner-only. This is the auto-mint path: hold your funded wallet key (`EXECUTION_PRIVATE_KEY`), run `/ack on` once, then every `/mint <index>` re-verifies the mint is still free/open/within limit, signs, broadcasts, and confirms ownership — all in one click. It only honors commands from `TELEGRAM_ADMIN_IDS`, so your wallet stays in your DM.
