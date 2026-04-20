export type OdosPhase = "quote" | "assemble";
export type OdosErrorKind = "timeout" | "error";

/**
 * Typed error emitted by the Odos venue so callers can classify failures
 * (timeout vs other error, and in which of the two API calls) without
 * parsing the error message.
 */
export class OdosError extends Error {
  readonly phase: OdosPhase;
  readonly kind: OdosErrorKind;

  constructor(phase: OdosPhase, kind: OdosErrorKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OdosError";
    this.phase = phase;
    this.kind = kind;
  }
}
