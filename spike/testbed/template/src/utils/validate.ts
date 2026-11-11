export const isPositiveNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
