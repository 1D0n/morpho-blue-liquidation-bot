import nock from "nock";
import { parseUnits } from "viem";
import { describe, expect } from "vitest";

import { Odos } from "../../src/odos";
import { USDC, wstETH } from "../constants.js";
import { encoderTest } from "../setup.js";

describe("odos liquidity venue", () => {
  const router = "0x0dB5441Fa76f2DF8CdaE80aA2F9B17eC7d9f8Df3";
  const txData = "0x83bd37f9000100010301de0bfa09a0b39bd9ca7d81e7ae86e9bf44c3660011111111";

  const venue = new Odos();

  encoderTest.sequential("supportsRoute returns true on supported chain", ({ encoder }) => {
    expect(venue.supportsRoute(encoder, wstETH, USDC)).toBe(true);
  });

  encoderTest.sequential("supportsRoute returns false when src === dst", ({ encoder }) => {
    expect(venue.supportsRoute(encoder, wstETH, wstETH)).toBe(false);
  });

  encoderTest.sequential("convert encodes approve + swap call", async ({ encoder }) => {
    nock("https://api.odos.xyz")
      .post("/sor/quote/v2")
      .reply(200, {
        pathId: "fakepath",
        inAmounts: ["1000000000000000000"],
        outAmounts: ["5000000000"],
        blockNumber: 21_000_000,
      });

    nock("https://api.odos.xyz")
      .post("/sor/assemble")
      .reply(200, {
        transaction: {
          to: router,
          data: txData,
          value: "0",
          gas: 500_000,
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

  encoderTest.sequential("convert throws on quote API error", async ({ encoder }) => {
    nock("https://api.odos.xyz").post("/sor/quote/v2").reply(500, "internal");

    await expect(
      venue.convert(encoder, {
        src: wstETH,
        dst: USDC,
        srcAmount: parseUnits("1", 18),
      }),
    ).rejects.toThrow(/Odos/);
  });
});
