export function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}

export function formatPrice(price: number) {
  if (price < 0.01) return price.toFixed(5);
  if (price < 1) return price.toFixed(4);
  if (price > 1000) return price.toFixed(1);
  return price.toFixed(2);
}

export function formatPercent(value: number) {
  const symbol = value > 0 ? '+' : '';
  return `${symbol}${value.toFixed(2)}%`;
}
