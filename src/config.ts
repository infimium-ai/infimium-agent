import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z
  .object({
    SEARCH_API_KEY: z.string().default(""),
    SEARCH_PROVIDER: z.string().default("brave"),
    LOCAL_DOCS_PATH: z.string().default(""),
    CODEBASE_PATH: z.string().default(""),
    SHELL_ALLOWLIST: z.string().default("ls,git,npm,npx")
  })
  .transform((env) => ({
    searchApiKey: env.SEARCH_API_KEY,
    searchProvider: env.SEARCH_PROVIDER,
    localDocsPath: env.LOCAL_DOCS_PATH,
    codebasePath: env.CODEBASE_PATH,
    shellAllowlist: env.SHELL_ALLOWLIST.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  }));

export type InfimiumConfig = z.infer<typeof envSchema>;

export function loadConfig(
  overrides: Partial<NodeJS.ProcessEnv> = {}
): InfimiumConfig {
  return envSchema.parse({
    ...process.env,
    ...overrides
  });
}
