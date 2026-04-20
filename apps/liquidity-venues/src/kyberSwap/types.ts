import type { Address, Hex } from "viem";

// Subset of the Kyber route response we actually use. Kyber returns a lot
// more metadata; we treat it opaquely and hand `routeSummary` back in the
// build call verbatim.
export interface RouteResponse {
  code: number;
  message: string;
  data?: {
    routeSummary: unknown;
    routerAddress: Address;
  };
}

export interface BuildRequest {
  routeSummary: unknown;
  sender: Address;
  recipient: Address;
  slippageTolerance: number;
}

export interface BuildResponse {
  code: number;
  message: string;
  data?: {
    amountIn: string;
    amountOut: string;
    routerAddress: Address;
    data: Hex;
    transactionValue: string;
  };
}
