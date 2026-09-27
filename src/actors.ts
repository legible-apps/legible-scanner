// legible-scanner/src/actors.ts
// ─────────────────────────────────────────────────────────────────────────────
// Documented bad actors, consulted on every scan. Zero network, zero RPC — a Map lookup.
//
// ⚠️ DUPLICATION, DELIBERATE BUT TEMPORARY. The canonical list is `suite/core/knownActors.ts`.
// This service is built to deploy standalone (own container, own TLS, nothing shared with the
// suite), so it cannot import across that boundary today. Security data that exists in two places
// WILL drift, so the real fix is to promote the list to a shared JSON both read at boot —
// tracked as a Phase-1 follow-up. Until then: edit the suite file first, then mirror it here.
//
// Keep entries EVIDENCE-BACKED only. A false "rug" label on an honest dev is a real harm, and this
// list is about to be public-facing.
// ─────────────────────────────────────────────────────────────────────────────

export interface KnownActor {
  address: string;
  role: 'deployer' | 'extractor';
  label: string;
  evidence: string;
}

export const KNOWN_ACTORS: KnownActor[] = [
  {
    address: 'BV1dengBUiVNurB8oDDMKic25Pqztha5BkC5PGWinb4i',
    role: 'deployer',
    label: 'Honeypot mill deployer — fake-liquidity mints (≈1,562 tokens); sells revert',
    evidence: 'forensics/REV1_INTERNAL_COMPLETE.md:44,144 · REV3_LAW_ENFORCEMENT.md:22',
  },
  {
    address: '8QvbfWWtY1P3Jd12iN1YKao2FzRb3PXxYAEmPWncbKjr',
    role: 'extractor',
    label: 'Honeypot mill extractor — wash-trade sell wallet, funded by the deployer',
    evidence: 'forensics/REV1_INTERNAL_COMPLETE.md:45 · REV3_LAW_ENFORCEMENT.md:23',
  },
  {
    address: 'BkNGKv9VhyMWnqiyyku2CuhjNLQWMDzb73NMjBMBBy9r',
    role: 'deployer',
    label: 'Airdrop-dust scam deployer ("PAID") — unsellable token used as phishing bait',
    evidence:
      'Observed live 2026-09-26: 16 of 17 deliveries signed AND fee-paid by the distributor, ~every 16h, randomised 11k-21k amounts. Supply 9.89B; no route at any size.',
  },
  {
    address: 'CQZtbdAs1uRv6LqMUGvr9CwasEDpaWR96fVnFbDAEyJA',
    role: 'extractor',
    label: 'Airdrop-dust distributor for "PAID" — signs + pays fees on every unsolicited delivery',
    evidence: 'Observed live 2026-09-26 on BzQ5: 16/17 txs 2026-09-20 → 2026-09-26, recipient paid nothing.',
  },
];

const BY_ADDRESS = new Map(KNOWN_ACTORS.map((a) => [a.address, a]));

/** Instant lookup used by the scanner. Returns null for anything undocumented. */
export function knownActor(address: string | null | undefined): KnownActor | null {
  return (address && BY_ADDRESS.get(address)) || null;
}
