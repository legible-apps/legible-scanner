// legible-scanner/src/heat.test.ts — node:test. Run: npm test (from legible-scanner/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  scaleAgainstBaseline,
  prune,
  sampleVenue,
  getHeat,
  getShare,
  __resetForTests,
  BASELINE_WINDOW_MS,
  MIN_SAMPLES_FOR_BASELINE,
  type SignatureFetcher,
} from './heat';

/** A fetcher that returns `count` signatures spread evenly over `spanSec`. */
function fakeFetcher(count: number, spanSec: number, opts: { fails?: number; throws?: boolean } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    async getSignaturesForAddress() {
      if (opts.throws) throw new Error('HTTP 429');
      return Array.from({ length: count }, (_, i) => ({
        blockTime: nowSec - Math.round((i * spanSec) / Math.max(1, count - 1)),
        err: i < (opts.fails || 0) ? {} : undefined,
      }));
    },
  } satisfies SignatureFetcher;
}

test('percentile uses nearest-rank and handles edges', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([10, 1, 5, 3], 50), 3);
});

test('heat is scored against the venue own baseline, not a fixed ceiling', () => {
  // The whole point of the rolling baseline: two venues at very different absolute rates should
  // both read "busy" when they are busy FOR THEM. A fixed LO/HI made the slow venue look dead.
  const pumpish = scaleAgainstBaseline(100, 100); // at its own p95
  const bonkish = scaleAgainstBaseline(18, 18); // at its own p95
  assert.equal(pumpish, bonkish);
  assert.equal(pumpish, 95, 'p95 maps to ~95, leaving headroom for an exceptional day');
});

test('heat leaves headroom above p95 instead of pegging', () => {
  const atP95 = scaleAgainstBaseline(100, 100);
  const double = scaleAgainstBaseline(200, 100);
  assert.ok(double > atP95, 'an exceptional day must still register');
  assert.ok(double <= 100);
});

test('heat floors out well below the baseline', () => {
  assert.equal(scaleAgainstBaseline(1, 100), 0, 'two decades below p95 reads as cold');
  assert.equal(scaleAgainstBaseline(0, 100), 0);
  assert.equal(scaleAgainstBaseline(50, 0), 0, 'no baseline yet ⇒ no claim');
});

test('prune drops samples outside the baseline window', () => {
  const now = Date.now();
  const history: Array<[number, number]> = [
    [now - BASELINE_WINDOW_MS - 1000, 1],
    [now - 1000, 2],
    [now, 3],
  ];
  assert.deepEqual(prune(history, now), [
    [now - 1000, 2],
    [now, 3],
  ]);
});

test('a fresh venue reports calibrating with a null heat, never a confident zero', async () => {
  __resetForTests();
  await sampleVenue(fakeFetcher(300, 10), 'pumpfun');
  const r = getHeat().find((v) => v.venueId === 'pumpfun')!;
  assert.equal(r.calibrating, true);
  assert.equal(r.heat, null, 'an unjustifiable number must be absent, not zero');
  assert.equal(r.baselineP95, null);
  assert.ok(r.txPerSec > 0, 'the raw rate is still reported while calibrating');
  assert.equal(r.stale, false);
});

test('heat becomes available once enough samples exist', async () => {
  __resetForTests();
  for (let i = 0; i < MIN_SAMPLES_FOR_BASELINE; i++) await sampleVenue(fakeFetcher(300, 10), 'pumpfun');
  const r = getHeat().find((v) => v.venueId === 'pumpfun')!;
  assert.equal(r.calibrating, false);
  assert.equal(typeof r.heat, 'number');
  assert.ok(r.baselineP95! > 0);
  assert.equal(r.samples, MIN_SAMPLES_FOR_BASELINE);
});

test('an RPC failure backs off and serves last-good as stale, never blanks the gauge', async () => {
  __resetForTests();
  for (let i = 0; i < MIN_SAMPLES_FOR_BASELINE; i++) await sampleVenue(fakeFetcher(300, 10), 'pumpfun');
  const good = getHeat().find((v) => v.venueId === 'pumpfun')!;

  await sampleVenue(fakeFetcher(0, 0, { throws: true }), 'pumpfun');
  const after = getHeat().find((v) => v.venueId === 'pumpfun')!;
  assert.equal(after.stale, true, 'a 429 must be visible to the client');
  assert.equal(after.txPerSec, good.txPerSec, 'last-good value is retained, not zeroed');
});

test('one broken venue does not affect the others', async () => {
  __resetForTests();
  await sampleVenue(fakeFetcher(0, 0, { throws: true }), 'pumpfun');
  await sampleVenue(fakeFetcher(300, 10), 'letsbonk');
  const bonk = getHeat().find((v) => v.venueId === 'letsbonk')!;
  assert.equal(bonk.stale, false);
  assert.ok(bonk.txPerSec > 0);
});

test('failRatio is reported from the sampled signatures', async () => {
  __resetForTests();
  await sampleVenue(fakeFetcher(100, 10, { fails: 25 }), 'pumpfun');
  const r = getHeat().find((v) => v.venueId === 'pumpfun')!;
  assert.equal(r.failRatio, 0.25);
});

test('a venue with too few timestamped sigs reads idle, not broken, and does not poison history', async () => {
  __resetForTests();
  await sampleVenue(fakeFetcher(1, 0), 'pumpfun');
  const r = getHeat().find((v) => v.venueId === 'pumpfun')!;
  assert.equal(r.stale, false, 'reachable-but-idle is not an outage');
  assert.equal(r.samples, 0, 'an unmeasurable sample must not enter the baseline');
});

test('share covers exclusive venues only, so an ecosystem number is never sold as a venue share', async () => {
  __resetForTests();
  await sampleVenue(fakeFetcher(300, 10), 'pumpfun'); // exclusive
  await sampleVenue(fakeFetcher(300, 10), 'letsbonk'); // exclusive
  await sampleVenue(fakeFetcher(300, 10), 'meteora-dbc'); // NOT exclusive
  const share = getShare();
  assert.ok(share.pumpfun && share.letsbonk);
  assert.equal(share['meteora-dbc'], undefined, 'shared-ecosystem venue must be excluded from share');
  assert.equal(Math.round(share.pumpfun + share.letsbonk), 100);
});

test('readings carry the ecosystem note for non-exclusive venues', () => {
  __resetForTests();
  const dbc = getHeat().find((v) => v.venueId === 'meteora-dbc')!;
  assert.equal(dbc.exclusive, false);
  assert.match(dbc.ecosystemNote || '', /not any single venue/i);
});

test('a never-sampled venue is stale', () => {
  __resetForTests();
  assert.ok(getHeat().every((v) => v.stale));
});
