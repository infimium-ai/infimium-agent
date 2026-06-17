import { z } from "zod";

export const depGraphInputSchema = z.object({
  entrypoint: z.string().min(1).optional(),
  depth: z.number().int().positive().max(20).default(5)
});

export type DepGraphInput = z.infer<typeof depGraphInputSchema>;

export async function depGraphTool(input: DepGraphInput) {
  return {
    tool: "dep_graph",
    status: "not_implemented",
    input
  };
}
