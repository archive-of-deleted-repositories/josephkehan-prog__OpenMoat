import fs from "node:fs";
import path from "node:path";

export interface MarketplaceInfo {
  name: string;
  /** "github:owner/repo" or "dir:/abs/path" */
  source: string;
  lastUpdated?: string;
}

export interface PluginInfo {
  name: string;
  marketplace: string;
  version: string;
  scopes: string[];
  /** projects a local-scoped install is bound to */
  projects: string[];
  installPath: string;
  skills: string[];
  agents: number;
  commands: number;
  hooks: boolean;
  missing: boolean;
}

export interface PluginSurface {
  marketplaces: MarketplaceInfo[];
  plugins: PluginInfo[];
}

interface InstallEntry {
  scope?: string;
  projectPath?: string;
  installPath?: string;
  version?: string;
}

const countFiles = (dir: string, pred: (f: string) => boolean, depth = 3): number => {
  if (!fs.existsSync(dir) || depth < 0) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countFiles(p, pred, depth - 1);
    else if (pred(e.name)) n++;
  }
  return n;
};

const listSkillNames = (dir: string, depth = 3): string[] => {
  if (!fs.existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (fs.existsSync(path.join(p, "SKILL.md"))) out.push(e.name);
    else out.push(...listSkillNames(p, depth - 1));
  }
  return out;
};

/** Read the Claude Code plugin surface: known marketplaces + installed plugins with what each provides. */
export function readPlugins(pluginsDir: string): PluginSurface {
  const marketplaces: MarketplaceInfo[] = [];
  const mkPath = path.join(pluginsDir, "known_marketplaces.json");
  if (fs.existsSync(mkPath)) {
    const raw = JSON.parse(fs.readFileSync(mkPath, "utf8")) as Record<
      string,
      { source?: { source?: string; repo?: string; path?: string }; lastUpdated?: string }
    >;
    for (const [name, m] of Object.entries(raw)) {
      const src = m.source?.source === "github" ? `github:${m.source.repo}` : `dir:${m.source?.path ?? "?"}`;
      marketplaces.push({ name, source: src, lastUpdated: m.lastUpdated });
    }
  }

  const plugins: PluginInfo[] = [];
  const instPath = path.join(pluginsDir, "installed_plugins.json");
  if (fs.existsSync(instPath)) {
    const raw = JSON.parse(fs.readFileSync(instPath, "utf8")) as { plugins?: Record<string, InstallEntry[]> };
    for (const [key, entries] of Object.entries(raw.plugins ?? {})) {
      const [name, marketplace] = key.includes("@") ? key.split("@") : [key, "?"];
      const first = entries[0] ?? {};
      const installPath = first.installPath ?? "";
      const missing = !installPath || !fs.existsSync(installPath);
      plugins.push({
        name,
        marketplace,
        version: first.version ?? "?",
        scopes: [...new Set(entries.map((e) => e.scope ?? "?"))].sort(),
        projects: [...new Set(entries.map((e) => e.projectPath).filter((p): p is string => !!p))],
        installPath,
        skills: missing ? [] : listSkillNames(path.join(installPath, "skills")).sort(),
        agents: missing ? 0 : countFiles(path.join(installPath, "agents"), (f) => f.endsWith(".md")),
        commands: missing ? 0 : countFiles(path.join(installPath, "commands"), (f) => f.endsWith(".md")),
        hooks: missing ? false : fs.existsSync(path.join(installPath, "hooks")),
        missing,
      });
    }
  }
  plugins.sort((a, b) => a.marketplace.localeCompare(b.marketplace) || a.name.localeCompare(b.name));
  return { marketplaces, plugins };
}

const surfaceSummary = (p: PluginInfo): string =>
  [
    p.skills.length ? `${p.skills.length} skills` : "",
    p.agents ? `${p.agents} agents` : "",
    p.commands ? `${p.commands} commands` : "",
    p.hooks ? "hooks" : "",
  ]
    .filter(Boolean)
    .join(", ") || "no components";

export function renderPluginsText(s: PluginSurface): string {
  const lines: string[] = [];
  let mk = "";
  for (const p of s.plugins) {
    if (p.marketplace !== mk) {
      mk = p.marketplace;
      const m = s.marketplaces.find((m) => m.name === mk);
      lines.push(`\n${mk}${m ? ` (${m.source})` : ""}`);
    }
    const scope = p.scopes.join("+") + (p.projects.length ? ` ×${p.projects.length} projects` : "");
    lines.push(`  ${p.name}@${p.version} [${scope}] — ${surfaceSummary(p)}${p.missing ? " (MISSING install)" : ""}`);
  }
  lines.push(`\n${s.plugins.length} plugins from ${s.marketplaces.length} marketplaces`);
  return lines.join("\n");
}

export function renderPluginsMarkdown(s: PluginSurface): string {
  const lines = [
    "# Installed plugins",
    "",
    `${s.plugins.length} plugins from ${s.marketplaces.length} marketplaces.`,
    "",
    "| Plugin | Marketplace | Version | Scope | Provides |",
    "|---|---|---|---|---|",
  ];
  for (const p of s.plugins) {
    const scope = p.scopes.join("+") + (p.projects.length ? ` (${p.projects.length} projects)` : "");
    lines.push(`| ${p.name} | ${p.marketplace} | ${p.version} | ${scope} | ${surfaceSummary(p)} |`);
  }
  lines.push("", "## Per-plugin skills", "");
  for (const p of s.plugins.filter((p) => p.skills.length)) {
    lines.push(`- **${p.name}**: ${p.skills.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Self-contained HTML plugin catalog, same look as the skills catalog. */
export function renderPluginsHtml(s: PluginSurface): string {
  const byMk = new Map<string, PluginInfo[]>();
  for (const p of s.plugins) byMk.set(p.marketplace, [...(byMk.get(p.marketplace) ?? []), p]);
  const sections = [...byMk.entries()]
    .map(([mk, plugins]) => {
      const m = s.marketplaces.find((m) => m.name === mk);
      return `
  <section>
    <h2>${esc(mk)} <span class="count">${plugins.length}</span></h2>
    <p class="root">${esc(m?.source ?? "")}</p>
    <ul>
${plugins
  .map((p) => {
    const scope = p.scopes.join("+") + (p.projects.length ? ` · ${p.projects.length} projects` : "");
    const skills = p.skills.length ? `<i>skills: ${esc(p.skills.slice(0, 30).join(", "))}${p.skills.length > 30 ? " …" : ""}</i>` : "";
    return `      <li data-name="${esc(p.name.toLowerCase())}" data-desc="${esc((p.skills.join(" ") + " " + mk).toLowerCase())}"><b>${esc(p.name)} <small>v${esc(p.version)} · ${esc(scope)}</small></b><span>${esc(surfaceSummary(p))}${p.missing ? " — MISSING install" : ""}</span>${skills}</li>`;
  })
  .join("\n")}
    </ul>
  </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Installed plugins</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #666; --bg: #fff; --card: #f6f6f4; --accent: #7c5cff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e8e8; --muted: #999; --bg: #141414; --card: #1f1f1f; } }
  * { box-sizing: border-box; margin: 0; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  .sub { color: var(--muted); margin-bottom: 1.25rem; }
  #q { width: 100%; padding: .6rem .9rem; font-size: 1rem; border: 1px solid var(--muted); border-radius: .5rem; background: var(--card); color: var(--fg); margin-bottom: 1.5rem; }
  section { margin-bottom: 1.75rem; }
  h2 { font-size: 1.15rem; margin-bottom: .15rem; }
  .count { color: var(--accent); font-size: .9rem; }
  .root { color: var(--muted); font-size: .8rem; font-family: ui-monospace, monospace; margin-bottom: .6rem; overflow-x: auto; }
  ul { list-style: none; display: grid; gap: .4rem; }
  li { background: var(--card); border-radius: .5rem; padding: .5rem .8rem; }
  li b { display: block; }
  li small { color: var(--muted); font-weight: normal; }
  li span { color: var(--muted); font-size: .85rem; display: block; }
  li i { color: var(--muted); font-size: .78rem; }
  li.hide, section.hide { display: none; }
</style>
</head>
<body>
<h1>Installed plugins</h1>
<p class="sub">${s.plugins.length} plugins from ${s.marketplaces.length} marketplaces — read from <code>~/.claude/plugins</code>.</p>
<input id="q" type="search" placeholder="Filter plugins… (name, marketplace, or skill)" autofocus>
${sections}
<script>
  const q = document.getElementById("q");
  q.addEventListener("input", () => {
    const t = q.value.trim().toLowerCase();
    document.querySelectorAll("section").forEach((sec) => {
      let visible = 0;
      sec.querySelectorAll("li").forEach((li) => {
        const hit = !t || li.dataset.name.includes(t) || li.dataset.desc.includes(t);
        li.classList.toggle("hide", !hit);
        if (hit) visible++;
      });
      sec.classList.toggle("hide", visible === 0);
    });
  });
</script>
</body>
</html>
`;
}
