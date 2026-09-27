# Legible Scanner

A free Solana contract scanner. Paste a token address, find out whether the contract can **take,
freeze, tax or block** your tokens — before you buy.

Read-only. No wallet connection, ever. No key material in the process.

---

## What it answers

**"Can this contract hurt me?"** — and nothing else. Every check is a deterministic on-chain fact,
not a prediction. It will never tell you whether a coin is going up.

| Check | Why it matters |
|---|---|
| **Mint authority** | if live, supply can be inflated and your holding diluted |
| **Freeze authority** | if live, your account can be frozen — you cannot sell |
| **Transfer hook** (Token-2022) | third-party code runs on every transfer and can make it fail. A general-purpose honeypot |
| **Permanent delegate** (Token-2022) | can move or burn *anyone's* balance without their signature |
| **Transfer fee** (Token-2022) | every transfer taxed — and we report whether the rate can still be raised |
| **Default account state** | new accounts created frozen: a buyer can't move the token until thawed |
| **Non-transferable / Pausable** | the token can't be sold, or can be halted for everyone at once |
| **Holder concentration** | top-1 and top-10 share of supply |
| **Known bad actors** | authorities matched against a documented, evidence-backed list |

Most scanners stop at mint and freeze authority. **The Token-2022 extension checks are where the
modern honeypots live**, and they are invisible if you only look at the classic fields.

## Three rules the code enforces

1. **Every flag carries its evidence** — the authority key, the fee in bps, the extension. You can
   verify us instead of trusting us.
2. **A check that couldn't run reports `unknown`, never a clean pass.** A dead data source that
   returns "no flags found" reads as *safe*, and that is worse than an error.
3. **A score we can't justify is `null`.** No number is better than a confident wrong one.

## Calibration, not whitelisting

USDC holds a live mint *and* freeze authority — Circle can and does freeze balances. That is
factually a risk, but a scanner that labels USDC "DANGEROUS" teaches people to ignore the red badge,
and then they ignore it on the coin that actually robs them.

So for a handful of widely-held assets with publicly accountable issuers, the **facts are reported
identically** and only the severity is calibrated. See [`src/knownAssets.ts`](src/knownAssets.ts) —
that file suppresses warnings, so the bar for entry is deliberately high.

---

## API

```
GET /scan/:mint      full Tier-1 contract report
GET /heat/all        live activity across pump.fun, LetsBonk and Meteora DBC
GET /venues          which address each venue number is measured from, and whether it's exclusive
GET /healthz         RPC liveness + sampler state
```

Every response carries `degraded`, plus per-section `coverage`, so a client can always tell the
difference between *clean* and *unknown*.

### Example

```bash
curl https://<host>/scan/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

```json
{
  "ok": true,
  "verdict": "KNOWN ASSET — USDC, issued by Circle",
  "report": { "riskScore": 0, "flags": [ { "severity": "info", "title": "Issuer can freeze USDC balances" } ] }
}
```

## Launchpad Pulse

`/heat/all` scores each launchpad against **its own trailing p95**, not a hardcoded ceiling — so a
venue running 18 tx/s and one running 100 tx/s are both readable as "busy for them". A venue with
too little history reports `calibrating` rather than a made-up number.

Venues are only labelled as themselves when we have verified on-chain that every action on that
venue touches the sampled address *and nothing else does*. Meteora DBC is therefore reported as an
**ecosystem** figure, because Bags and others share it — see [`src/venues.ts`](src/venues.ts).

## Run it

```bash
npm install
cp .env.example .env     # set SCANNER_RPC_ENDPOINT
npm test                 # 17 tests, no network required
npm run dev
```

A dedicated RPC key is strongly recommended: this is a public tool, so its traffic is unbounded.
HTTP requests cost **zero RPC** — heat is served from a background sampler's cache and scans are
cached per mint — which is what stops a viral hour turning into a bill.

## Licence

MIT.
