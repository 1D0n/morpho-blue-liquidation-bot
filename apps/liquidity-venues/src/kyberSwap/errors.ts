export type KyberSwapPhase = "route" | "build";
export type KyberSwapErrorKind = "timeout" | "error";

/**
 * Typed error emitted by the KyberSwap venue so callers can classify
 * failures (timeout vs other error, and in which of the two API calls)
 * without parsing the error message.
 */
export class KyberSwapError extends Error {
  readonly phase: KyberSwapPhase;
  readonly kind: KyberSwapErrorKind;

  constructor(phase: KyberSwapPhase, kind: KyberSwapErrorKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "KyberSwapError";
    this.phase = phase;
    this.kind = kind;
  }
}
