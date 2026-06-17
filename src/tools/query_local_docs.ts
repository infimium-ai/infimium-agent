import { z } from "zod";

export const queryLocalDocsInputSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).default(5)
});

export type QueryLocalDocsInput = z.infer<typeof queryLocalDocsInputSchema>;

export async function queryLocalDocsTool(input: QueryLocalDocsInput) {
  return {
    tool: "query_local_docs",
    status: "not_implemented",
    input
  };
}
