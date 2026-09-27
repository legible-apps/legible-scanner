// legible-scanner/src/rpc.ts
// Minimal Solana JSON-RPC client — plain fetch, no @solana/web3.js.
//
// The scanner only ever READS, so it needs a fraction of web3.js. Keeping it dependency-light means
// the service starts fast, has a tiny attack surface, and can never accidentally sign anything:
// there is no Keypair type in this process at all. That property is worth more than the convenience.
import type { SignatureFetcher } from './heat';

export class SolanaRpc implements SignatureFetcher {
  constructor(private readonly url: string) {
    if (!url) throw new Error('[scanner] SCANNER_RPC_ENDPOINT (or RPC_ENDPOINT) is required');
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    // Surface transport-level rate limiting as a throw so the caller's backoff engages.
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message || 'rpc error'}`);
    return body.result as T;
  }

  async getSignaturesForAddress(address: string, limit: number) {
    return this.call<Array<{ blockTime?: number | null; err?: unknown }>>(
      'getSignaturesForAddress',
      [address, { limit }],
    );
  }

  /** Liveness probe used by /healthz — cheap and cacheable upstream. */
  async getSlot(): Promise<number> {
    return this.call<number>('getSlot', []);
  }

  /** Raw account, base64-decoded. Null when the account does not exist. */
  async getAccount(address: string): Promise<RawAccount | null> {
    const r = await this.call<{ value: RpcAccount | null }>('getAccountInfo', [
      address,
      { encoding: 'base64' },
    ]);
    if (!r?.value) return null;
    return {
      owner: r.value.owner,
      lamports: r.value.lamports,
      executable: r.value.executable,
      data: Buffer.from(r.value.data[0], 'base64'),
    };
  }

  /** Several accounts in one round trip — same order as the input. */
  async getAccounts(addresses: string[]): Promise<Array<RawAccount | null>> {
    if (!addresses.length) return [];
    const r = await this.call<{ value: Array<RpcAccount | null> }>('getMultipleAccounts', [
      addresses,
      { encoding: 'base64' },
    ]);
    return (r?.value || []).map((v) =>
      v ? { owner: v.owner, lamports: v.lamports, executable: v.executable, data: Buffer.from(v.data[0], 'base64') } : null,
    );
  }

  /** Top token accounts by balance — the basis for the concentration check. Capped at 20 by the RPC. */
  async getTokenLargestAccounts(mint: string): Promise<Array<{ address: string; amount: string }>> {
    const r = await this.call<{ value: Array<{ address: string; amount: string }> }>(
      'getTokenLargestAccounts',
      [mint],
    );
    return r?.value || [];
  }

  async getTokenSupply(mint: string): Promise<{ amount: string; decimals: number } | null> {
    const r = await this.call<{ value: { amount: string; decimals: number } }>('getTokenSupply', [mint]);
    return r?.value || null;
  }

  /** Oldest-first signatures for an address, used for age and authority timeline. */
  async getSignatures(address: string, limit: number) {
    return this.call<Array<{ signature: string; blockTime?: number | null; err?: unknown }>>(
      'getSignaturesForAddress',
      [address, { limit }],
    );
  }
}

interface RpcAccount {
  owner: string;
  lamports: number;
  executable: boolean;
  data: [string, string];
}

export interface RawAccount {
  owner: string;
  lamports: number;
  executable: boolean;
  data: Buffer;
}
