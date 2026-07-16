import { calcPropertyValue } from "../services/property/calc";

export function estimatePropertyTax(sqft: number, pricePerSqft: number): number {
  return calcPropertyValue(sqft, pricePerSqft) * 0.0125;
}
