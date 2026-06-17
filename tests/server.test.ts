import { describe, expect, it } from "vitest";

import { createInfimiumServer } from "../src/server.js";

describe("createInfimiumServer", () => {
  it("registers the expected MCP tools", () => {
    const server = createInfimiumServer({
      searchApiKey: "",
      searchProvider: "brave",
      localDocsPath: "",
      codebasePath: "",
      shellAllowlist: ["ls", "git", "npm", "npx"]
    });

    expect(server.tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "fetch_url",
      "query_local_docs",
      "semantic_code_search",
      "dep_graph",
      "shell"
    ]);
  });
});
