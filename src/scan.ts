// legible-scanner/src/scan.ts
// ─────────────────────────────────────────────────────────────────────────────
// TIER-1 CONTRACT SCAN — everything answerable from chain alone. No third-party API, so no rate
// limit, no cost, and nothing that can be switched off underneath us.
//
// The report is a MECHANICS report: "can this contract hurt you?" Every input is a deterministic
// on-chain fact (the freeze authority exists or it doesn't), never a prediction of price. That
// distinction is the whole reason this score is defensible where the old tier-score was not
// (SOLANA-DIARY.md 2026-08-19: score↔outcome correlation was -0.0001).
//
// Two rules the shape of this file enforces:
//   • EVERY flag carries its evidence, so a user can verify us rather than trust us.
//   • A check that could not run reports `coverage: 'unknown'` — never a clean pass. A dead data
//     source that reads as "no flags found" is worse than an error (diary, 2026-08-27).
// ─────────────────────────────────────────────────────────────────────────────
import { parseMintExtensions, worstSeverity, type ExtensionFinding, type Severity } from './extensions';
import { knownAsset } from './knownAssets';
import type { SolanaRpc } from './rpc';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export type Coverage = 'ok' | 'unknown';

export interface Flag {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence?: string;
}

export interface ScanReport {
  mint: string;
  ts: number;
  /** null when the account isn't a token mint at all */
  found: boolean;
  tokenProgram?: 'spl' | 'token-2022';
  supply?: string;
  decimals?: number;
  uiSupply?: number;

  authorities: {
    coverage: Coverage;
    mintAuthority: string | null;
    freezeAuthority: string | null;
  };
  extensions: {
    coverage: Coverage;
    findings: ExtensionFinding[];
    present: number[];
  };
  holders: {
    coverage: Coverage;
    /** share of supply held by the largest N accounts the RPC returned (max 20) */
    top1Pct?: number;
    top10Pct?: number;
    sampled?: number;
    note?: string;
  };

  /** set when this is a widely-held asset with a publicly accountable issuer — see knownAssets.ts */
  knownAsset?: { name: string; issuer: string; note: string };

  flags: Flag[];
  /** 0-100. HIGHER = MORE DANGEROUS. Null when coverage is too thin to justify a number. */
  riskScore: number | null;
  /** what the score is and — just as importantly — what it is not */
  scoreMeaning: string;
  degraded: boolean;
}

/** Base SPL mint layout: mintAuthority COption<Pubkey>(36) supply(8) decimals(1) init(1) freeze COption<Pubkey>(36). */
function parseBaseMint(d: Buffer, toBase58: (b: Buffer) => string) {
  if (d.length < 82) return null;
  const mintAuthOpt = d.readUInt32LE(0);
  const mintAuthority = mintAuthOpt === 1 ? toBase58(d.subarray(4, 36)) : null;
  const supply = d.readBigUInt64LE(36);
  const decimals = d.readUInt8(44);
  const freezeOpt = d.readUInt32LE(46);
  const freezeAuthority = freezeOpt === 1 ? toBase58(d.subarray(50, 82)) : null;
  return { mintAuthority, supply, decimals, freezeAuthority };
}

export interface ScanDeps {
  rpc: Pick<SolanaRpc, 'getAccount' | 'getTokenLargestAccounts'>;
  toBase58: (b: Buffer) => string;
  /** returns a label when the address is a documented bad actor */
  knownActor?: (address: string) => { label: string; evidence: string } | null;
}

export async function scanMint(mint: string, deps: ScanDeps, now = Date.now()): Promise<ScanReport> {
  const { rpc, toBase58, knownActor } = deps;
  const report: ScanReport = {
    mint,
    ts: now,
    found: false,
    authorities: { coverage: 'unknown', mintAuthority: null, freezeAuthority: null },
    extensions: { coverage: 'unknown', findings: [], present: [] },
    holders: { coverage: 'unknown' },
    flags: [],
    riskScore: null,
    scoreMeaning:
      'Mechanics risk only: can this contract take, freeze, tax or block your tokens. It says NOTHING about whether the price will go up.',
    degraded: false,
  };

  const acct = await rpc.getAccount(mint).catch(() => null);
  if (!acct) {
    report.flags.push({
      id: 'not-found',
      severity: 'warn',
      title: 'No account at this address',
      detail: 'Nothing is deployed here, or the RPC could not reach it.',
    });
    report.degraded = true;
    return report;
  }
  const isT22 = acct.owner === TOKEN_2022_PROGRAM;
  const isSpl = acct.owner === TOKEN_PROGRAM;
  if (!isT22 && !isSpl) {
    report.flags.push({
      id: 'not-a-mint',
      severity: 'info',
      title: 'Not a token mint',
      detail: `This address is owned by ${acct.owner}, not a token program.`,
      evidence: acct.owner,
    });
    return report;
  }

  report.found = true;
  report.tokenProgram = isT22 ? 'token-2022' : 'spl';

  // ── authorities ────────────────────────────────────────────────────────────
  const base = parseBaseMint(acct.data, toBase58);
  if (base) {
    report.authorities = { coverage: 'ok', mintAuthority: base.mintAuthority, freezeAuthority: base.freezeAuthority };
    report.supply = base.supply.toString();
    report.decimals = base.decimals;
    report.uiSupply = Number(base.supply) / 10 ** base.decimals;

    // An authority held by a publicly accountable issuer is a disclosed design, not an ambush.
    // The capability is reported either way — only the severity is calibrated. See knownAssets.ts
    // for why this exists (USDC scored DANGEROUS on the first control run).
    const asset = knownAsset(mint);
    if (asset) report.knownAsset = { name: asset.name, issuer: asset.issuer, note: asset.note };

    if (base.mintAuthority) {
      report.flags.push({
        id: 'mint-authority-live',
        severity: asset ? 'info' : 'critical',
        title: asset ? `Issuer can mint more ${asset.name}` : 'Supply can still be inflated',
        detail: asset
          ? asset.note
          : 'The mint authority has not been revoked — more tokens can be created at any time, diluting holders.',
        evidence: base.mintAuthority,
      });
    }
    if (base.freezeAuthority) {
      report.flags.push({
        id: 'freeze-authority-live',
        severity: asset ? 'info' : 'critical',
        title: asset ? `Issuer can freeze ${asset.name} balances` : 'Your account can be frozen',
        detail: asset
          ? asset.note
          : 'The freeze authority is live. It can freeze your token account, which stops you selling.',
        evidence: base.freezeAuthority,
      });
    }
  } else {
    report.degraded = true;
  }

  // ── Token-2022 extensions ──────────────────────────────────────────────────
  const ext = parseMintExtensions(acct.data, isT22);
  report.extensions = {
    coverage: ext.truncated ? 'unknown' : 'ok',
    findings: ext.findings,
    present: ext.present,
  };
  if (ext.truncated) report.degraded = true;
  for (const f of ext.findings) {
    report.flags.push({
      id: `ext-${f.ext}`,
      severity: f.severity,
      title: f.ext,
      detail: f.meaning,
      evidence: f.evidence,
    });
  }

  // ── known bad actors ───────────────────────────────────────────────────────
  if (knownActor) {
    for (const [label, addr] of [
      ['mint authority', report.authorities.mintAuthority],
      ['freeze authority', report.authorities.freezeAuthority],
    ] as const) {
      if (!addr) continue;
      const hit = knownActor(addr);
      if (hit) {
        report.flags.push({
          id: 'known-actor',
          severity: 'critical',
          title: 'Documented bad actor',
          detail: `The ${label} is a known operator: ${hit.label}`,
          evidence: `${addr} — ${hit.evidence}`,
        });
      }
    }
  }

  // ── holder concentration ───────────────────────────────────────────────────
  try {
    const largest = await rpc.getTokenLargestAccounts(mint);
    if (largest.length && base && base.supply > 0n) {
      const supply = Number(base.supply);
      const amounts = largest.map((a) => Number(a.amount)).sort((a, b) => b - a);
      const top1 = (amounts[0] / supply) * 100;
      const top10 = (amounts.slice(0, 10).reduce((s, a) => s + a, 0) / supply) * 100;
      report.holders = {
        coverage: 'ok',
        top1Pct: +top1.toFixed(2),
        top10Pct: +top10.toFixed(2),
        sampled: amounts.length,
        note:
          amounts.length >= 20
            ? 'RPC returns at most 20 accounts, so these are lower bounds on concentration.'
            : undefined,
      };
      // A bonding-curve vault legitimately holds most of the supply pre-graduation, so a high top-1
      // is only reported as a fact — it is deliberately NOT scored, to avoid flagging every new coin.
      if (top10 > 80) {
        report.flags.push({
          id: 'holder-concentration',
          severity: 'warn',
          title: 'Very concentrated',
          detail: `The top ${Math.min(10, amounts.length)} accounts hold ${top10.toFixed(1)}% of supply. Note that a bonding-curve vault can legitimately be one of these.`,
          evidence: `top1 ${top1.toFixed(1)}%, top10 ${top10.toFixed(1)}%`,
        });
      }
    } else {
      report.holders = { coverage: 'unknown' };
      report.degraded = true;
    }
  } catch {
    report.holders = { coverage: 'unknown', note: 'holder lookup failed — treat concentration as UNKNOWN, not safe' };
    report.degraded = true;
  }

  report.riskScore = scoreOf(report);
  return report;
}

/**
 * Score is a capability count, not a prediction: each critical mechanism that can cost a holder their
 * tokens adds weight. Returns null when the two checks that dominate it could not run — a score
 * derived from missing data would read as "safe" and that is the exact failure we refuse to ship.
 */
export function scoreOf(r: ScanReport): number | null {
  if (r.authorities.coverage !== 'ok' && r.extensions.coverage !== 'ok') return null;
  let score = 0;
  for (const f of r.flags) {
    if (f.severity === 'critical') score += 30;
    else if (f.severity === 'warn') score += 10;
  }
  return Math.min(100, score);
}

export function verdict(r: ScanReport): string {
  if (r.riskScore === null) return 'UNKNOWN — not enough on-chain coverage to judge';
  if (r.knownAsset) return `KNOWN ASSET — ${r.knownAsset.name}, issued by ${r.knownAsset.issuer}`;
  const worst = worstSeverity(r.flags.map((f) => ({ ...f, ext: f.id, meaning: f.detail })));
  if (worst === 'critical') return 'DANGEROUS — this contract can take or block your tokens';
  if (worst === 'warn') return 'CAUTION — nothing fatal, but there are real caveats';
  return 'CLEAN MECHANICS — no authority can seize, freeze or tax you';
}
