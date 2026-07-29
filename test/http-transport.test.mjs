import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createMcpHandler,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadConfigFile } from "../dist/config.js";
import { createGatewayRuntime } from "../dist/gateway-runtime.js";

async function startFixture(protocolVersion) {
  const makeServer = () => {
    const mcp = new McpServer(
      { name: "http-fixture", version: "1.0.0" },
      { supportedProtocolVersions: [protocolVersion] }
    );
    mcp.registerTool(
      "echo",
      {
        description: "Echo a value",
        inputSchema: { value: z.string() },
      },
      async ({ value }) => ({
        content: [{ type: "text", text: value }],
        structuredContent: { value },
      })
    );
    return mcp;
  };

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const legacyServer = makeServer();
  const modernHandler = createMcpHandler(makeServer, {
    legacy: "reject",
  });
  if (protocolVersion === "2025-11-25") {
    await legacyServer.connect(transport);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = `http://127.0.0.1:${server.address().port}${request.url}`;
      const webRequest = new Request(url, {
        method: request.method,
        headers: request.headers,
        ...(body.length ? { body } : {}),
      });
      const webResponse =
        protocolVersion === "2025-11-25"
          ? await transport.handleRequest(webRequest)
          : await modernHandler.fetch(webRequest);
      response.writeHead(
        webResponse.status,
        Object.fromEntries(webResponse.headers.entries())
      );
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  return {
    port: server.address().port,
    close: async () => {
      if (protocolVersion === "2025-11-25") {
        await legacyServer.close();
      } else {
        await modernHandler.close();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

for (const protocolVersion of ["2025-11-25", "2026-07-28"]) {
  test(`downstream Streamable HTTP negotiates ${protocolVersion}`, async () => {
    const fixture = await startFixture(protocolVersion);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-http-"));
    const file = path.join(root, "Moatfile");
    fs.writeFileSync(
      file,
      `apiVersion: openmoat.dev/v1
kind: Moatfile
paths:
  state: ./state
  secrets: ./secrets.env
gateway:
  callers:
    test-client:
      allow: ["remote:*"]
  servers:
    remote:
      transport: http
      url: http://127.0.0.1:${fixture.port}/mcp
      headers:
        X-OpenMoat-Test: static
      trust: trusted
`
    );
    fs.writeFileSync(path.join(root, "secrets.env"), "", { mode: 0o600 });
    const runtime = createGatewayRuntime(loadConfigFile(file));
    try {
      const description = await runtime.describe(
        "remote",
        "echo",
        "test-client"
      );
      assert.match(description, /Tool: echo/);
      const result = await runtime.call(
        "remote",
        "echo",
        { value: protocolVersion },
        undefined,
        "test-client"
      );
      assert.equal(result.content[0].text, protocolVersion);
      assert.equal(result.structuredContent.value, protocolVersion);
    } finally {
      runtime.close();
      await fixture.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
