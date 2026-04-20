import { arbitrum, base, linea, mainnet, optimism, polygon, scroll, unichain } from "viem/chains";

export const ODOS_API_BASE_URL = "https://api.odos.xyz";

// Odos expects slippage as a percent (e.g. 0.5 = 0.5%).
export const ODOS_SLIPPAGE_PERCENT = 0.5;

export const ODOS_SUPPORTED_NETWORKS: number[] = [
  mainnet.id,
  optimism.id,
  polygon.id,
  base.id,
  arbitrum.id,
  linea.id,
  scroll.id,
  unichain.id,
];
