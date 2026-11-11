const orders: { id: number; total: number }[] = [];

export const allOrders = () => [...orders];

export function addOrder(total: number) {
  const order = { id: orders.length + 1, total };
  orders.push(order);
  return order;
}
