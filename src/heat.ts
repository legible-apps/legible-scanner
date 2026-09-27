// legible-scanner/src/heat.ts
// ─────────────────────────────────────────────────────────────────────────────
// LAUNCHPAD HEAT — "how busy is each launchpad right now?", generalised from suite/core/pumpHeat.ts.
//
// Same proven method: one cheap getSignaturesForAddress per venue on a background timer, rate derived
// from the blockTime span of the returned signatures, served from cache so an HTTP request costs ZERO
// RPC no matter how many tabs poll it.
//
// TWO DELIBERATE CHANGES from pumpHeat:
//
//  1. ROLLING-PERCENTILE BASELINE instead of hardcoded LO/HI. pump's LO=5/HI=400 was *earned* from
//     live samples and is wrong for every other venue (LetsBonk runs ~18 tx/s, DBC ~16 — both would
//     peg near zero on pump's scale and look dead). Each venue is instead scored against its OWN
//     trailing p95, so the gauge is honest on day one and venues stay comparable without us
//     pretending to know each one's ceiling.
//
//  2. HONEST COLD START. Until a venue has enough history its heat is marked `calibrating` and the
//     UI must say so. A number we cannot yet justify is worse than an absent one — see the
//     2026-08-27 lesson: a dead/immature data source reads as "clean" unless it says otherwise.
//
// Read-only. No keys, no signing, no writes to chain.
// ─────────────────────────────────────────────────────────────────────────────
import { VENUES, type Venue } from './venues';

const DAY_MS = 86_400_000;

/** How long a venue's samples are kept for the percentile baseline. */
export const BASELINE_WINDOW_MS = Number(process.env.SCANNER_BASELINE_DAYS || 7) * DAY_MS;
/** Samples required before we stop flagging `calibrating`. At 45s cadence, 40 ≈ 30 minutes. */
export const MIN_SAMPLES_FOR_BASELINE = Number(process.env.SCANNER_MIN_SAMPLES || 40);
/** A sample older than this means the poller is wedged — serve last-good, flagged stale. */
export const STALE_AFTER_MS = 90_000;

export interface HeatReading {
  venueId: string;
  label: string;
  chain: string;
  /** false ⇒ this number covers a wider ecosystem than `label`; show `ecosystemNote`. */
  exclusive: boolean;
  ecosystemNote?: string;

  /** 0-100 against this venue's own trailing p95. Null while `calibrating`. */
  heat: number | null;
  txPerSec: number;
  /** signatures seen in the trailing 60s of the sample (saturates when very hot — itself a tell) */
  last60: number;
  failRatio: number;
  /** the p95 the heat was scored against, so the number is auditable */
  baselineP95: number | null;
  samples: number;
  /** true until MIN_SAMPLES_FOR_BASELINE samples exist — heat is null and the UI must say "calibrating" */
  calibrating: boolean;
  /** true if backed off or the last good sample is older than STALE_AFTER_MS */
  stale: boolean;
  ts: number;
}

interface VenueState {
  venue: Venue;
  /** trailing samples: [timestampMs, txPerSec] */
  history: Array<[number, number]>;
  last: HeatReading;
  backoffUntil: number;
}

const state = new Map<string, VenueState>();

function blank(v: Venue): HeatReading {
  return {
    venueId: v.id,
    label: v.label,
    chain: v.chain,
    exclusive: v.exclusive,
    ecosystemNote: v.ecosystemNote,
    heat: null,
    txPerSec: 0,
    last60: 0,
    failRatio: 0,
    baselineP95: null,
    samples: 0,
    calibrating: true,
    stale: true,
    ts: 0,
  };
}

for (const v of VENUES) {
  state.set(v.id, { venue: v, history: [], last: blank(v), backoffUntil: 0 });
}

/** Nearest-rank p95 over the retained samples. Exported for the tests. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Map a rate to 0-100 against the venue's own p95, on a log scale so the busy end keeps resolution.
 * p95 maps to ~95 by construction, leaving genuine headroom for an exceptional day rather than
 * pegging at 100 and going blind (the failure mode a fixed HI has).
 */
export function scaleAgainstBaseline(txPerSec: number, p95: number): number {
  if (!(p95 > 0) || txPerSec <= 0) return 0;
  const floor = p95 / 50; // two decades of range below the p95
  if (txPerSec <= floor) return 0;
  const scaled = (95 * Math.log(txPerSec / floor)) / Math.log(p95 / floor);
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

/** Drop samples outside the baseline window. Exported for the tests. */
export function prune(history: Array<[number, number]>, now = Date.now()): Array<[number, number]> {
  const cutoff = now - BASELINE_WINDOW_MS;
  let i = 0;
  while (i < history.length && history[i][0] < cutoff) i++;
  return i ? history.slice(i) : history;
}

/** Minimal shape we need from a connection — keeps this testable without a live RPC. */
export interface SignatureFetcher {
  getSignaturesForAddress(
    address: string,
    limit: number,
  ): Promise<Array<{ blockTime?: number | null; err?: unknown }>>;
}

/**
 * Take one sample for one venue. Never throws — a venue that errors backs off and keeps serving its
 * last-good reading flagged `stale`, so one bad venue can't blank the whole gauge.
 */
export async function sampleVenue(
  fetcher: SignatureFetcher,
  venueId: string,
  now = Date.now(),
): Promise<void> {
  const st = state.get(venueId);
  if (!st) return;
  if (now < st.backoffUntil) {
    st.last = { ...st.last, stale: true };
    return;
  }

  const LIMIT = Math.max(50, Math.min(1000, Number(process.env.SCANNER_HEAT_SIGS) || 300));
  try {
    const sigs = await fetcher.getSignaturesForAddress(st.venue.address, LIMIT);
    const withTime = sigs.filter((s) => typeof s.blockTime === 'number') as Array<{
      blockTime: number;
      err?: unknown;
    }>;
    if (withTime.length < 2) {
      // Reachable but nothing to measure — that's a real "idle", not an error. Don't poison history.
      st.last = { ...st.last, stale: false, ts: now };
      return;
    }

    const span = Math.max(1, withTime[0].blockTime - withTime[withTime.length - 1].blockTime);
    const txPerSec = withTime.length / span;
    const nowSec = Math.floor(now / 1000);

    st.history = prune([...st.history, [now, txPerSec] as [number, number]], now);
    const rates = st.history.map(([, r]) => r);
    const calibrating = st.history.length < MIN_SAMPLES_FOR_BASELINE;
    const p95 = calibrating ? null : percentile(rates, 95);

    st.last = {
      ...blank(st.venue),
      heat: p95 === null ? null : scaleAgainstBaseline(txPerSec, p95),
      txPerSec: +txPerSec.toFixed(2),
      last60: withTime.filter((s) => nowSec - s.blockTime <= 60).length,
      failRatio: +(sigs.filter((s) => s.err).length / Math.max(1, sigs.length)).toFixed(2),
      baselineP95: p95 === null ? null : +p95.toFixed(2),
      samples: st.history.length,
      calibrating,
      stale: false,
      ts: now,
    };
  } catch {
    // 403/429 or transport failure — back off a minute. Keep the last-good value but mark it stale,
    // so a rate limit degrades the needle to "stale but present" instead of hammering the RPC.
    st.backoffUntil = now + 60_000;
    st.last = { ...st.last, stale: true };
  }
}

/** Cache read for the HTTP handler — zero RPC. */
export function getHeat(now = Date.now()): HeatReading[] {
  return [...state.values()].map(({ last }) => ({
    ...last,
    stale: last.stale || last.ts === 0 || now - last.ts > STALE_AFTER_MS,
  }));
}

/** Cross-venue share of measured activity. Only EXCLUSIVE venues take part — mixing an ecosystem
 *  number into a per-venue share would silently overstate it. */
export function getShare(now = Date.now()): Record<string, number> {
  const readings = getHeat(now).filter((r) => r.exclusive && !r.stale);
  const total = readings.reduce((sum, r) => sum + r.txPerSec, 0);
  const out: Record<string, number> = {};
  for (const r of readings) out[r.venueId] = total > 0 ? +((r.txPerSec / total) * 100).toFixed(1) : 0;
  return out;
}

/** Test seam. */
export function __resetForTests(): void {
  state.clear();
  for (const v of VENUES) state.set(v.id, { venue: v, history: [], last: blank(v), backoffUntil: 0 });
}
