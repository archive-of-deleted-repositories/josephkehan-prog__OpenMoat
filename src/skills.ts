import fs from "node:fs";
import path from "node:path";

export interface SkillInfo {
  name: string;
  dir: string;
  skillMd: string;
  description: string;
}

// Discovery walks the whole tree and reads every SKILL.md; bootstrap, list,
// and read often hit it back-to-back, so cache briefly.
const CACHE_TTL_MS = 30_000;
let cache: { key: string; at: number; skills: SkillInfo[] } | null = null;

/** A skill = a directory containing SKILL.md. Recurses (skills may be nested by category).
 *  Accepts one or more roots; later roots don't override earlier names. */
export function discoverSkills(skillsDir: string | string[]): SkillInfo[] {
  const roots = Array.isArray(skillsDir) ? skillsDir : [skillsDir];
  const key = roots.join("\n");
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.skills;
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (!fs.existsSync(dir) || depth > 4) return;
    const skillMd = path.join(dir, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      const name = path.basename(dir);
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, dir, skillMd, description: readDescription(skillMd) });
      }
      return; // don't recurse into a skill
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  const skills = out.sort((a, b) => a.name.localeCompare(b.name));
  cache = { key, at: Date.now(), skills };
  return skills;
}

/** Pull `description:` out of YAML frontmatter, else first non-heading line. */
function readDescription(skillMd: string): string {
  const text = fs.readFileSync(skillMd, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const d = fm[1].match(/^description:\s*(.*)$/m);
    if (d) {
      let val = d[1].trim();
      if (val === "" || /^[>|][+-]?$/.test(val)) {
        // YAML block scalar (>- / |) — join the following indented lines
        const lines = fm[1].split("\n");
        const start = lines.findIndex((l) => /^description:/.test(l)) + 1;
        const buf: string[] = [];
        for (let i = start; i < lines.length && /^\s+\S/.test(lines[i]); i++) buf.push(lines[i].trim());
        val = buf.join(" ");
      }
      if (val) return val.replace(/^["']|["']$/g, "").slice(0, 300);
    }
  }
  const line = text.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
  return (line ?? "").trim().slice(0, 300);
}

export interface SkillSyncResult {
  linked: string[];
  removed: string[];
  skipped: string[];
  links: string[];
}

/**
 * Symlink each skill into linkDir (e.g. ~/.claude/skills).
 * Only removes links we created (prevLinks). Never touches real directories.
 */
export function syncSkillLinks(
  skills: SkillInfo[],
  linkDir: string,
  prevLinks: string[],
  dryRun: boolean
): SkillSyncResult {
  const res: SkillSyncResult = { linked: [], removed: [], skipped: [], links: [] };
  if (!dryRun) fs.mkdirSync(linkDir, { recursive: true });

  const wanted = new Map(skills.map((s) => [path.join(linkDir, s.name), s.dir]));

  // Remove stale links we own.
  for (const link of prevLinks) {
    if (wanted.has(link)) continue;
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) {
      if (!dryRun) fs.unlinkSync(link);
      res.removed.push(link);
    }
  }

  for (const [link, target] of wanted) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(link);
    } catch {
      /* missing */
    }
    if (stat?.isSymbolicLink()) {
      if (fs.readlinkSync(link) === target) {
        res.links.push(link);
        continue; // already correct
      }
      if (!dryRun) fs.unlinkSync(link);
    } else if (stat) {
      res.skipped.push(`${link} exists and is not a symlink — left alone`);
      continue;
    }
    if (!dryRun) fs.symlinkSync(target, link);
    res.linked.push(link);
    res.links.push(link);
  }
  return res;
}
