import { z } from "zod";

export const semanticCodeSearchInputSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).default(10)
});

export type SemanticCodeSearchInput = z.infer<
  typeof semanticCodeSearchInputSchema
>;

export async function semanticCodeSearchTool(
  input: SemanticCodeSearchInput
) {
  return {
    tool: "semantic_code_search",
    status: "not_implemented",
    input
  };
}
