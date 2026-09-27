// legible-scanner/src/knownAssets.ts
// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION, not a whitelist.
//
// Caught by the control test on day one: USDC scored 60/100 "DANGEROUS", because Circle really does
// hold both mint and freeze authority. The FACT is correct — Circle can and does freeze balances —
// but shipping a scanner that calls USDC dangerous destroys the tool's credibility on first contact,
// and a user who learns to ignore our red badge will ignore it on the coin that actually robs them.
//
// So: the facts never change. Every authority is still reported with its evidence. What changes is
// the SEVERITY, for assets where a live authority is the expected, disclosed design of a regulated
// issuer rather than an unexplained power held by an anonymous deployer.
//
// The bar for entry is deliberately high: a long-lived, widely-held asset whose issuer is publicly
// known and accountable. This must never become a favour list — an entry here suppresses a warning
// that would otherwise be shown, so a wrong entry is a user losing money.
// ─────────────────────────────────────────────────────────────────────────────

export interface KnownAsset {
  mint: string;
  name: string;
  issuer: string;
  /** shown in place of the scary wording — states the same capability, without the false alarm */
  note: string;
}

export const KNOWN_ASSETS: KnownAsset[] = [
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'USDC',
    issuer: 'Circle',
    note: 'Circle can mint new USDC and freeze balances. That is the disclosed design of a regulated stablecoin, not a hidden backdoor — but it is still a real power you are trusting.',
  },
  {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    name: 'USDT',
    issuer: 'Tether',
    note: 'Tether can mint and freeze balances. Disclosed issuer capability, not a hidden backdoor.',
  },
  {
    mint: 'So11111111111111111111111111111111111111112',
    name: 'Wrapped SOL',
    issuer: 'SPL Token program',
    note: 'The canonical wrapped-SOL mint. Native protocol asset.',
  },
];

const BY_MINT = new Map(KNOWN_ASSETS.map((a) => [a.mint, a]));

export function knownAsset(mint: string): KnownAsset | null {
  return BY_MINT.get(mint) || null;
}
