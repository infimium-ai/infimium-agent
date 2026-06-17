import { z } from "zod";

export const shellInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional()
});

export type ShellInput = z.infer<typeof shellInputSchema>;

export async function shellTool(input: ShellInput) {
  return {
    tool: "shell",
    status: "not_implemented",
    input
  };
}
