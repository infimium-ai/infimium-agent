import { z } from "zod";

export const webSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5)
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export async function webSearchTool(input: WebSearchInput) {
  return {
    tool: "web_search",
    status: "not_implemented",
    input
  };
}
