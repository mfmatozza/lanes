export interface Request { method: string; path: string; body?: unknown }
export interface Response { status: number; body: unknown }
export type Handler = (req: Request) => Response;
export interface Route { method: "GET" | "POST"; path: string; handler: Handler }
