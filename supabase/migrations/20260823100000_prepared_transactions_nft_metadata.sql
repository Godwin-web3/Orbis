-- prepared_transactions.to_address is the contract the transaction actually calls (e.g.
-- OpenSea's shared SeaDrop router for a SeaDrop mint), not the NFT collection itself. These
-- columns carry the real collection's address/name (from MintCandidate.metadata) so the bot
-- can show and link to what a user actually wants to see, instead of the router address.
ALTER TABLE public.prepared_transactions
  ADD COLUMN IF NOT EXISTS nft_contract text NULL,
  ADD COLUMN IF NOT EXISTS name text NULL;
