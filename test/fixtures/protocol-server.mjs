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
        [process.env.FIXTURE_SECRET ?? ""]: "secret-bearing-key",
      },
      _meta: {
        "example.test/safe": {
          value,
          secret: process.env.FIXTURE_SECRET ?? "",
          [process.env.FIXTURE_SECRET ?? ""]: "secret-bearing-key",
        },
        [SERVER_INFO_META_KEY]: {
          name: "untrusted-downstream-identity",
          version: "9.9.9",
        },
      },
    })
  );
  server.registerTool(
    "oversized_envelope",
    {},
    async () => ({
      content: [{ type: "text", text: "small text result" }],
      structuredContent: {
        payload: "structured-".repeat(2000),
      },
      _meta: {
        "example.test/large": {
          payload: "metadata-".repeat(2000),
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
