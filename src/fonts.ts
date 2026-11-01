import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Artboard, XdDoc, arr, childrenOf, readJson, rootNodes } from "./xd.js";

/**
 * Which fonts a design uses, whether they are installed on this computer, and how to substitute a missing
 * weight. This tool only reads font NAMES. It never creates, modifies, embeds or uploads font files.
 */

type Json = any;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const STANDARD_WEIGHTS: [string, number][] = [
  ["Thin", 100],
  ["ExtraLight", 200],
  ["Light", 300],
  ["Regular", 400],
  ["Medium", 500],
  ["SemiBold", 600],
  ["Bold", 700],
  ["ExtraBold", 800],
  ["Black", 900],
];

export function weightNumber(style?: string): number {
  const s = style ?? "";
  if (/thin|hairline/i.test(s)) return 100;
  if (/extra ?light|ultra ?light/i.test(s)) return 200;
  if (/light/i.test(s)) return 300;
  if (/semi ?bold|demi ?bold/i.test(s)) return 600;
  if (/extra ?bold|ultra ?bold|heavy/i.test(s)) return 800;
  if (/black/i.test(s)) return 900;
  if (/bold/i.test(s)) return 700;
  if (/medium/i.test(s)) return 500;
  return 400;
}

/** For each standard weight the file does not use, the nearest weight it does use (ties go lighter). */
export function weightFallbacks(used: number[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!used.length) return out;
  for (const [name, w] of STANDARD_WEIGHTS) {
    if (used.includes(w)) continue;
    const best = [...used].sort((a, b) => Math.abs(a - w) - Math.abs(b - w) || a - b)[0];
    out[name] = STANDARD_WEIGHTS.find(([, x]) => x === best)![0];
  }
  return out;
}

function run(cmd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    child.stdin?.end();
  });
}

let installedCache: Promise<{ names: Set<string>; fileLike: string[]; source: string } | undefined> | undefined;

/** Installed font families, or undefined when this platform's font list couldn't be read. */
export function installedFonts() {
  installedCache ??= (async () => {
    try {
      if (process.platform === "win32") {
        const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"]);
        return { names: new Set(out.split(/\r?\n/).map(norm).filter(Boolean)), fileLike: [], source: "Windows font collection" };
      }
      try {
        const out = await run("fc-list", [":", "family"]);
        const names = new Set<string>();
        for (const line of out.split("\n")) for (const part of line.split(",")) if (part.trim()) names.add(norm(part));
        if (names.size) return { names, fileLike: [], source: "fontconfig (fc-list)" };
      } catch {
        /* fall through to directory listing */
      }
      if (process.platform === "darwin") {
        const dirs = ["/System/Library/Fonts", "/Library/Fonts", path.join(homedir(), "Library/Fonts")];
        const files: string[] = [];
        for (const d of dirs) files.push(...(await readdir(d).catch(() => [] as string[])));
        return { names: new Set<string>(), fileLike: files.map((f) => norm(f.replace(/\.[^.]+$/, ""))), source: "font folders" };
      }
    } catch {
      /* unknown */
    }
    return undefined;
  })();
  return installedCache;
}

export async function isInstalled(family: string | undefined): Promise<boolean | "unknown"> {
  if (!family) return "unknown";
  const inst = await installedFonts();
  if (!inst) return "unknown";
  const f = norm(family);
  return inst.names.has(f) || inst.fileLike.some((x) => x.startsWith(f));
}

interface Use {
  family?: string;
  postscriptName?: string;
  style?: string;
  sizes: Set<number>;
  uses: number;
  artboards: Set<string>;
}

export async function fontReport(doc: XdDoc, artboard?: Artboard) {
  const abs = artboard ? [artboard] : doc.artboards;
  const found = new Map<string, Use>();
  const add = (font: Json, where: string) => {
    if (!font || (!font.family && !font.postscriptName)) return;
    const key = `${font.postscriptName ?? font.family}|${font.style ?? ""}`;
    const e = found.get(key) ?? { family: font.family, postscriptName: font.postscriptName, style: font.style, sizes: new Set<number>(), uses: 0, artboards: new Set<string>() };
    if (typeof font.size === "number") e.sizes.add(font.size);
    e.uses++;
    e.artboards.add(where);
    found.set(key, e);
  };
  for (const ab of abs) {
    const agc = await readJson(doc, ab.path);
    const walk = (n: Json) => {
      if (n?.style?.font) add(n.style.font, ab.name);
      for (const p of arr(n?.text?.paragraphs)) for (const l of arr(p.lines)) for (const r of arr(l)) if (r?.style?.fontFamily || r?.style?.font) add(r.style.font ?? { family: r.style.fontFamily, style: r.style.fontStyle, size: r.style.fontSize }, ab.name);
      for (const c of childrenOf(n)) walk(c);
    };
    rootNodes(agc).forEach(walk);
  }

  const byFamily = new Map<string, Use[]>();
  for (const u of found.values()) {
    const k = u.family ?? u.postscriptName ?? "unknown";
    byFamily.set(k, [...(byFamily.get(k) ?? []), u]);
  }
  const families = [];
  for (const [family, uses] of byFamily) {
    const installed = await isInstalled(family);
    const weights = [...new Set(uses.map((u) => weightNumber(u.style)))].sort((a, b) => a - b);
    families.push({
      family,
      installed,
      styles: uses
        .sort((a, b) => b.uses - a.uses)
        .map((u) => ({ style: u.style, weight: weightNumber(u.style), postscriptName: u.postscriptName, sizes: [...u.sizes].sort((a, b) => a - b), uses: u.uses })),
      totalUses: uses.reduce((a, u) => a + u.uses, 0),
      artboardCount: new Set(uses.flatMap((u) => [...u.artboards])).size,
      weightFallbacks: weightFallbacks(weights),
      fallbackStack: [family, "Arial", "Helvetica", "sans-serif"],
      licenceNote:
        "Fonts are licensed software. This tool only reads the font names in the file and never creates, modifies or embeds fonts. Check the licence for this family before uploading it to another tool, and never synthesise a missing weight: use weightFallbacks instead.",
    });
  }
  families.sort((a, b) => b.totalUses - a.totalUses);
  const missing = families.filter((f) => f.installed === false).map((f) => f.family);
  const unknown = families.filter((f) => f.installed === "unknown").length;
  const inst = await installedFonts();
  return {
    artboardsScanned: abs.length,
    familyCount: families.length,
    detection: inst?.source ?? "unavailable on this system",
    missingFamilies: missing,
    warning: missing.length
      ? `${missing.length} font famil${missing.length === 1 ? "y is" : "ies are"} not installed on this computer (${missing.join(", ")}). Other tools will substitute a fallback font and text will reflow. Install or upload the licensed fonts before rebuilding, or warn the user.`
      : unknown
        ? "Couldn't check which fonts are installed on this system; verify them manually."
        : undefined,
    families,
  };
}
