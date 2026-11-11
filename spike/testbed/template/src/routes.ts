import { home } from "./handlers/home.ts";
import { listOrders, createOrder } from "./handlers/orders.ts";
import { listUsers } from "./handlers/users.ts";
import type { Route } from "./types.ts";

export const routes: Route[] = [
  { method: "GET", path: "/", handler: home },
  { method: "GET", path: "/users", handler: listUsers },
  { method: "GET", path: "/orders", handler: listOrders },
  { method: "POST", path: "/orders", handler: createOrder },
];
