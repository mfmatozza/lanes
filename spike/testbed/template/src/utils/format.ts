import { config } from "../config.ts";

export const formatMoney = (amount: number) => `${amount.toFixed(2)} ${config.currency}`;
