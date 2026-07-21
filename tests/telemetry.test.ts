import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTelemetryStatus,
  setTelemetryEnabled,
  trackFirstToolCall,
  trackSetupCompleted,
  trackTelemetry
} from "../src/telemetry.js";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

describe("telemetry", () => {
  let tempDir: string;
  let installPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalTelemetry = process.env.INFIMIUM_TELEMETRY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-telemetry-"));
    installPath = join(tempDir, "install.json");
    process.env.INFIMIUM_TELEMETRY = "true";
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    if (originalTelemetry === undefined) {
      delete process.env.INFIMIUM_TELEMETRY;
    } else {
      process.env.INFIMIUM_TELEMETRY = originalTelemetry;
    }
    vi.unstubAllGlobals();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("sends a privacy-safe PostHog event", async () => {
    const sent = await trackTelemetry("doctor_run", { source: "doctor" }, { installPath });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    };

    expect(body.event).toBe("doctor_run");
    expect(body.distinct_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.properties).toMatchObject({
      telemetry_version: 1,
      infimium_version: packageJson.version,
      source: "doctor"
    });
    expect(JSON.stringify(body)).not.toContain("/Users/");
  });

  it("does not send when telemetry is disabled", async () => {
    delete process.env.INFIMIUM_TELEMETRY;
    await setTelemetryEnabled(false, installPath);

    const sent = await trackTelemetry("index_started", {}, { installPath });

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tracks setup_completed and first_tool_call only once", async () => {
    await trackSetupCompleted({ source: "index" }, { installPath });
    await trackSetupCompleted({ source: "doctor" }, { installPath });
    await trackFirstToolCall("get_context", { installPath });
    await trackFirstToolCall("semantic_code_search", { installPath });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const events = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(String(init.body)) as { event: string };
    });
    expect(events.map((event) => event.event)).toEqual(["setup_completed", "first_tool_call"]);

    const record = JSON.parse(await readFile(installPath, "utf8")) as {
      setupCompletedTracked?: boolean;
      firstToolCallTracked?: boolean;
    };
    expect(record.setupCompletedTracked).toBe(true);
    expect(record.firstToolCallTracked).toBe(true);
  });

  it("deduplicates concurrent first_tool_call events", async () => {
    await Promise.all([
      trackFirstToolCall("get_context", { installPath }),
      trackFirstToolCall("semantic_code_search", { installPath }),
      trackFirstToolCall("dep_graph", { installPath }),
      trackFirstToolCall("query_local_docs", { installPath })
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      event: string;
      properties: Record<string, unknown>;
    };
    expect(body.event).toBe("first_tool_call");
    expect(body.properties.$insert_id).toMatch(/:first_tool_call$/);
  });

  it("keeps one install id during concurrent record creation", async () => {
    await Promise.all([
      trackTelemetry("serve_started", {}, { installPath }),
      trackTelemetry("doctor_run", {}, { installPath }),
      trackTelemetry("index_started", {}, { installPath }),
      trackTelemetry("playground_opened", {}, { installPath })
    ]);

    const distinctIds = new Set(
      fetchMock.mock.calls.map((call) => {
        const init = call[1] as RequestInit;
        const body = JSON.parse(String(init.body)) as { distinct_id: string };
        return body.distinct_id;
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(distinctIds.size).toBe(1);
  });

  it("reports telemetry status without exposing the PostHog key", async () => {
    const status = await getTelemetryStatus(installPath);

    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.endpoint).toBe("https://us.i.posthog.com/capture/");
    expect(status).not.toHaveProperty("key");
  });
});
