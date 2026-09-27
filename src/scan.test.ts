// legible-scanner/src/scan.test.ts — node:test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMintExtensions, ExtType } from './extensions';
import { scanMint, scoreOf, verdict, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type ScanReport } from './scan';

// ── buffer builders ──────────────────────────────────────────────────────────
/** A base SPL mint. `mintAuth`/`freezeAuth` as 32-byte fills, or null for revoked. */
function baseMint(opts: { mintAuth?: number | null; freezeAuth?: number | null; supply?: bigint; decimals?: number } = {}) {
  const d = Buffer.alloc(82);
  if (opts.mintAuth != null) { d.writeUInt32LE(1, 0); d.fill(opts.mintAuth, 4, 36); }
  d.writeBigUInt64LE(opts.supply ?? 1_000_000n, 36);
  d.writeUInt8(opts.decimals ?? 6, 44);
  d.writeUInt8(1, 45);
  if (opts.freezeAuth != null) { d.writeUInt32LE(1, 46); d.fill(opts.freezeAuth, 50, 82); }
  return d;
}

/** Wrap a base mint as Token-2022 with TLV extensions appended. */
function t22Mint(base: Buffer, exts: Array<{ type: number; body: Buffer }>) {
  const head = Buffer.alloc(166);
  base.copy(head, 0);
  head.writeUInt8(1, 165); // account type = Mint
  const tlv = exts.map(({ type, body }) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0);
    h.writeUInt16LE(body.length, 2);
    return Buffer.concat([h, body]);
  });
  return Buffer.concat([head, ...tlv]);
}

const filled = (n: number, b: number) => Buffer.alloc(n, b);

// ── extension parsing ────────────────────────────────────────────────────────
test('an SPL mint reports no extensions and is not marked truncated', () => {
  const r = parseMintExtensions(baseMint(), false);
  assert.equal(r.isToken2022, false);
  assert.deepEqual(r.findings, []);
  assert.equal(r.truncated, false);
});

test('transfer hook is flagged critical — the general-purpose honeypot', () => {
  const d = t22Mint(baseMint(), [{ type: ExtType.TransferHook, body: Buffer.concat([filled(32, 1), filled(32, 2)]) }]);
  const r = parseMintExtensions(d, true);
  const hook = r.findings.find((f) => f.ext === 'TransferHook');
  assert.ok(hook);
  assert.equal(hook!.severity, 'critical');
  assert.match(hook!.meaning, /EVERY transfer/);
});

test('permanent delegate is flagged critical — balances can be seized', () => {
  const d = t22Mint(baseMint(), [{ type: ExtType.PermanentDelegate, body: filled(32, 7) }]);
  const r = parseMintExtensions(d, true);
  const f = r.findings.find((x) => x.ext === 'PermanentDelegate');
  assert.equal(f?.severity, 'critical');
  assert.match(f!.meaning, /without their signature/);
});

test('default-account-state frozen is critical, initialized is not flagged', () => {
  const frozen = parseMintExtensions(t22Mint(baseMint(), [{ type: ExtType.DefaultAccountState, body: Buffer.from([2]) }]), true);
  assert.equal(frozen.findings.find((f) => f.ext.startsWith('DefaultAccountState'))?.severity, 'critical');
  const normal = parseMintExtensions(t22Mint(baseMint(), [{ type: ExtType.DefaultAccountState, body: Buffer.from([1]) }]), true);
  assert.equal(normal.findings.find((f) => f.ext.startsWith('DefaultAccountState')), undefined);
});

test('transfer fee severity depends on whether the fee authority is revoked', () => {
  const withAuth = parseMintExtensions(
    t22Mint(baseMint(), [{ type: ExtType.TransferFeeConfig, body: Buffer.concat([filled(32, 1), filled(32, 9), filled(44, 0)]) }]),
    true,
  );
  assert.equal(withAuth.findings.find((f) => f.ext === 'TransferFee')?.severity, 'critical');

  const revoked = parseMintExtensions(
    t22Mint(baseMint(), [{ type: ExtType.TransferFeeConfig, body: Buffer.concat([filled(32, 1), filled(32, 0), filled(44, 0)]) }]),
    true,
  );
  assert.equal(revoked.findings.find((f) => f.ext === 'TransferFee')?.severity, 'warn');
});

test('mint close authority is info, not a holder risk', () => {
  const r = parseMintExtensions(t22Mint(baseMint(), [{ type: ExtType.MintCloseAuthority, body: filled(32, 3) }]), true);
  assert.equal(r.findings.find((f) => f.ext === 'MintCloseAuthority')?.severity, 'info');
});

test('a malformed TLV sets truncated so the report can say "unknown" rather than "clean"', () => {
  const head = Buffer.alloc(166);
  baseMint().copy(head, 0);
  head.writeUInt8(1, 165);
  const bad = Buffer.alloc(4);
  bad.writeUInt16LE(ExtType.TransferHook, 0);
  bad.writeUInt16LE(999, 2); // claims 999 bytes that aren't there
  const r = parseMintExtensions(Buffer.concat([head, bad]), true);
  assert.equal(r.truncated, true);
});

// ── scan orchestration ───────────────────────────────────────────────────────
const toBase58 = (b: Buffer) => 'K' + b[0].toString().padStart(2, '0');

function fakeRpc(account: any, largest: Array<{ address: string; amount: string }> = []) {
  return {
    async getAccount() { return account; },
    async getTokenLargestAccounts() { return largest; },
  } as any;
}

test('a revoked-authority SPL mint with no extensions scores 0 and reads clean', async () => {
  const r = await scanMint('M', {
    rpc: fakeRpc({ owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: baseMint({ supply: 1000n }) },
      [{ address: 'a', amount: '100' }]),
    toBase58,
  });
  assert.equal(r.found, true);
  assert.equal(r.tokenProgram, 'spl');
  assert.equal(r.authorities.mintAuthority, null);
  assert.equal(r.authorities.freezeAuthority, null);
  assert.equal(r.riskScore, 0);
  assert.match(verdict(r), /CLEAN MECHANICS/);
});

test('live mint and freeze authorities each raise a critical flag with evidence', async () => {
  const r = await scanMint('M', {
    rpc: fakeRpc({ owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: baseMint({ mintAuth: 5, freezeAuth: 6, supply: 1000n }) }),
    toBase58,
  });
  const ids = r.flags.map((f) => f.id);
  assert.ok(ids.includes('mint-authority-live'));
  assert.ok(ids.includes('freeze-authority-live'));
  assert.ok(r.flags.every((f) => f.severity !== 'critical' || f.evidence), 'every critical flag must carry evidence');
  assert.equal(r.riskScore, 60);
  assert.match(verdict(r), /DANGEROUS/);
});

test('a known bad actor as an authority is surfaced with its evidence trail', async () => {
  const r = await scanMint('M', {
    rpc: fakeRpc({ owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: baseMint({ mintAuth: 5, supply: 1000n }) }),
    toBase58,
    knownActor: (a) => (a === 'K05' ? { label: 'honeypot mill deployer', evidence: 'forensics/REV1.md' } : null),
  });
  const hit = r.flags.find((f) => f.id === 'known-actor');
  assert.ok(hit, 'expected the known-actor flag');
  assert.match(hit!.evidence || '', /forensics/);
});

test('a non-mint address is reported as such rather than scanned', async () => {
  const r = await scanMint('M', {
    rpc: fakeRpc({ owner: '11111111111111111111111111111111', lamports: 1, executable: false, data: Buffer.alloc(0) }),
    toBase58,
  });
  assert.equal(r.found, false);
  assert.equal(r.flags[0].id, 'not-a-mint');
});

test('a missing account is degraded, not clean', async () => {
  const r = await scanMint('M', { rpc: fakeRpc(null), toBase58 });
  assert.equal(r.found, false);
  assert.equal(r.degraded, true);
  assert.equal(r.riskScore, null);
});

test('a failed holder lookup reports UNKNOWN coverage and degrades the report', async () => {
  const rpc = {
    async getAccount() { return { owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: baseMint({ supply: 1000n }) }; },
    async getTokenLargestAccounts() { throw new Error('429'); },
  } as any;
  const r = await scanMint('M', { rpc, toBase58 });
  assert.equal(r.holders.coverage, 'unknown');
  assert.equal(r.degraded, true);
  assert.match(r.holders.note || '', /not safe/);
});

test('score is null when neither authorities nor extensions could be read', () => {
  const stub = {
    authorities: { coverage: 'unknown' }, extensions: { coverage: 'unknown' }, flags: [],
  } as unknown as ScanReport;
  assert.equal(scoreOf(stub), null);
  assert.match(verdict({ ...stub, riskScore: null } as ScanReport), /UNKNOWN/);
});

test('the score is explicitly framed as mechanics, not price prediction', async () => {
  const r = await scanMint('M', {
    rpc: fakeRpc({ owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: baseMint({ supply: 1000n }) }),
    toBase58,
  });
  assert.match(r.scoreMeaning, /NOTHING about whether the price/);
});

// ── known-asset calibration (regression: USDC scored DANGEROUS on the first control run) ──
test('a known issuer asset reports the capability but is not called dangerous', async () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const r = await scanMint(USDC, {
    rpc: fakeRpc({ owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: baseMint({ mintAuth: 5, freezeAuth: 6, supply: 1000n }) }),
    toBase58,
  });
  assert.equal(r.knownAsset?.name, 'USDC');
  // the FACTS are unchanged — both authorities are still reported, with evidence
  assert.equal(r.authorities.mintAuthority, 'K05');
  assert.equal(r.authorities.freezeAuthority, 'K06');
  assert.ok(r.flags.find((f) => f.id === 'freeze-authority-live'));
  // only the severity is calibrated
  assert.ok(r.flags.every((f) => f.severity !== 'critical'), 'a disclosed issuer power is not a critical flag');
  assert.match(verdict(r), /KNOWN ASSET/);
});

test('an unknown mint with the same authorities is still critical', async () => {
  const r = await scanMint('SomeRandomMemecoinMint1111111111111111111111', {
    rpc: fakeRpc({ owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: baseMint({ mintAuth: 5, freezeAuth: 6, supply: 1000n }) }),
    toBase58,
  });
  assert.equal(r.knownAsset, undefined);
  assert.equal(r.riskScore, 60);
  assert.match(verdict(r), /DANGEROUS/);
});
