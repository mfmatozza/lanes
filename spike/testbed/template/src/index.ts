import { config } from "./config.ts";
import { log } from "./logger.ts";
import { routes } from "./routes.ts";
import type { Request, Response } from "./types.ts";

export function dispatch(req: Request): Response {
  const route = routes.find((r) => r.method === req.method && r.path === req.path);
  if (!route) return { status: 404, body: { error: "not found" } };
  log("debug", `${req.method} ${req.path}`);
  return route.handler(req);
}

log("info", `${config.appName} v${config.version} ready on port ${config.port}`);
