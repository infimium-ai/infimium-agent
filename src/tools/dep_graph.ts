import { z } from "zod";

export const depGraphInputSchema = z.object({
  file: z.string().min(1),
  depth: z.number().int().positive().max(5).default(1)
});

export type DepGraphInput = z.infer<typeof depGraphInputSchema>;

export async function depGraphTool(input: DepGraphInput) {
  return {
    tool: "dep_graph",
    status: "not_implemented",
    input
  };
}
