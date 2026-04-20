import nock from "nock";
import { parseUnits } from "viem";
import { describe, expect } from "vitest";

import { KyberSwap, KyberSwapError } from "../../src/kyberSwap";
import { USDC, wstETH } from "../constants.js";
import { encoderTest } from "../setup.js";

describe("kyberSwap liquidity venue", () => {
  const router = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
  const txData = "0x83bd37f9aabbccdd";

  const venue = new KyberSwap();

  encoderTest.sequential("supportsRoute returns true on supported chain", ({ encoder }) => {
    expect(venue.supportsRoute(encoder, wstETH, USDC)).toBe(true);
  });

  encoderTest.sequential("supportsRoute returns false when src === dst", ({ encoder }) => {
    expect(venue.supportsRoute(encoder, wstETH, wstETH)).toBe(false);
  });

  encoderTest.sequential("convert encodes approve + swap call", async ({ encoder }) => {
    nock("https://aggregator-api.kyberswap.com")
      .get("/ethereum/api/v1/routes")
      .query(true)
      .reply(200, {
        code: 0,
        message: "successfully",
        data: { routeSummary: { amountIn: "1000000000000000000" }, routerAddress: router },
      });

    nock("https://aggregator-api.kyberswap.com")
      .post("/ethereum/api/v1/route/build")
      .reply(200, {
        code: 0,
        message: "successfully",
        data: {
          amountIn: "1000000000000000000",
          amountOut: "5000000000",
          routerAddress: router,
          data: txData,
          transactionValue: "0",
        },
      });

    encoder.erc20Approve(wstETH, router, parseUnits("1", 18)).pushCall(router, 0n, txData);
    const expected = encoder.flush();

    await venue.convert(encoder, {
      src: wstETH,
      dst: USDC,
      srcAmount: parseUnits("1", 18),
    });

    const encoded = encoder.flush();
    expect(encoded).toEqual(expected);
  });

  encoderTest.sequential(
    "convert throws typed KyberSwapError on route API error",
    async ({ encoder }) => {
      nock("https://aggregator-api.kyberswap.com")
        .get("/ethereum/api/v1/routes")
        .query(true)
        .reply(500, "internal");

      await expect(
        venue.convert(encoder, {
          src: wstETH,
          dst: USDC,
          srcAmount: parseUnits("1", 18),
        }),
      ).rejects.toSatisfy((e) => {
        return e instanceof KyberSwapError && e.phase === "route" && e.kind === "error";
      });
    },
  );
});
