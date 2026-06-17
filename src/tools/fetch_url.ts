import { z } from "zod";

export const fetchUrlInputSchema = z.object({
  url: z.string().url()
});

export type FetchUrlInput = z.infer<typeof fetchUrlInputSchema>;

export async function fetchUrlTool(input: FetchUrlInput) {
  return {
    tool: "fetch_url",
    status: "not_implemented",
    input
  };
}
