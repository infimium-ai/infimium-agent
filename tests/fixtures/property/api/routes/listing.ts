import { calcPropertyValue } from "../../services/property/calc";

export function getListingPrice(id: string): number {
  const sqft = id.length * 100;
  const pricePerSqft = 425;

  return calcPropertyValue(sqft, pricePerSqft);
}
