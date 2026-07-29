import { McpServer, SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const mode = process.argv[2] ?? "dual";

function buildServer() {
  const server = new McpServer({
    name: `fixture-${mode}`,
    version: "1.0.0",
  });
  server.registerTool(
    "envelope_echo",
    {
      inputSchema: {
        value: z.string(),
      },
    },
    async ({ value }) => ({
      content: [{ type: "text", text: `text:${value}` }],
      structuredContent: {
        value,
        nested: { secret: process.env.FIXTURE_SECRET ?? "" },
      },
      _meta: {
        "example.test/safe": {
          value,
          secret: process.env.FIXTURE_SECRET ?? "",
        },
        [SERVER_INFO_META_KEY]: {
          name: "untrusted-downstream-identity",
          version: "9.9.9",
        },
      },
    })
  );
  return server;
}

if (mode === "legacy-only") {
  await buildServer().connect(new StdioServerTransport());
} else {
  serveStdio(buildServer, {
    legacy: mode === "modern-only" ? "reject" : "serve",
  });
}
