import {
  ODOS_API_BASE_URL,
  ODOS_SLIPPAGE_PERCENT,
  ODOS_SUPPORTED_NETWORKS,
} from "@morpho-blue-liquidation-bot/config";
import { ExecutorEncoder } from "executooor-viem";
import { Address } from "viem";

import { LiquidityVenue } from "../liquidityVenue";
import { ToConvert } from "../types";

import { AssembleRequest, AssembleResponse, QuoteRequest, QuoteResponse } from "./types";

// Bound Odos's external calls so one slow response can't stall the whole
// liquidation scan. Quote (route discovery) is the heavy one; assemble is a
// deterministic calldata build and should return quickly.
const QUOTE_TIMEOUT_MS = 4_000;
const ASSEMBLE_TIMEOUT_MS = 2_000;

export class Odos implements LiquidityVenue {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.ODOS_API_KEY;
  }

  supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;
    return ODOS_SUPPORTED_NETWORKS.includes(encoder.client.chain.id);
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    // Phase markers let the catch block tell which call failed.
    let quoteMs = 0;
    let assembleMs = 0;
    try {
      const tQuoteStart = performance.now();
      const quote = await this.fetchQuote({
        chainId: encoder.client.chain.id,
        src: toConvert.src,
        dst: toConvert.dst,
        amount: toConvert.srcAmount,
        userAddr: encoder.address,
      });
      quoteMs = performance.now() - tQuoteStart;

      const tAssembleStart = performance.now();
      const assembled = await this.fetchAssemble({
        pathId: quote.pathId,
        userAddr: encoder.address,
      });
      assembleMs = performance.now() - tAssembleStart;

      console.log(
        `[odos] chain=${encoder.client.chain.id} status=ok quote_ms=${quoteMs.toFixed(0)} assemble_ms=${assembleMs.toFixed(0)} pathId=${quote.pathId.slice(0, 10)}`,
      );

      encoder
        .erc20Approve(toConvert.src, assembled.transaction.to, toConvert.srcAmount)
        .pushCall(
          assembled.transaction.to,
          BigInt(assembled.transaction.value),
          assembled.transaction.data,
        );

      /// assumed to be the last liquidity venue
      return {
        src: toConvert.dst,
        dst: toConvert.dst,
        srcAmount: 0n,
      };
    } catch (error) {
      const phase = quoteMs === 0 ? "quote" : "assemble";
      const kind = error instanceof Error && error.name === "AbortError" ? "timeout" : "error";
      console.warn(
        `[odos] chain=${encoder.client.chain.id} status=${kind} phase=${phase} quote_ms=${quoteMs.toFixed(0)} assemble_ms=${assembleMs.toFixed(0)} err=${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        `(Odos) Error fetching swap (phase=${phase}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private headers() {
    const h: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchQuote(p: QuoteRequest): Promise<QuoteResponse> {
    const res = await this.fetchWithTimeout(
      `${ODOS_API_BASE_URL}/sor/quote/v2`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          chainId: p.chainId,
          inputTokens: [{ tokenAddress: p.src, amount: p.amount.toString() }],
          outputTokens: [{ tokenAddress: p.dst, proportion: 1 }],
          userAddr: p.userAddr,
          slippageLimitPercent: ODOS_SLIPPAGE_PERCENT,
        }),
      },
      QUOTE_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`quote HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as QuoteResponse;
  }

  private async fetchAssemble(p: AssembleRequest): Promise<AssembleResponse> {
    const res = await this.fetchWithTimeout(
      `${ODOS_API_BASE_URL}/sor/assemble`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          userAddr: p.userAddr,
          pathId: p.pathId,
          simulate: false,
        }),
      },
      ASSEMBLE_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`assemble HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as AssembleResponse;
  }
}
