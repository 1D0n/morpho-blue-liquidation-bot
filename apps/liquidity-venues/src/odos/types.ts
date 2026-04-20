import type { BigIntish } from "@morpho-org/blue-sdk";
import type { Address, Hex } from "viem";

export interface QuoteRequest {
  chainId: number;
  src: Address;
  dst: Address;
  amount: BigIntish;
  userAddr: Address;
}

export interface QuoteResponse {
  pathId: string;
  inAmounts: string[];
  outAmounts: string[];
  blockNumber: number;
}

export interface AssembleRequest {
  pathId: string;
  userAddr: Address;
}

export interface AssembleResponse {
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    gas?: number;
    chainId?: number;
  };
  outputTokens?: { tokenAddress: Address; amount: string }[];
}
