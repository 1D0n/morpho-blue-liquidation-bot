import {
  KYBERSWAP_API_BASE_URL,
  KYBERSWAP_CHAIN_SLUGS,
  KYBERSWAP_SLIPPAGE_BPS,
  KYBERSWAP_SUPPORTED_NETWORKS,
} from "@morpho-blue-liquidation-bot/config";
import { ExecutorEncoder } from "executooor-viem";
import { Address } from "viem";

import { LiquidityVenue } from "../liquidityVenue";
import { ToConvert } from "../types";

import { KyberSwapError } from "./errors";
import { BuildResponse, RouteResponse } from "./types";

export { KyberSwapError } from "./errors";
export type { KyberSwapErrorKind, KyberSwapPhase } from "./errors";

// Bound Kyber's external calls so one slow response can't stall the scan.
// Observed steady-state route ~200ms, build ~300ms. Give each a healthy
// margin; total worst-case ~4s.
const ROUTE_TIMEOUT_MS = 2_000;
const BUILD_TIMEOUT_MS = 2_000;

export class KyberSwap implements LiquidityVenue {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.KYBERSWAP_API_KEY;
  }

  supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;
    return KYBERSWAP_SUPPORTED_NETWORKS.includes(encoder.client.chain.id);
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    let routeMs = 0;
    let buildMs = 0;
    const chainId = encoder.client.chain.id;
    const slug = KYBERSWAP_CHAIN_SLUGS[chainId];
    if (!slug) {
      throw new KyberSwapError(
        "route",
        "error",
        `(KyberSwap) No chain slug configured for chainId=${chainId}`,
      );
    }

    try {
      const tRouteStart = performance.now();
      const route = await this.fetchRoute(slug, toConvert.src, toConvert.dst, toConvert.srcAmount);
      routeMs = performance.now() - tRouteStart;

      if (!route.data) {
        throw new KyberSwapError(
          "route",
          "error",
          `(KyberSwap) No route (code=${route.code}, msg=${route.message})`,
        );
      }

      const tBuildStart = performance.now();
      const built = await this.fetchBuild(slug, {
        routeSummary: route.data.routeSummary,
        sender: encoder.address,
        recipient: encoder.address,
        slippageTolerance: KYBERSWAP_SLIPPAGE_BPS,
      });
      buildMs = performance.now() - tBuildStart;

      if (!built.data) {
        throw new KyberSwapError(
          "build",
          "error",
          `(KyberSwap) Build failed (code=${built.code}, msg=${built.message})`,
        );
      }

      console.log(
        `[kyberswap] chain=${chainId} status=ok route_ms=${routeMs.toFixed(0)} build_ms=${buildMs.toFixed(0)} amountOut=${built.data.amountOut}`,
      );

      encoder
        .erc20Approve(toConvert.src, built.data.routerAddress, toConvert.srcAmount)
        .pushCall(built.data.routerAddress, BigInt(built.data.transactionValue), built.data.data);

      /// assumed to be the last liquidity venue
      return {
        src: toConvert.dst,
        dst: toConvert.dst,
        srcAmount: 0n,
      };
    } catch (error) {
      const phase: "route" | "build" = routeMs === 0 ? "route" : "build";
      const kind: "timeout" | "error" =
        error instanceof Error && error.name === "AbortError" ? "timeout" : "error";
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[kyberswap] chain=${chainId} status=${kind} phase=${phase} route_ms=${routeMs.toFixed(0)} build_ms=${buildMs.toFixed(0)} err=${errMsg}`,
      );
      if (error instanceof KyberSwapError) throw error;
      throw new KyberSwapError(
        phase,
        kind,
        `(KyberSwap) fetch failed (phase=${phase}): ${errMsg}`,
        error,
      );
    }
  }

  private headers() {
    const h: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    // Kyber accepts an `x-client-id` for attribution. Reused name for any
    // future auth header Kyber introduces.
    if (this.apiKey) h["x-client-id"] = this.apiKey;
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

  private async fetchRoute(slug: string, src: Address, dst: Address, amount: bigint) {
    const url = new URL(`${KYBERSWAP_API_BASE_URL}/${slug}/api/v1/routes`);
    url.searchParams.set("tokenIn", src);
    url.searchParams.set("tokenOut", dst);
    url.searchParams.set("amountIn", amount.toString());
    const res = await this.fetchWithTimeout(
      url.toString(),
      { method: "GET", headers: this.headers() },
      ROUTE_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`route HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as RouteResponse;
  }

  private async fetchBuild(
    slug: string,
    body: {
      routeSummary: unknown;
      sender: Address;
      recipient: Address;
      slippageTolerance: number;
    },
  ) {
    const res = await this.fetchWithTimeout(
      `${KYBERSWAP_API_BASE_URL}/${slug}/api/v1/route/build`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      BUILD_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`build HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as BuildResponse;
  }
}
