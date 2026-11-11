import { config } from "../config.ts";
import type { Handler } from "../types.ts";

export const home: Handler = () => ({ status: 200, body: { name: config.appName } });
