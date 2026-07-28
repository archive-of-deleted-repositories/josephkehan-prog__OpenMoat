import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HubConfig } from "./config.js";
import { openStateDb } from "./db.js";
import { loadSecrets } from "./registry.js";

/**
 * Document RAG over the canonical workspace corpus (memory/ handoffs, profile
 * files, skills, guides). Complements squish, which is the *structured* agent
 * memory (facts/beliefs per project). This layer answers: "search everything
 * written down in the configured corpus".
 *
 * Storage: node:sqlite (built into Node >=22.5 — zero native deps, no ABI
 * issues across harnesses) — chunks + FTS5, embeddings as BLOB.
 * Retrieval: FTS5 candidates -> cosine re-rank (hybrid) when embeddings exist.
 * Embeddings: Ollama (local, default) or OpenAI; degrades to FTS-only.
 */

export interface RagHit {
  file: string;
  heading: string;
  snippet: string;
  score: number;
}

interface ChunkRow {
  id: number;
  file: string;
  heading: string;
  content: string;
  embedding: Uint8Array | null;
  ftsScore?: number;
}

const EXTS = new Set([".md", ".mdx", ".txt", ".markdown"]);
const MAX_CHUNK = 1500;
const EMBED_BATCH_SIZE = 64;
const MAX_CORPUS_FILE_BYTES = 1024 * 1024;

export class Rag {
  private db: DatabaseSync;

  constructor(private cfg: HubConfig) {
    this.db = openStateDb(cfg.rag.db, `
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, hash TEXT NOT NULL, indexed_at INTEGER NOT NULL,
        mtime REAL, size INTEGER
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL, heading TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL, embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
      -- Schema-level duplicate prevention (2026-07-25 audit): concurrent hub
      -- MCP processes race in index() (check-prev → wipe → insert interleaves),
      -- which produced 60k duplicate chunks. This UNIQUE index makes dupes
      -- impossible regardless of process interleaving. Requires the table to
      -- be deduped first (done in the 2026-07-25 migration).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_unique ON chunks(file, heading, content);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content, file UNINDEXED, heading UNINDEXED, content='chunks', content_rowid='id'
      );
    `);
    // Migration for DBs created before the stat fast-path columns existed.
    for (const col of ["mtime REAL", "size INTEGER"]) {
      try {
        this.db.exec(`ALTER TABLE files ADD COLUMN ${col};`);
      } catch {
        /* column already exists */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- corpus walking ----------

  private corpusFiles(): string[] {
    const out: string[] = [];
    const visit = (p: string, depth: number) => {
      if (!fs.existsSync(p)) return;
      const st = fs.statSync(p);
      if (st.isFile()) {
        // Large generated evidence snapshots can contain thousands of nearly
        // duplicate chunks. Preserve them on disk, but keep them out of the
        // latency-sensitive interactive corpus.
        if (
          st.size <= MAX_CORPUS_FILE_BYTES &&
          EXTS.has(path.extname(p).toLowerCase())
        ) {
          out.push(p);
        }
        return;
      }
      if (!st.isDirectory() || depth > 4) return;
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
        visit(path.join(p, e.name), depth + 1);
      }
    };
    for (const inc of this.cfg.rag.include) visit(inc, 0);
    return [...new Set(out)];
  }

  // ---------- chunking ----------

  private chunkFile(file: string, text: string): { heading: string; content: string }[] {
    const chunks: { heading: string; content: string }[] = [];
    let heading = path.basename(file);
    let buf: string[] = [];
    const flush = () => {
      const content = buf.join("\n").trim();
      if (content) {
        for (let i = 0; i < content.length; i += MAX_CHUNK) {
          chunks.push({ heading, content: content.slice(i, i + MAX_CHUNK) });
        }
      }
      buf = [];
    };
    for (const line of text.split("\n")) {
      if (/^#{1,4}\s/.test(line)) {
        flush();
        heading = line.replace(/^#+\s*/, "").slice(0, 120);
      }
      buf.push(line);
      if (buf.join("\n").length > MAX_CHUNK * 2) flush();
    }
    flush();
    return chunks;
  }

  // ---------- embeddings ----------

  private async embed(texts: string[]): Promise<number[][] | null> {
    const e = this.cfg.rag.embeddings;
    try {
      if (e.provider === "ollama") {
        const res = await fetch(`${e.url ?? "http://localhost:11434"}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // keep_alive holds the embedder resident so rag_search doesn't pay a
          // cold model-reload each call (default Ollama TTL is 5m and evicts it
          // whenever a chat model needs memory).
          body: JSON.stringify({ model: e.model, input: texts, keep_alive: "30m" }),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { embeddings: number[][] };
        return json.embeddings ?? null;
      }
      if (e.provider === "openai") {
        const key = loadSecrets(this.cfg.secretsEnv)["OPENAI_API_KEY"] ?? process.env.OPENAI_API_KEY;
        if (!key) return null;
        const res = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: e.model || "text-embedding-3-small", input: texts }),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { data: { embedding: number[] }[] };
        return json.data.map((d) => d.embedding);
      }
    } catch {
      /* embeddings unavailable -> FTS-only */
    }
    return null;
  }

  private async embedBatched(texts: string[]): Promise<number[][] | null> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const result = await this.embed(batch);
      if (!result || result.length !== batch.length) return null;
      vectors.push(...result);
    }
    return vectors;
  }

  // ---------- indexing ----------

  async index(force = false): Promise<{ indexed: number; skipped: number; embedded: boolean }> {
    const files = this.corpusFiles();
    const getFile = this.db.prepare("SELECT hash, mtime, size FROM files WHERE path = ?");
    const getMissingEmbeddings = this.db.prepare(
      "SELECT EXISTS(SELECT 1 FROM chunks WHERE file = ? AND embedding IS NULL) missing"
    );
    const delChunks = this.db.prepare("SELECT id FROM chunks WHERE file = ?");
    const delChunk = this.db.prepare("DELETE FROM chunks WHERE id = ?");
    const delFts = this.db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', ?, ?)");
    const getContent = this.db.prepare("SELECT content FROM chunks WHERE id = ?");
    const insChunk = this.db.prepare("INSERT OR IGNORE INTO chunks(file, heading, content, embedding) VALUES(?,?,?,?)");
    const insFts = this.db.prepare("INSERT INTO chunks_fts(rowid, content, file, heading) VALUES(?,?,?,?)");
    const upFile = this.db.prepare("INSERT OR REPLACE INTO files(path, hash, indexed_at, mtime, size) VALUES(?,?,?,?,?)");

    let indexed = 0;
    let skipped = 0;
    let anyEmbedded = false;

    const wipeFile = (file: string) => {
      for (const row of delChunks.all(file) as unknown as { id: number }[]) {
        const c = getContent.get(row.id) as unknown as { content: string } | undefined;
        if (c) delFts.run(row.id, c.content);
        delChunk.run(row.id);
      }
    };

    for (const file of files) {
      const prev = getFile.get(file) as unknown as { hash: string; mtime: number | null; size: number | null } | undefined;
      const missingEmbeddings = prev
        ? Boolean(
            (
              getMissingEmbeddings.get(file) as unknown as
                | { missing: number }
                | undefined
            )?.missing
          )
        : false;
      // Stat fast path: index() runs on every rag_search/tool_search, so an
      // unchanged file must cost one stat, not a full read + sha256.
      const st = fs.statSync(file);
      if (
        !force &&
        prev &&
        !missingEmbeddings &&
        prev.mtime === st.mtimeMs &&
        prev.size === st.size
      ) {
        skipped++;
        continue;
      }
      const text = fs.readFileSync(file, "utf8");
      const hash = crypto.createHash("sha256").update(text).digest("hex");
      if (!force && prev?.hash === hash && !missingEmbeddings) {
        upFile.run(file, hash, Date.now(), st.mtimeMs, st.size); // refresh stat columns
        skipped++;
        continue;
      }
      wipeFile(file);
      const chunks = this.chunkFile(file, text);
      // Embed OUTSIDE the write transaction — never hold the WAL write lock
      // across a network call to the embedder.
      const vectors = chunks.length
        ? await this.embedBatched(chunks.map((c) => `${c.heading}\n${c.content}`))
        : null;
      if (vectors) anyEmbedded = true;
      // BEGIN IMMEDIATE serializes concurrent hub MCP processes at write time
      // (busy_timeout=5000 in db.ts makes them queue instead of erroring).
      // This closes the check-prev → wipe → insert race that produced 60k
      // duplicate chunks; the UNIQUE index is the belt-and-braces backstop.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Re-wipe inside the txn: another process may have re-inserted this
        // file's chunks between our wipeFile above and lock acquisition.
        wipeFile(file);
        chunks.forEach((c, i) => {
          const blob = vectors?.[i] ? new Uint8Array(new Float32Array(vectors[i]).buffer) : null;
          const info = insChunk.run(file, c.heading, c.content, blob);
          if (Number(info.changes) > 0) insFts.run(info.lastInsertRowid, c.content, file, c.heading);
        });
        upFile.run(file, hash, Date.now(), st.mtimeMs, st.size);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      indexed++;
    }

    // prune deleted files
    const known = this.db.prepare("SELECT path FROM files").all() as unknown as { path: string }[];
    const live = new Set(files);
    for (const { path: p } of known) {
      if (live.has(p)) continue;
      wipeFile(p);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(p);
    }

    return { indexed, skipped, embedded: anyEmbedded };
  }

  // ---------- search ----------

  async search(query: string, k = 6, opts: { pathPrefix?: string; ftsOnly?: boolean } = {}): Promise<RagHit[]> {
    const terms = (query.match(/[\p{L}\p{N}_-]+/gu) ?? []).map((t) => `"${t}"`);
    if (!terms.length) return [];
    const ftsQuery = terms.join(" OR ");
    // Corpus scoping must happen IN the query: post-filtering the global top-k
    // lets memory/guide chunks displace every catalog chunk (tool_search would
    // then falsely report "no tool matches").
    const prefix = opts.pathPrefix ? `${opts.pathPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    let rows: ChunkRow[];
    try {
      rows = this.db
        .prepare(
          `SELECT c.id, c.file, c.heading, c.content, c.embedding, bm25(chunks_fts) AS ftsScore
           FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH ?${prefix ? " AND c.file LIKE ? ESCAPE '\\'" : ""} ORDER BY ftsScore LIMIT 100`
        )
        .all(...(prefix ? [ftsQuery, prefix] : [ftsQuery])) as unknown as ChunkRow[];
    } catch (e) {
      console.error(`openmoat: RAG FTS query failed (index corrupt? run rag_reindex): ${e}`);
      rows = [];
    }
    if (!rows.length) return [];

    // hybrid re-rank if we can embed the query and chunks have vectors.
    // ftsOnly skips the query embed entirely (used by tool_search: tool
    // names/descriptions are keyword-dense so bm25 alone ranks well, and this
    // keeps Ollama — and its model-reload latency — off the hot path).
    const qv = opts.ftsOnly ? null : (await this.embed([query]))?.[0] ?? null;
    const scored = rows.map((r) => {
      // bm25() is non-positive: more negative = better. Normalize the
      // relevance (-bm) into [0,1) — monotonic, so FTS-only ranking works.
      const bm = r.ftsScore ?? 0;
      let score = -bm / (1 - bm);
      if (qv && r.embedding) {
        const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
        score = 0.4 * score + 0.6 * cosine(qv, v);
      }
      return { r, score };
    });
    scored.sort((a, b) => b.score - a.score);
    // Dedupe identical (file, heading) chunks: concurrent index() runs from
    // parallel hub MCP processes can double-insert a file's chunks; the dupes
    // then crowd out distinct hits after re-ranking. Keep the best score.
    const seenChunk = new Set<string>();
    return scored
      .filter(({ r }) => {
        const key = `${r.file}|${r.heading}`;
        if (seenChunk.has(key)) return false;
        seenChunk.add(key);
        return true;
      })
      .slice(0, k)
      .map(({ r, score }) => ({
        file: r.file,
        heading: r.heading,
        snippet: r.content.slice(0, 700),
        score: Math.round(score * 1000) / 1000,
      }));
  }

  stats(): { files: number; chunks: number; withEmbeddings: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as unknown as { n: number }).n;
    return {
      files: one("SELECT COUNT(*) n FROM files"),
      chunks: one("SELECT COUNT(*) n FROM chunks"),
      withEmbeddings: one("SELECT COUNT(*) n FROM chunks WHERE embedding IS NOT NULL"),
    };
  }
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
