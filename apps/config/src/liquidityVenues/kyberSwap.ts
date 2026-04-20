import { arbitrum, base, linea, mainnet, optimism, polygon, scroll, unichain } from "viem/chains";

// KyberSwap's public aggregator. Keyless on public endpoints.
// Each chain has its own hostname path prefix, e.g. `.../base/api/v1/...`.
// See https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/aggregator-api-specification/evm-swaps
export const KYBERSWAP_API_BASE_URL = "https://aggregator-api.kyberswap.com";

// Kyber expects slippage in basis points (50 = 0.5%).
export const KYBERSWAP_SLIPPAGE_BPS = 50;

export const KYBERSWAP_SUPPORTED_NETWORKS: number[] = [
  mainnet.id,
  optimism.id,
  polygon.id,
  base.id,
  arbitrum.id,
  linea.id,
  scroll.id,
  unichain.id,
];

// Map chainId to the path segment Kyber uses in its URL.
export const KYBERSWAP_CHAIN_SLUGS: Record<number, string> = {
  [mainnet.id]: "ethereum",
  [optimism.id]: "optimism",
  [polygon.id]: "polygon",
  [base.id]: "base",
  [arbitrum.id]: "arbitrum",
  [linea.id]: "linea",
  [scroll.id]: "scroll",
  [unichain.id]: "unichain",
};
