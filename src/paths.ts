import { resolve } from "node:path";

export function dataPath(fileName: string): string {
  const dataDir = process.env.INFIMIUM_DATA_DIR?.trim();
  return dataDir ? resolve(dataDir, fileName) : fileName;
}
