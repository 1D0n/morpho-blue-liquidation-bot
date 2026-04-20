import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

interface ChainHealth {
  launched: boolean;
  lastRunAt?: number;
  lastRunOk?: boolean;
  consecutiveErrors: number;
}

/**
 * Per-chain liveness state consumed by `/health`. A chain is healthy when
 * it has been launched and has completed at least one run within the
 * staleness window with fewer than the allowed consecutive errors.
 */
export class HealthState {
  private chains = new Map<number, ChainHealth>();
  private readonly staleMs: number;
  private readonly maxConsecutiveErrors: number;

  constructor(staleMs = 120_000, maxConsecutiveErrors = 10) {
    this.staleMs = staleMs;
    this.maxConsecutiveErrors = maxConsecutiveErrors;
  }

  markLaunched(chainId: number) {
    const existing = this.chains.get(chainId);
    this.chains.set(chainId, {
      launched: true,
      consecutiveErrors: existing?.consecutiveErrors ?? 0,
      lastRunAt: existing?.lastRunAt,
      lastRunOk: existing?.lastRunOk,
    });
  }

  markRunOk(chainId: number) {
    const existing = this.chains.get(chainId) ?? {
      launched: true,
      consecutiveErrors: 0,
    };
    this.chains.set(chainId, {
      ...existing,
      launched: true,
      lastRunAt: Date.now(),
      lastRunOk: true,
      consecutiveErrors: 0,
    });
  }

  markRunError(chainId: number) {
    const existing = this.chains.get(chainId) ?? {
      launched: true,
      consecutiveErrors: 0,
    };
    this.chains.set(chainId, {
      ...existing,
      launched: true,
      lastRunAt: Date.now(),
      lastRunOk: false,
      consecutiveErrors: existing.consecutiveErrors + 1,
    });
  }

  snapshot() {
    const now = Date.now();
    const chains: Record<number, ChainHealth & { stale: boolean; ok: boolean }> = {};
    let overallOk = this.chains.size > 0;
    for (const [chainId, state] of this.chains) {
      const stale = state.lastRunAt === undefined || now - state.lastRunAt > this.staleMs;
      const ok = state.launched && !stale && state.consecutiveErrors < this.maxConsecutiveErrors;
      if (!ok) overallOk = false;
      chains[chainId] = { ...state, stale, ok };
    }
    return { status: overallOk ? "ok" : "degraded", chains };
  }
}

// Shared across the process so LiquidationBot instances (one per chain) and
// the HTTP handler see the same state.
let healthStateInstance: HealthState | null = null;
export function getHealthState(): HealthState {
  if (!healthStateInstance) healthStateInstance = new HealthState();
  return healthStateInstance;
}

class HealthServer {
  private fastify: FastifyInstance;
  private port: number;
  private host: string;
  private state: HealthState;

  constructor(port = 3000, host = "0.0.0.0", state?: HealthState) {
    this.port = port;
    this.host = host;
    this.state = state ?? getHealthState();
    this.fastify = Fastify({
      logger: false,
    });

    this.setupRoutes();
  }

  private setupRoutes() {
    this.fastify.get("/health", async (_request, reply) => {
      const snap = this.state.snapshot();
      const status = snap.status === "ok" ? 200 : 503;
      return reply.code(status).send(snap);
    });
  }

  async start() {
    try {
      await this.fastify.listen({ port: this.port, host: this.host });
      console.log(`🚀 Health server listening on http://${this.host}:${this.port}`);
    } catch (err) {
      this.fastify.log.error(err);
      throw err;
    }
  }

  async stop() {
    await this.fastify.close();
  }
}

// Singleton instance
let healthServerInstance: HealthServer | null = null;

export function getHealthServer(port?: number, host?: string): HealthServer {
  if (!healthServerInstance) {
    const serverPort =
      port ?? Number.parseInt(process.env.PORT ?? process.env.HEALTH_SERVER_PORT ?? "3000", 10);
    const serverHost = host ?? process.env.HEALTH_SERVER_HOST ?? "0.0.0.0";
    healthServerInstance = new HealthServer(serverPort, serverHost);
  }
  return healthServerInstance;
}

export async function startHealthServer(port?: number, host?: string): Promise<HealthServer> {
  const server = getHealthServer(port, host);
  await server.start();
  return server;
}
