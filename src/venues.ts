// legible-scanner/src/venues.ts
// ─────────────────────────────────────────────────────────────────────────────
// VENUE REGISTRY — the addresses we sample to answer "how busy is this launchpad right now?"
//
// Solana is the only chain we serve today (A.savino, 2026-09-21: "Solana is our specialty at the
// moment but we will scale when the time is right"). So every venue here is Solana — but the shape
// is chain-tagged and registry-driven on purpose, so adding a chain later is *additive* rather than
// a rewrite. Nothing outside this file should hardcode a program id.
//
// THE RULE that earned this file (SOLANA-DIARY.md, 2026-09-20): before adopting an address as a
// venue's activity proxy, prove on-chain that (a) every action on that venue touches it and
// (b) nothing outside that venue does. Inferring it from docs is how we nearly shipped "Meteora DBC
// = Bags". Each entry below records which of those two we actually verified, and `exclusive` is the
// honest answer — the UI must label a non-exclusive venue as the ecosystem it really measures.
// ─────────────────────────────────────────────────────────────────────────────

export type Chain = 'solana';

export interface Venue {
  /** stable key used in the API payload and on disk */
  id: string;
  /** what we show a human */
  label: string;
  chain: Chain;
  /** the account we run getSignaturesForAddress against */
  address: string;
  /**
   * True only when we have verified the address is touched by this venue's activity AND by nothing
   * else. False means the number is real but measures a WIDER set than the label suggests — the UI
   * must then show `ecosystemNote`, never the bare venue name.
   */
  exclusive: boolean;
  /** shown whenever `exclusive` is false, so a shared number is never passed off as a venue's own */
  ecosystemNote?: string;
  /** what we measured when this entry was added — a sanity anchor, not a threshold */
  verified: { on: string; observedTxPerSec: number; note: string };
}

export const VENUES: Venue[] = [
  {
    id: 'pumpfun',
    label: 'pump.fun',
    chain: 'solana',
    address: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    exclusive: true,
    verified: {
      on: '2026-09-20',
      observedTxPerSec: 100,
      note: 'Bonding-curve program. Every launch and every pre-graduation trade flows through it; nothing else uses it.',
    },
  },
  {
    id: 'letsbonk',
    label: 'LetsBonk',
    chain: 'solana',
    // NOT the LaunchLab program (LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj) — that is shared with
    // every other LaunchLab launchpad. This is LetsBonk's own platform-config PDA, which IS
    // signature-visible (verified: 18.18 tx/s against the program's 20.41, i.e. ~89% of LaunchLab).
    address: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1',
    exclusive: true,
    verified: {
      on: '2026-09-21',
      observedTxPerSec: 18.18,
      note: 'LetsBonk platform config, owned by LaunchLab. Appears in LetsBonk txs as a static key, so signature sampling sees it.',
    },
  },
  {
    id: 'meteora-dbc',
    label: 'Meteora DBC',
    chain: 'solana',
    address: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
    exclusive: false,
    ecosystemNote:
      'All Meteora DBC launchpads combined (incl. Bags) — not any single venue. Bags has no program of its own and its DBC configs are per-creator, so Bags cannot be isolated by address sampling; use the Bags API for Bags-specific numbers.',
    verified: {
      on: '2026-09-20',
      observedTxPerSec: 16,
      note: 'Shared bonding program. Our BAGS_DEFAULT_CONFIG_KEY appeared in 0/6 recent DBC txs — it is our own unused config, not a Bags discriminator.',
    },
  },
];

export function venueById(id: string): Venue | undefined {
  return VENUES.find((v) => v.id === id);
}
