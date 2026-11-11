import { allUsers } from "../db/users.ts";
import type { Handler } from "../types.ts";

export const listUsers: Handler = () => ({ status: 200, body: allUsers() });
