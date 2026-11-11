import * as path from "node:path";
import { Coordinator } from "./coordinator.ts";
import { loadOrCreateToken, privateDir } from "@lanes/core/local.ts";
import { startServer } from "./server.ts";

const port = Number(process.env.LANES_PORT ?? 4317);
const leaseTtlMs = process.env.LANES_TTL_MS ? Number(process.env.LANES_TTL_MS) : undefined;
// Set when the hook starts the server itself: exit once nobody has used it for this long and nothing is held.
const idleExitMs = process.env.LANES_IDLE_EXIT_MS ? Number(process.env.LANES_IDLE_EXIT_MS) : undefined;

// Always token-protected (security review): LANES_TOKEN, or the per-user ~/.lanes/token the hooks also read.
startServer({ port, host: process.env.LANES_HOST, allowedHosts: process.env.LANES_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean), token: loadOrCreateToken(), membersFile: path.join(privateDir(), "members.json"), githubClientId: process.env.LANES_GITHUB_CLIENT_ID || undefined, logFile: process.env.LANES_LOG, coordinator: new Coordinator({ leaseTtlMs }) }).then(
  (server) => {
    console.log(`Lanes server listening on ${server.url}`);
    if (idleExitMs) {
      setInterval(() => {
        const idle = Date.now() - server.lastActivity() > idleExitMs;
        if (idle && server.coordinator.snapshot().leases.length === 0) server.close().then(() => process.exit(0));
      }, Math.min(idleExitMs, 10_000)).unref();
    }
  },
  (err: Error & { code?: string }) => {
    // Several hooks may auto-start a server at once; only one can bind the port, and that's fine.
    if (err.code === "EADDRINUSE") process.exit(0);
    console.error(`Lanes server failed to start: ${err.message}`);
    process.exit(1);
  },
);
