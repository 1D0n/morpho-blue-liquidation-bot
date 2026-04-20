import { AccrualPosition, Market, MarketId } from "@morpho-org/blue-sdk";
import "@morpho-org/blue-sdk-viem/lib/augment";
import { fetchMarket, metaMorphoAbi } from "@morpho-org/blue-sdk-viem";
import { Time } from "@morpho-org/morpho-ts";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { readContract } from "viem/actions";

import type { DataProvider, LiquidatablePositionsResult } from "../dataProvider";

import { apiSdk } from "./api/index";

export class MorphoApiDataProvider implements DataProvider {
  async fetchMarkets(client: Client<Transport, Chain, Account>, vaults: Address[]): Promise<Hex[]> {
    try {
      const vaultMarkets = await Promise.all(
        vaults.map(async (vault) => this.fetchVaultMarkets(client, vault)),
      );

      return [...new Set(vaultMarkets.flat())];
    } catch (error) {
      console.error(`[Chain ${client.chain.id}] Error fetching markets for vaults:`, error);
      return [];
    }
  }

  async fetchLiquidatablePositions(
    client: Client<Transport, Chain, Account>,
    marketIds: Hex[],
  ): Promise<LiquidatablePositionsResult> {
    try {
      const PAGE_SIZE = 100;
      // Previously 100; a 79-market batch was empirically causing repeated 504
      // timeouts from the Morpho GraphQL endpoint and silently dropping scans.
      // 20 fits well under whatever the server's processing-time ceiling is.
      const MARKET_BATCH_SIZE = 20;
      const allPositions: NonNullable<
        Awaited<ReturnType<typeof apiSdk.getLiquidatablePositions>>["marketPositions"]["items"]
      > = [];

      // Batch market IDs into smaller chunks to stay under the API's timeout.
      for (let i = 0; i < marketIds.length; i += MARKET_BATCH_SIZE) {
        const marketIdsBatch = marketIds.slice(i, i + MARKET_BATCH_SIZE);

        let skip = 0;
        try {
          while (true) {
            const positionsQuery = await this.withRetry(
              () =>
                apiSdk.getLiquidatablePositions({
                  chainId: client.chain.id,
                  marketIds: marketIdsBatch,
                  skip,
                  first: PAGE_SIZE,
                }),
              { attempts: 3, baseDelayMs: 250, chainId: client.chain.id },
            );

            const items = positionsQuery.marketPositions.items;
            if (!items || items.length === 0) break;

            allPositions.push(...items);

            if (items.length < PAGE_SIZE) break;
            skip += PAGE_SIZE;
          }
        } catch (error) {
          // Per-batch failure after retries: degrade gracefully by skipping the
          // batch instead of aborting the whole scan. Other batches may still
          // surface liquidatable positions.
          console.warn(
            `[Chain ${client.chain.id}] fetchLiquidatablePositions batch ${i}-${i + marketIdsBatch.length - 1} failed after retries, skipping: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }

      const positions = allPositions.filter(
        (position) =>
          position.market.uniqueKey !== undefined &&
          position.market.oracle !== null &&
          position.state !== null,
      );

      if (positions.length === 0)
        return { liquidatablePositions: [], preLiquidatablePositions: [] };

      const marketResults = await Promise.allSettled(
        [...marketIds].map(async (marketId) => {
          const market = await fetchMarket(marketId as MarketId, client, {
            chainId: client.chain.id,
            // Disable `deployless` so that viem multicall aggregates fetches
            deployless: false,
          });

          const now = BigInt(Time.timestamp());
          const timestamp = now > market.lastUpdate ? now : market.lastUpdate;
          return [marketId, market.accrueInterest(timestamp)] as const;
        }),
      );

      const marketsMap = new Map(
        marketResults
          .filter(
            (r): r is PromiseFulfilledResult<readonly [Hex, Market]> => r.status === "fulfilled",
          )
          .map((r) => r.value),
      );

      for (const r of marketResults) {
        if (r.status === "rejected") {
          console.error(`[Chain ${client.chain.id}] Error fetching market:`, r.reason);
        }
      }

      const accruedPositions = positions
        .map((position) => {
          const market = marketsMap.get(position.market.uniqueKey);
          if (!market) return;

          const accrualPosition = new AccrualPosition(
            {
              user: position.user.address,
              // NOTE: These come as strings when mocking GraphQL response in tests, so we cast manually
              supplyShares: BigInt(position.state?.supplyShares ?? "0"),
              borrowShares: BigInt(position.state?.borrowShares ?? "0"),
              collateral: BigInt(position.state?.collateral ?? "0"),
            },
            market,
          );

          return accrualPosition;
        })
        .filter((position) => position !== undefined);

      return {
        liquidatablePositions: accruedPositions.filter(
          (position) => position.seizableCollateral !== undefined,
        ),
        preLiquidatablePositions: [],
      };
    } catch (error) {
      console.error(`[Chain ${client.chain.id}] Error fetching liquidatable positions:`, error);
      return { liquidatablePositions: [], preLiquidatablePositions: [] };
    }
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    opts: { attempts: number; baseDelayMs: number; chainId: number },
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === opts.attempts) break;
        const delay = opts.baseDelayMs * 2 ** (attempt - 1);
        console.warn(
          `[Chain ${opts.chainId}] fetchLiquidatablePositions attempt ${attempt}/${opts.attempts} failed (${error instanceof Error ? error.message.slice(0, 80) : String(error).slice(0, 80)}), retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  private async fetchVaultMarkets(
    client: Client<Transport, Chain, Account>,
    vaultAddress: Address,
  ): Promise<Hex[]> {
    try {
      const withdrawQueueLength = await readContract(client, {
        address: vaultAddress,
        abi: metaMorphoAbi,
        functionName: "withdrawQueueLength",
      });

      const indices = Array.from({ length: Number(withdrawQueueLength) }, (_, i) => BigInt(i));

      return await Promise.all(
        indices.map(async (index) => {
          const marketId = await readContract(client, {
            address: vaultAddress,
            abi: metaMorphoAbi,
            functionName: "withdrawQueue",
            args: [index],
          });
          return marketId;
        }),
      );
    } catch (error) {
      console.error(
        `[Chain ${client.chain.id}] Error fetching vault markets for ${vaultAddress}:`,
        error,
      );
      return [];
    }
  }
}
