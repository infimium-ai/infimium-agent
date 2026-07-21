import { ChromaClient } from "chromadb";

export function createChromaClient(chromadbHost: string | undefined = process.env.CHROMADB_HOST): ChromaClient {
  const host = chromadbHost?.trim();
  if (!host) {
    return new ChromaClient();
  }

  const url = new URL(host.includes("://") ? host : `http://${host}`);
  const ssl = url.protocol === "https:";
  const defaultPort = ssl ? 443 : 8000;

  return new ChromaClient({
    host: url.hostname,
    port: url.port ? Number(url.port) : defaultPort,
    ssl
  });
}
