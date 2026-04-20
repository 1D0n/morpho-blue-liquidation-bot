import { beforeEach, describe, expect, it } from "vitest";

import { HealthState } from "../../src/health.js";

describe("HealthState", () => {
  let state: HealthState;

  beforeEach(() => {
    state = new HealthState(60_000, 10);
  });

  it("reports degraded when no chain has been launched", () => {
    expect(state.snapshot().status).toBe("degraded");
  });

  it("reports degraded after launch but before first successful run", () => {
    state.markLaunched(8453);
    const snap = state.snapshot();
    expect(snap.status).toBe("degraded");
    expect(snap.chains[8453]?.ok).toBe(false);
    expect(snap.chains[8453]?.stale).toBe(true);
  });

  it("reports ok after a successful run", () => {
    state.markLaunched(8453);
    state.markRunOk(8453);
    const snap = state.snapshot();
    expect(snap.status).toBe("ok");
    expect(snap.chains[8453]?.ok).toBe(true);
    expect(snap.chains[8453]?.stale).toBe(false);
    expect(snap.chains[8453]?.consecutiveErrors).toBe(0);
  });

  it("clears consecutive errors when a run succeeds", () => {
    state.markLaunched(8453);
    state.markRunError(8453);
    state.markRunError(8453);
    expect(state.snapshot().chains[8453]?.consecutiveErrors).toBe(2);
    state.markRunOk(8453);
    expect(state.snapshot().chains[8453]?.consecutiveErrors).toBe(0);
  });

  it("reports degraded when consecutive errors hit the threshold", () => {
    state.markLaunched(8453);
    for (let i = 0; i < 10; i++) state.markRunError(8453);
    const snap = state.snapshot();
    expect(snap.status).toBe("degraded");
    expect(snap.chains[8453]?.ok).toBe(false);
    expect(snap.chains[8453]?.consecutiveErrors).toBe(10);
  });

  it("is overall ok only when every launched chain is ok", () => {
    state.markLaunched(1);
    state.markLaunched(8453);
    state.markRunOk(1);
    state.markRunOk(8453);
    expect(state.snapshot().status).toBe("ok");
    state.markRunError(8453);
    // 1 error not enough to tip, but chain is still last-errored — ok per
    // consecutive-error threshold.
    expect(state.snapshot().chains[8453]?.ok).toBe(true);
  });
});

// End-to-end test is left to the integration-style spec in the bot test
// suite; HealthState covers the state-machine behaviour in isolation above.
