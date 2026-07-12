import { z } from "zod";

export const semanticCodeSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5)
});

export type SemanticCodeSearchInput = z.infer<
  typeof semanticCodeSearchInputSchema
>;

export async function semanticCodeSearchTool(input: SemanticCodeSearchInput) {
  return {
    tool: "semantic_code_search",
    status: "not_implemented",
    input
  };
}
