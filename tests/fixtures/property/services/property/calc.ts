export function calcPropertyValue(sqft: number, pricePerSqft: number): number {
  return sqft * pricePerSqft * getMarketMultiplier();
}

function getMarketMultiplier(): number {
  return 1.05;
}
