export type TextSplitterOptions = {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
};

const DEFAULT_CHUNK_SIZE = 512 * 4;
const DEFAULT_CHUNK_OVERLAP = 50 * 4;
const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "];

export function splitText(
  text: string,
  options: TextSplitterOptions = {}
): string[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const separators = options.separators ?? DEFAULT_SEPARATORS;

  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("chunkSize must be a positive integer");
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error("chunkOverlap must be an integer smaller than chunkSize");
  }

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    const hardEnd = Math.min(start + chunkSize, normalized.length);
    const end = hardEnd === normalized.length
      ? hardEnd
      : findBestBoundary(normalized, start, hardEnd, separators);
    const chunk = normalized.slice(start, end).trim();

    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= normalized.length) {
      break;
    }

    start = findOverlapStart(normalized, start, end, chunkOverlap, separators);
  }

  return chunks;
}

function findBestBoundary(
  text: string,
  start: number,
  hardEnd: number,
  separators: string[]
): number {
  const minimumUsefulEnd = start + Math.floor((hardEnd - start) * 0.5);

  for (const separator of separators) {
    const index = text.lastIndexOf(separator, hardEnd - 1);
    if (index >= minimumUsefulEnd) {
      return index + separator.length;
    }
  }

  return hardEnd;
}

function findOverlapStart(
  text: string,
  previousStart: number,
  end: number,
  overlap: number,
  separators: string[]
): number {
  const target = Math.max(previousStart + 1, end - overlap);
  if (target >= end) {
    return end;
  }

  for (const separator of [...separators].reverse()) {
    const index = text.lastIndexOf(separator, target);
    if (index >= previousStart && index < end) {
      return Math.max(previousStart + 1, index + separator.length);
    }
  }

  return target;
}
