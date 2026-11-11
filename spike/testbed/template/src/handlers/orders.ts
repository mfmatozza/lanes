import { addOrder, allOrders } from "../db/orders.ts";
import { priceWithTax } from "../billing/index.ts";
import { isPositiveNumber } from "../utils/validate.ts";
import type { Handler } from "../types.ts";

export const listOrders: Handler = () => ({ status: 200, body: allOrders() });

export const createOrder: Handler = (req) => {
  const amount = (req.body as { amount?: unknown })?.amount;
  if (!isPositiveNumber(amount)) return { status: 400, body: { error: "amount must be a positive number" } };
  return { status: 201, body: addOrder(priceWithTax(amount)) };
};
