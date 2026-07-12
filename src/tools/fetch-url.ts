import { load } from "cheerio";
import TurndownService from "turndown";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 40_000;

type ExtractMode = "text" | "markdown";

export class FetchUrlTool {
  private readonly turndown = new TurndownService();

  async fetchUrl(url: string, extract: ExtractMode = "markdown"): Promise<string> {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(url);
    } catch {
      return `Invalid URL: ${url}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(parsedUrl, { signal: controller.signal });

      if (response.status < 200 || response.status >= 300) {
        return `Failed to fetch ${url}: HTTP ${response.status}`;
      }

      const contentType = response.headers.get("content-type") ?? "unknown";
      if (!contentType.toLowerCase().includes("text/html")) {
        return `URL returned ${contentType}, not HTML: ${url}`;
      }

      const html = await response.text();
      const markdown = this.extractMainContent(html, extract);

      return truncateOutput(markdown, url);
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return `Timeout fetching ${url}`;
      }

      const message = error instanceof Error ? error.message : String(error);
      return `Failed to fetch ${url}: ${message}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractMainContent(html: string, extract: ExtractMode): string {
    const $ = load(html);

    $("nav, header, footer, script, style, aside, .sidebar, .ads").remove();

    const content = firstMatchingHtml($, ["article", "main", ".content", "body"]);

    if (extract === "text") {
      return load(content).text().replace(/\s+/g, " " ).trim();
    }

    return this.turndown.turndown(content).trim();
  }
}

function firstMatchingHtml(
  $: ReturnType<typeof load>,
  selectors: string[]
): string {
  for (const selector of selectors) {
    const element = $(selector).first();

    if (element.length > 0) {
      return element.html() ?? element.text();
    }
  }

  return "";
}

function truncateOutput(content: string, url: string): string {
  if (content.length <= MAX_OUTPUT_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_OUTPUT_CHARS)}\n\n[Content truncated at 40,000 chars. Full page: ${url}]`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("abort"))
  );
}

export async function runFetchUrl(
  url: string,
  extract: ExtractMode = "markdown"
): Promise<string> {
  const tool = new FetchUrlTool();

  return tool.fetchUrl(url, extract);
}
