import path from "node:path";
import type { SkillInfo } from "./skills.js";

export interface SkillGroup {
  label: string;
  root: string;
  skills: SkillInfo[];
}

/** Human label for a skills root: its basename, or the parent dir when the basename is just "skills". */
export function rootLabel(root: string): string {
  const base = path.basename(root);
  return base === "skills" ? path.basename(path.dirname(root)) : base;
}

/** Group discovered skills by the root they were found under (roots in priority order). */
export function groupSkills(skills: SkillInfo[], roots: string[]): SkillGroup[] {
  const groups = roots.map((root) => ({ label: rootLabel(root), root, skills: [] as SkillInfo[] }));
  const orphans: SkillInfo[] = [];
  for (const s of skills) {
    const g = groups.find((g) => s.dir === g.root || s.dir.startsWith(g.root + path.sep));
    if (g) g.skills.push(s);
    else orphans.push(s);
  }
  if (orphans.length) groups.push({ label: "(other)", root: "", skills: orphans });
  return groups.filter((g) => g.skills.length > 0);
}

export function renderText(groups: SkillGroup[]): string {
  const total = groups.reduce((n, g) => n + g.skills.length, 0);
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`\n${g.label} (${g.skills.length}) — ${g.root}`);
    for (const s of g.skills) lines.push(`  ${s.name} — ${s.description.slice(0, 100)}`);
  }
  lines.push(`\n${total} skills across ${groups.length} collections`);
  return lines.join("\n");
}

export function renderMarkdown(groups: SkillGroup[]): string {
  const total = groups.reduce((n, g) => n + g.skills.length, 0);
  const lines = [
    "# OpenMoat skills catalog",
    "",
    `${total} skills across ${groups.length} collections. A skill = a folder with a \`SKILL.md\`;`,
    "drop one under any registered root and the OpenMoat picks it up automatically.",
  ];
  for (const g of groups) {
    lines.push("", `## ${g.label} (${g.skills.length})`, "", `Root: \`${g.root}\``, "");
    for (const s of g.skills) lines.push(`- **${s.name}** — ${s.description}`);
  }
  return lines.join("\n") + "\n";
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Self-contained HTML catalog: collection sections + a live filter box, light/dark aware. */
export function renderHtml(groups: SkillGroup[]): string {
  const total = groups.reduce((n, g) => n + g.skills.length, 0);
  const sections = groups
    .map(
      (g) => `
  <section>
    <h2>${esc(g.label)} <span class="count">${g.skills.length}</span></h2>
    <p class="root">${esc(g.root)}</p>
    <ul>
${g.skills
  .map(
    (s) =>
      `      <li data-name="${esc(s.name.toLowerCase())}" data-desc="${esc(s.description.toLowerCase())}"><b>${esc(s.name)}</b><span>${esc(s.description)}</span></li>`
  )
  .join("\n")}
    </ul>
  </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenMoat skills catalog</title>
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
  li span { color: var(--muted); font-size: .85rem; }
  li.hide, section.hide { display: none; }
</style>
</head>
<body>
<h1>OpenMoat skills catalog</h1>
<p class="sub">${total} skills across ${groups.length} collections — served by openmoat <code>skills_list</code> / <code>skill_read</code>. To publish a skill, drop a folder containing <code>SKILL.md</code> under any root below.</p>
<input id="q" type="search" placeholder="Filter skills… (name or description)" autofocus>
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
