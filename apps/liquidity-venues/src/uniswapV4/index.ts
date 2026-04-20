import {
  DEPLOYMENTS,
  UNISWAP_V4_DEFAULT_POOL_KEY_PROBES,
  UNISWAP_V4_POOL_KEY_PROBES,
  type UniswapV4PoolKeyProbe,
} from "@morpho-blue-liquidation-bot/config";
import { CommandType, RoutePlanner } from "@uniswap/universal-router-sdk";
import { Actions, type PoolKey, V4Planner } from "@uniswap/v4-sdk";
import type { ExecutorEncoder } from "executooor-viem";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  maxUint256,
  maxUint48,
  type ValueOf,
  zeroAddress,
} from "viem";
import { getContractEvents, multicall, readContract } from "viem/actions";

import { permit2Abi } from "../abis/permit2";
import {
  uniswapUniversalRouterAbi,
  uniswapV4PoolManagerAbi,
  uniswapV4StateViewAbi,
} from "../abis/uniswapV4";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";

interface PoolKeyData {
  id: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

const POOL_KEY_ABI_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

function computePoolId(
  currency0: Address,
  currency1: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(POOL_KEY_ABI_PARAMS, [{ currency0, currency1, fee, tickSpacing, hooks }]),
  );
}

export class UniswapV4Venue implements LiquidityVenue {
  private STALE_TIME = 60 * 60 * 1000; // 1 hour
  /**
   * Single per-pair pool cache used by both discovery paths. Keyed by
   * `${currency0}${currency1}` (ordered numerically, same convention as the
   * fetchPools caller).
   */
  private poolsCache: Record<Hex, { pools: PoolKeyData[]; lastUpdate: number }> = {};

  supportsRoute(
    encoder: ExecutorEncoder,
    _src: Address,
    _dst: Address,
  ): Promise<boolean> | boolean {
    return DEPLOYMENTS[encoder.client.chain.id] !== undefined;
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src: rawSrc, dst: rawDst, srcAmount } = toConvert;

    const deployments = DEPLOYMENTS[encoder.client.chain.id];
    if (!deployments) return toConvert;
    const { PoolManager, StateView, UniversalRouter, Native } = deployments;

    // Uniswap v4 operates on ETH natively
    const shouldUnwrap = rawSrc === Native.address;
    const shouldWrap = rawDst === Native.address;
    const src = shouldUnwrap ? zeroAddress : rawSrc;
    const dst = shouldWrap ? zeroAddress : rawDst;

    const { currency0, currency1, pools } = await this.fetchPools(encoder, PoolManager, src, dst);
    if (pools.length === 0) return toConvert;

    let liquidities: (
      | {
          error: Error;
          result?: undefined;
          status: "failure";
        }
      | {
          error?: undefined;
          result: bigint;
          status: "success";
        }
    )[] = [];

    try {
      liquidities = await multicall(encoder.client, {
        contracts: pools.map((pool) => ({
          ...StateView,
          abi: uniswapV4StateViewAbi,
          functionName: "getLiquidity" as const,
          args: [pool.id],
        })),
        allowFailure: true,
        batchSize: 2 ** 16,
      });
    } catch (error) {
      throw new Error(
        `(UniswapV4) Error fetching pools liquidities: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let bestPool = pools[0]!;
    let bestLiquidity = 0n;
    for (let i = 0; i < pools.length; i += 1) {
      const liquidity = liquidities[i];
      if (!liquidity || liquidity.status === "failure") continue;
      if (liquidity.result > bestLiquidity) {
        // TODO: could improve this by picking minimum fee tier if there's a set
        // of similarly-sized pools.
        bestPool = pools[i]!;
        bestLiquidity = liquidity.result;
      }
    }

    const bestPoolKey: PoolKey = {
      currency0,
      currency1,
      fee: bestPool.fee,
      tickSpacing: bestPool.tickSpacing,
      hooks: bestPool.hooks,
    };

    // Configure exact swap at the Uniswap v4 Router level
    const v4Planner = new V4Planner();
    v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
      // See https://github.com/Uniswap/sdks/blob/5a1cbfb55d47625afd40f5f0f5e934ed18dfd5e4/sdks/v4-sdk/src/utils/v4Planner.ts#L70
      {
        poolKey: bestPoolKey,
        zeroForOne: currency0 === src,
        amountIn: srcAmount,
        amountOutMinimum: 0n,
        hookData: "0x",
      },
    ]);
    v4Planner.addAction(Actions.SETTLE_ALL, [src, maxUint256]); // [currency, maxAmount]
    v4Planner.addAction(Actions.TAKE_ALL, [dst, 0n]); // [currency, minAmount]

    // Configure overall actions at the Uniswap Universal Router level
    const routePlanner = new RoutePlanner();
    if (shouldUnwrap) {
      routePlanner.addCommand(CommandType.PERMIT2_TRANSFER_FROM, [
        Native.address,
        UniversalRouter.address,
        srcAmount,
      ]);
      routePlanner.addCommand(CommandType.UNWRAP_WETH, [UniversalRouter.address, 0], false);
    }
    // See https://github.com/Uniswap/sdks/blob/5a1cbfb55d47625afd40f5f0f5e934ed18dfd5e4/sdks/universal-router-sdk/src/utils/routerCommands.ts#L268
    routePlanner.addCommand(CommandType.V4_SWAP, [v4Planner.finalize()], false);

    // Make sure Permit2 can control our tokens
    try {
      const permit2Allowance = await readContract(encoder.client, {
        abi: erc20Abi,
        address: rawSrc,
        functionName: "allowance",
        args: [encoder.address, deployments.Permit2.address],
      });
      if (permit2Allowance < srcAmount) {
        encoder.erc20Approve(rawSrc, deployments.Permit2.address, maxUint256);
      }
    } catch (error) {
      throw new Error(
        `(UniswapV4) Error fetching Permit2 allowance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Tell Permit2 that the UniversalRouter can spend our tokens
    const deadline = maxUint48;
    encoder.pushCall(
      deployments.Permit2.address,
      0n,
      encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [rawSrc, deployments.UniversalRouter.address, srcAmount, Number(deadline)],
      }),
    );

    encoder.pushCall(
      UniversalRouter.address,
      0n,
      encodeFunctionData({
        abi: uniswapUniversalRouterAbi,
        functionName: "execute",
        args: [routePlanner.commands as Hex, routePlanner.inputs as Hex[], deadline],
      }),
    );
    if (shouldWrap) {
      // `Executor` contract caps amount at `address(this).balance`, and WETH receive
      // function falls back to a deposit -- this is the only way to wrap max amount
      // since placeholders can't specify msg.value.
      encoder.transfer(Native.address, maxUint256);
    }

    return { ...toConvert, src: rawDst, srcAmount: 0n };
  }

  private async fetchPools(
    encoder: ExecutorEncoder,
    poolManager: ValueOf<ValueOf<typeof DEPLOYMENTS>>,
    src: Address,
    dst: Address,
  ) {
    // Each pool's currencies are always sorted numerically.
    const [currency0, currency1] = BigInt(src) < BigInt(dst) ? [src, dst] : [dst, src];
    const cacheKey = `${currency0}${currency1}` as Hex;

    const cache = this.poolsCache[cacheKey];
    if (cache && Date.now() - cache.lastUpdate < this.STALE_TIME) {
      return { currency0, currency1, pools: cache.pools };
    }

    // Fast path: probe the standard (fee, tickSpacing, hooks) tuples via a
    // single multicall of `StateView.getLiquidity`. Pools with zero liquidity
    // are filtered out — they can't be swapped through anyway.
    try {
      const fastPools = await this.fastProbePools(encoder, currency0, currency1);
      if (fastPools.length > 0) {
        this.poolsCache[cacheKey] = { pools: fastPools, lastUpdate: Date.now() };
        return { currency0, currency1, pools: fastPools };
      }
    } catch (error) {
      // Fast path failing should not block the slow-path fallback; just log.
      console.warn(
        `(UniswapV4) Fast pool probe failed, falling back to event scan: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Slow path: discover any hookless Initialize event for the pair.
    try {
      const events = await getContractEvents(encoder.client, {
        ...poolManager,
        abi: uniswapV4PoolManagerAbi,
        eventName: "Initialize",
        args: { currency0, currency1 },
        strict: true,
      });
      const pools: PoolKeyData[] = events
        .filter((ev) => ev.args.hooks === zeroAddress)
        .map((ev) => ({
          id: ev.args.id,
          fee: Number(ev.args.fee),
          tickSpacing: Number(ev.args.tickSpacing),
          hooks: ev.args.hooks,
        }));
      this.poolsCache[cacheKey] = { pools, lastUpdate: Date.now() };
      return { currency0, currency1, pools };
    } catch (error) {
      throw new Error(
        `(UniswapV4) Error fetching pools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async fastProbePools(
    encoder: ExecutorEncoder,
    currency0: Address,
    currency1: Address,
  ): Promise<PoolKeyData[]> {
    const chainId = encoder.client.chain.id;
    const deployments = DEPLOYMENTS[chainId];
    if (!deployments) return [];
    const probes = UNISWAP_V4_POOL_KEY_PROBES[chainId] ?? UNISWAP_V4_DEFAULT_POOL_KEY_PROBES;

    const candidates = probes.map((probe) => ({
      ...probe,
      id: computePoolId(currency0, currency1, probe.fee, probe.tickSpacing, probe.hooks),
    }));

    const results = await multicall(encoder.client, {
      contracts: candidates.map((c) => ({
        ...deployments.StateView,
        abi: uniswapV4StateViewAbi,
        functionName: "getLiquidity" as const,
        args: [c.id],
      })),
      allowFailure: true,
      batchSize: 2 ** 16,
    });

    const live: PoolKeyData[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const r = results[i];
      if (!r || r.status !== "success") continue;
      if (r.result > 0n) {
        const c = candidates[i]!;
        live.push({ id: c.id, fee: c.fee, tickSpacing: c.tickSpacing, hooks: c.hooks });
      }
    }
    return live;
  }
}

// Keep an exported type referenced by consumers if they ever want to iterate.
export type { UniswapV4PoolKeyProbe };
