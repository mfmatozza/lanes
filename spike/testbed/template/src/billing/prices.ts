export const TAX_RATE = 0.22;

export function priceWithTax(net: number): number {
  return Math.round(net * (1 + TAX_RATE) * 100) / 100;
}
