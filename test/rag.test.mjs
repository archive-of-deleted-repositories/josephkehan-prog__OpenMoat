import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Rag } from "../dist/rag.js";

test("RAG indexes large documents through bounded embedding batches", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-rag-batches-"));
  const docs = path.join(tmp, "docs");
  fs.mkdirSync(docs);
  fs.writeFileSync(
    path.join(docs, "large.md"),
    Array.from(
      { length: 140 },
      (_, index) => `# Section ${index}\n${`content-${index} `.repeat(180)}`
    ).join("\n")
  );

  const cfg = {
    secretsEnv: path.join(tmp, "secrets.env"),
    rag: {
      db: path.join(tmp, "rag.db"),
      include: [docs],
      embeddings: {
        provider: "ollama",
        model: "test-embedder",
        url: "http://127.0.0.1:11434",
      },
    },
  };
  const originalFetch = globalThis.fetch;
  const batchSizes = [];
  globalThis.fetch = async (_url, options) => {
    const input = JSON.parse(options.body).input;
    batchSizes.push(input.length);
    return {
      ok: true,
      async json() {
        return { embeddings: input.map(() => [1, 0]) };
      },
    };
  };

  const rag = new Rag(cfg);
  try {
    await rag.index(true);
    const stats = rag.stats();
    assert.ok(batchSizes.length >= 3, JSON.stringify(batchSizes));
    assert.ok(Math.max(...batchSizes) <= 64, JSON.stringify(batchSizes));
    assert.equal(stats.withEmbeddings, stats.chunks);
  } finally {
    rag.close();
    globalThis.fetch = originalFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RAG repairs missing embeddings even when source files are unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-rag-repair-"));
  const docs = path.join(tmp, "docs");
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, "guide.md"), "# Guide\nrepair this embedding");
  const cfg = {
    secretsEnv: path.join(tmp, "secrets.env"),
    rag: {
      db: path.join(tmp, "rag.db"),
      include: [docs],
      embeddings: {
        provider: "ollama",
        model: "test-embedder",
        url: "http://127.0.0.1:11434",
      },
    },
  };
  const originalFetch = globalThis.fetch;
  let available = false;
  globalThis.fetch = async (_url, options) => {
    const input = JSON.parse(options.body).input;
    return available
      ? {
          ok: true,
          async json() {
            return { embeddings: input.map(() => [1, 0]) };
          },
        }
      : { ok: false };
  };

  const rag = new Rag(cfg);
  try {
    await rag.index();
    assert.equal(rag.stats().withEmbeddings, 0);
    available = true;
    await rag.index();
    const stats = rag.stats();
    assert.equal(stats.withEmbeddings, stats.chunks);
  } finally {
    rag.close();
    globalThis.fetch = originalFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RAG excludes oversized evidence artifacts from the interactive corpus", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-rag-size-"));
  const docs = path.join(tmp, "docs");
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, "snapshot.txt"), "x".repeat(1024 * 1024 + 1));
  const rag = new Rag({
    secretsEnv: path.join(tmp, "secrets.env"),
    rag: {
      db: path.join(tmp, "rag.db"),
      include: [docs],
      embeddings: { provider: "none", model: "none" },
    },
  });
  try {
    await rag.index();
    assert.equal(rag.stats().files, 0);
    assert.equal(rag.stats().chunks, 0);
  } finally {
    rag.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
