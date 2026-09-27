// legible-scanner/src/server.ts
// ─────────────────────────────────────────────────────────────────────────────
// LEGIBLE SCANNER — public, free, read-only API.
//
// Phase 0: the Launchpad Pulse (`GET /heat/all`). Phase 1 adds `GET /scan/:mint`.
//
// Design constraints that are NOT negotiable (docs/SCANNER-PLAN.md §0):
//   • No key material in this process. It reads chain and nothing else — see rpc.ts.
//   • An HTTP request costs ZERO RPC. Background samplers write a cache; handlers read it. A viral
//     day therefore cannot multiply into RPC spend, which is the failure mode that took out the
//     shared Helius key on 2026-08-29.
//   • Samplers are STAGGERED and slow by default (45s), env-tunable.
//   • Degrade loudly: `stale` and `calibrating` travel with every reading so a client can never
//     render an unknown as a confident zero.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import bs58 from 'bs58';
import { VENUES } from './venues';
import { getHeat, getShare, sampleVenue } from './heat';
import { SolanaRpc } from './rpc';
import { scanMint, verdict, type ScanReport } from './scan';
import { knownActor } from './actors';

const PORT = Number(process.env.SCANNER_PORT || 8810);
const SAMPLE_MS = Math.max(15_000, Number(process.env.SCANNER_SAMPLE_MS || 45_000));
const RPC_URL = process.env.SCANNER_RPC_ENDPOINT || process.env.RPC_ENDPOINT || '';

// ── crude per-IP rate limit ───────────────────────────────────────────────────
// Handlers are cache-only so this protects CPU/bandwidth, not the RPC budget. Fixed window is fine
// at this scale; swap for a shared store only if the service is ever run multi-instance.
const RATE_MAX = Number(process.env.SCANNER_RATE_MAX || 120); // requests per window per IP
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, { n: number; resetAt: number }>();

function rateLimited(ip: string, now = Date.now()): boolean {
  const cur = hits.get(ip);
  if (!cur || now > cur.resetAt) {
    hits.set(ip, { n: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  cur.n += 1;
  return cur.n > RATE_MAX;
}
// Bound the map so a spray of spoofed IPs can't grow it without limit.
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of hits) if (now > v.resetAt) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

function send(res: http.ServerResponse, status: number, body: unknown, cacheSeconds = 0): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*', // public read-only API; the browser extension needs this
    'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

const rpc = RPC_URL ? new SolanaRpc(RPC_URL) : null;

const server = http.createServer(async (req, res) => {
  const ip = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    });
    return res.end();
  }
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' });
  if (rateLimited(ip)) return send(res, 429, { ok: false, error: 'rate limited' });

  switch (path) {
    case '/':
      return send(res, 200, {
        ok: true,
        service: 'legible-scanner',
        chain: 'solana',
        routes: ['GET /scan/:mint', 'GET /heat/all', 'GET /venues', 'GET /healthz'],
      });

    case '/venues':
      // Publishing the provenance is the point: anyone can re-verify our numbers, and a
      // non-exclusive venue carries the note explaining what it actually measures.
      return send(res, 200, { ok: true, venues: VENUES }, 3600);

    case '/heat/all': {
      const venues = getHeat();
      return send(res, 200, {
        ok: true,
        ts: Date.now(),
        venues,
        // Share is over exclusive venues only — see heat.ts.
        share: getShare(),
        // Surfaced so a client never has to guess why a number is missing.
        degraded: venues.some((v) => v.stale) || venues.some((v) => v.calibrating),
      });
    }

    case '/scan': {
      // /scan?mint=… (and /scan/<mint> below) — Tier-1 on-chain contract scan.
      const mint = url.searchParams.get('mint') || '';
      return sendScan(res, mint);
    }

    case '/healthz': {
      if (!rpc) return send(res, 503, { ok: false, error: 'no RPC configured' });
      try {
        const slot = await rpc.getSlot();
        const venues = getHeat();
        return send(res, 200, {
          ok: true,
          slot,
          sampleIntervalMs: SAMPLE_MS,
          venues: venues.map((v) => ({
            id: v.venueId,
            samples: v.samples,
            stale: v.stale,
            calibrating: v.calibrating,
          })),
        });
      } catch (e: unknown) {
        return send(res, 503, { ok: false, error: (e as Error)?.message || 'rpc unreachable' });
      }
    }

    default: {
      const m = /^\/scan\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
      if (m) return sendScan(res, m[1]);
      return send(res, 404, { ok: false, error: 'not found' });
    }
  }
});

// ── scan cache ────────────────────────────────────────────────────────────────
// 60s TTL keyed by mint. A free public tool gets the same handful of trending mints hammered by
// everyone at once, so this is what keeps a viral hour from multiplying into RPC spend.
const SCAN_TTL_MS = Math.max(10_000, Number(process.env.SCANNER_SCAN_TTL_MS || 60_000));
const SCAN_CACHE_MAX = 500;
const scanCache = new Map<string, { at: number; report: ScanReport }>();

async function sendScan(res: http.ServerResponse, mint: string): Promise<void> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return send(res, 400, { ok: false, error: 'mint must be a base58 Solana address' });
  }
  if (!rpc) return send(res, 503, { ok: false, error: 'no RPC configured' });

  const hit = scanCache.get(mint);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) {
    return send(res, 200, { ok: true, cached: true, verdict: verdict(hit.report), report: hit.report });
  }
  try {
    const report = await scanMint(mint, {
      rpc,
      toBase58: (b) => bs58.encode(b),
      knownActor: (a) => {
        const k = knownActor(a);
        return k ? { label: k.label, evidence: k.evidence } : null;
      },
    });
    if (scanCache.size >= SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value as string);
    scanCache.set(mint, { at: Date.now(), report });
    return send(res, 200, { ok: true, cached: false, verdict: verdict(report), report });
  } catch (e: unknown) {
    // Never fabricate a clean result from a failed scan.
    return send(res, 502, { ok: false, error: (e as Error)?.message || 'scan failed' });
  }
}

/**
 * Start one timer per venue, evenly staggered across the sample interval, so we never fire N
 * simultaneous RPC calls. Same total rate, flat instead of spiky.
 */
export function startSamplers(): void {
  if (!rpc) {
    console.warn('[scanner] no RPC endpoint — heat samplers disabled; /heat/all will report stale');
    return;
  }
  VENUES.forEach((v, i) => {
    const offset = Math.round((SAMPLE_MS / VENUES.length) * i);
    setTimeout(() => {
      void sampleVenue(rpc, v.id);
      setInterval(() => void sampleVenue(rpc, v.id), SAMPLE_MS).unref();
    }, offset).unref();
  });
  console.log(
    `[scanner] sampling ${VENUES.length} venues every ${SAMPLE_MS / 1000}s (staggered ${Math.round(
      SAMPLE_MS / VENUES.length / 1000,
    )}s apart)`,
  );
}

if (require.main === module) {
  startSamplers();
  server.listen(PORT, () => console.log(`[scanner] listening on :${PORT}`));
}

export { server };
