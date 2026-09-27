// legible-scanner/src/extensions.ts
// ─────────────────────────────────────────────────────────────────────────────
// TOKEN-2022 EXTENSION PARSER — the highest-value check in the whole scanner, and the one almost
// nobody does properly. A Token-2022 mint can carry extensions that let its authority tax, freeze,
// pause, or outright SEIZE a holder's balance, or run arbitrary code on every transfer. None of that
// is visible from supply/authority fields, which is what most "rug checkers" stop at.
//
// Layout: a Token-2022 mint is the 82-byte SPL base, zero-padded to 165, then an account-type byte
// at [165], then TLV entries from 166 — each `u16 type, u16 length, <length bytes>`. The padding to
// 165 exists to disambiguate a mint from a 165-byte token account, so the offsets are fixed.
//
// Pure + synchronous so it is fully unit-testable without an RPC.
// ─────────────────────────────────────────────────────────────────────────────

/** Token-2022 extension discriminators we care about. */
export enum ExtType {
  TransferFeeConfig = 1,
  MintCloseAuthority = 3,
  ConfidentialTransferMint = 4,
  DefaultAccountState = 6,
  NonTransferable = 9,
  InterestBearingConfig = 10,
  PermanentDelegate = 12,
  TransferHook = 14,
  MetadataPointer = 18,
  TokenMetadata = 19,
  Pausable = 25,
}

export type Severity = 'critical' | 'warn' | 'info';

export interface ExtensionFinding {
  ext: string;
  severity: Severity;
  /** plain-language: what the holder's actual exposure is, not the spec wording */
  meaning: string;
  /** the value that proves it (an authority pubkey, a fee bps, …) so the flag is auditable */
  evidence?: string;
}

export interface ParsedExtensions {
  isToken2022: boolean;
  findings: ExtensionFinding[];
  /** raw types present, for debugging and for surfacing ones we do not yet interpret */
  present: number[];
  /** true if the TLV walk hit something malformed — the report must then say "unknown", not "clean" */
  truncated: boolean;
}

const MINT_PADDED = 165;
const TLV_START = 166;

function readPubkey(d: Buffer, off: number): string | null {
  if (off + 32 > d.length) return null;
  // base58 is done by the caller when it has bs58; here we keep it hex-free and cheap by
  // reporting presence. The scan layer swaps in the base58 form for display.
  return d.subarray(off, off + 32).toString('hex');
}

/** COption<Pubkey> in Token-2022 extension bodies is a 32-byte key where all-zero means None. */
function optionalKey(d: Buffer, off: number): string | null {
  const hex = readPubkey(d, off);
  if (!hex || /^0{64}$/.test(hex)) return null;
  return hex;
}

/**
 * Parse a mint account's Token-2022 extensions.
 * `owner` is the account's owner program id; anything that is not Token-2022 returns cleanly.
 */
export function parseMintExtensions(data: Buffer, isToken2022: boolean): ParsedExtensions {
  const out: ParsedExtensions = { isToken2022, findings: [], present: [], truncated: false };
  if (!isToken2022 || data.length <= TLV_START) return out;

  let off = TLV_START;
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    if (type === 0 && len === 0) break; // uninitialised padding — normal end of list
    const body = off + 4;
    if (body + len > data.length) {
      out.truncated = true;
      break;
    }
    out.present.push(type);

    switch (type) {
      case ExtType.TransferFeeConfig: {
        // { withdrawWithheldAuthority(32), transferFeeConfigAuthority(32), withheld(8),
        //   older: epoch(8) maxFee(8) bps(2), newer: epoch(8) maxFee(8) bps(2) }
        // The NEWER config is what applies going forward; read its bps at a fixed tail offset.
        const bpsOff = body + 32 + 32 + 8 + 18 + 16;
        const bps = bpsOff + 2 <= data.length ? data.readUInt16LE(bpsOff) : null;
        const authority = optionalKey(data, body + 32);
        out.findings.push({
          ext: 'TransferFee',
          severity: authority ? 'critical' : 'warn',
          meaning: authority
            ? 'Every transfer is taxed, and an authority can still CHANGE the fee — it can be raised after you buy.'
            : 'Every transfer is taxed. The fee authority is revoked, so the rate cannot be raised.',
          evidence: bps === null ? 'fee config present' : `${bps} bps (${(bps / 100).toFixed(2)}%)`,
        });
        break;
      }
      case ExtType.TransferHook: {
        const programId = optionalKey(data, body + 32);
        out.findings.push({
          ext: 'TransferHook',
          severity: 'critical',
          meaning:
            'A third-party program runs on EVERY transfer and can make it fail. This is a general-purpose honeypot: selling can be disabled for you specifically, at any time.',
          evidence: programId ? `hook program set (${programId.slice(0, 16)}…)` : 'hook authority present',
        });
        break;
      }
      case ExtType.PermanentDelegate: {
        out.findings.push({
          ext: 'PermanentDelegate',
          severity: 'critical',
          meaning:
            'A permanent delegate can transfer or burn ANY holder\'s balance without their signature. Your tokens can be taken.',
          evidence: optionalKey(data, body) ? 'delegate set' : 'extension present',
        });
        break;
      }
      case ExtType.DefaultAccountState: {
        // body[0]: 0 Uninitialized, 1 Initialized, 2 Frozen
        const state = len >= 1 ? data.readUInt8(body) : -1;
        if (state === 2) {
          out.findings.push({
            ext: 'DefaultAccountState=Frozen',
            severity: 'critical',
            meaning:
              'New token accounts are created FROZEN by default — a buyer cannot move the token until the authority thaws them individually.',
            evidence: 'default state = frozen',
          });
        }
        break;
      }
      case ExtType.NonTransferable: {
        out.findings.push({
          ext: 'NonTransferable',
          severity: 'critical',
          meaning: 'This token cannot be transferred at all. It can never be sold.',
        });
        break;
      }
      case ExtType.Pausable: {
        out.findings.push({
          ext: 'Pausable',
          severity: 'critical',
          meaning: 'An authority can pause ALL transfers of this token at will, freezing every holder at once.',
          evidence: optionalKey(data, body) ? 'pause authority set' : 'extension present',
        });
        break;
      }
      case ExtType.ConfidentialTransferMint: {
        out.findings.push({
          ext: 'ConfidentialTransfer',
          severity: 'warn',
          meaning: 'Balances and transfers can be hidden, so holder concentration cannot be verified from chain.',
        });
        break;
      }
      case ExtType.InterestBearingConfig: {
        out.findings.push({
          ext: 'InterestBearing',
          severity: 'warn',
          meaning:
            'The displayed balance grows by a rate the authority sets. The UI amount is cosmetic — it does not mean you are gaining value.',
        });
        break;
      }
      case ExtType.MintCloseAuthority: {
        out.findings.push({
          ext: 'MintCloseAuthority',
          severity: 'info',
          meaning: 'The mint account can be closed once supply reaches zero. Not a holder risk.',
        });
        break;
      }
      default:
        break; // metadata/pointer/group extensions are benign; `present` still records them
    }
    off = body + len;
  }
  return out;
}

/** Worst severity across findings, or null when there is nothing to report. */
export function worstSeverity(f: ExtensionFinding[]): Severity | null {
  if (f.some((x) => x.severity === 'critical')) return 'critical';
  if (f.some((x) => x.severity === 'warn')) return 'warn';
  return f.length ? 'info' : null;
}
