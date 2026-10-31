import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { Artboard, XdDoc, childrenOf, openXd, readJson, assertInsideRoots } from "./xd.js";
import { artboardGeometry, listComponents, sharedAssets } from "./export.js";

type Json = any;

/* ---------- flat layer index ---------- */

export interface Layer {
  id: string;
  name?: string;
  type: string; // artboard | group | rectangle | ellipse | line | path | text | boolean
  artboardId: string;
  artboardName: string;
  parentId?: string;
  x: number; // artboard-relative
  y: number;
  w: number;
  h: number;
  order: number; // paint order (higher = on top)
  fill?: { hex: string; alpha: number };
  stroke?: { hex: string; width?: number };
  text?: string;
  font?: { family?: string; style?: string; size?: number };
  fontSize?: number;
  radius?: number;
  shadows?: { x: number; y: number; blur: number; hex: string; alpha: number }[];
  interactive: boolean;
  imageFill?: boolean; // filled with a picture: background colour unknown
  runFills?: string[]; // per-run text colours (override the base fill)
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const rgbHex = (c: Json): { hex: string; alpha: number } | undefined => {
  const v = c?.value;
  if (!v || typeof v.r !== "number") return undefined;
  return { hex: `#${hex2(v.r)}${hex2(v.g)}${hex2(v.b)}`, alpha: c.alpha ?? 1 };
};
const solid = (p: Json) => (p?.type === "solid" ? rgbHex(p.color) : undefined);

const layerCache = new WeakMap<XdDoc, Map<string, Layer[]>>();

export async function collectLayers(doc: XdDoc, ab: Artboard): Promise<Layer[]> {
  let perDoc = layerCache.get(doc);
  if (!perDoc) layerCache.set(doc, (perDoc = new Map()));
  const hit = perDoc.get(ab.id);
  if (hit) return hit;

  const agc = await readJson(doc, ab.path);
  const geoMap = await artboardGeometry(doc);
  const out: Layer[] = [];
  let order = 0;

  const visit = (n: Json, origin: { x: number; y: number }, parentId: string | undefined): { x: number; y: number; w: number; h: number } | undefined => {
    if (n.visible === false && n.type !== "artboard") return undefined; // hidden layers (and their children) are skipped
    const ux = n.meta?.ux ?? {};
    const t = n.transform ?? {};
    const a = t.a ?? 1, b = t.b ?? 0, c = t.c ?? 0, d = t.d ?? 1, tx = t.tx ?? 0, ty = t.ty ?? 0;
    const style = n.style ?? {};
    const layer: Layer = {
      id: n.id,
      name: n.name,
      type: n.type,
      artboardId: ab.id,
      artboardName: ab.name,
      parentId,
      x: origin.x + tx,
      y: origin.y + ty,
      w: 0,
      h: 0,
      order: order++,
      interactive: !!(ux.interactions && ux.interactions.length),
    };
    const f = solid(style.fill);
    if (f) layer.fill = f;
    if (style.fill?.type === "pattern") layer.imageFill = true;
    const sc = solid(style.stroke);
    if (sc) layer.stroke = { hex: sc.hex, width: style.stroke?.width };
    const shadows = (style.filters ?? [])
      .filter((x: Json) => x?.type === "dropShadow" && x.visible !== false)
      .flatMap((x: Json) => x.params?.dropShadows ?? [])
      .map((s: Json) => ({ x: s.dx, y: s.dy, blur: s.r, ...(rgbHex(s.color) ?? { hex: "#000000", alpha: 1 }) }));
    if (shadows.length) layer.shadows = shadows;
    out.push(layer);

    const s = n.shape;
    if (n.type === "shape" && s) {
      layer.type = ({ rect: "rectangle", circle: "ellipse", ellipse: "ellipse", line: "line", path: "path", compound: "boolean" } as Json)[s.type] ?? s.type;
      let bx = s.x ?? 0, by = s.y ?? 0, bw = s.width ?? 0, bh = s.height ?? 0;
      if (s.type === "circle") ({ bx, by, bw, bh } = { bx: s.cx - s.r, by: s.cy - s.r, bw: s.r * 2, bh: s.r * 2 });
      if (s.type === "ellipse") ({ bx, by, bw, bh } = { bx: s.cx - s.rx, by: s.cy - s.ry, bw: s.rx * 2, bh: s.ry * 2 });
      if (s.type === "line") ({ bx, by, bw, bh } = { bx: Math.min(s.x1, s.x2), by: Math.min(s.y1, s.y2), bw: Math.abs(s.x2 - s.x1), bh: Math.abs(s.y2 - s.y1) });
      if (s.type === "path" || s.type === "compound") {
        const nums = typeof s.path === "string" ? s.path.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) : undefined;
        if (nums && nums.length >= 2) {
          const xs = nums.filter((_: number, i: number) => i % 2 === 0), ys = nums.filter((_: number, i: number) => i % 2 === 1);
          bx = Math.min(...xs); by = Math.min(...ys); bw = Math.max(...xs) - bx; bh = Math.max(...ys) - by;
        }
      }
      layer.x = origin.x + a * bx + c * by + tx;
      layer.y = origin.y + b * bx + d * by + ty;
      layer.w = Math.abs(bw * a);
      layer.h = Math.abs(bh * d);
      if (s.type === "rect" && s.r != null) layer.radius = Array.isArray(s.r) ? Math.max(...s.r) : s.r;
      return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    }
    if (n.type === "text") {
      const content: string = n.text?.rawText ?? "";
      layer.text = content;
      const font = style.font;
      if (font) {
        layer.font = { family: font.family, style: font.style, size: font.size };
        layer.fontSize = font.size;
      }
      const runs = new Set<string>();
      for (const p of n.text?.paragraphs ?? []) for (const line of p.lines ?? []) for (const r of line) { const rc = solid(r.style?.fill); if (rc) runs.add(rc.hex); }
      if (runs.size) layer.runFills = [...runs];
      const size = font?.size ?? 14;
      layer.w = n.text?.frame?.width ?? Math.min(content.length, 60) * size * 0.55; // point text: estimated
      layer.h = n.text?.frame?.height ?? size * 1.3;
      return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    }

    // group / artboard: children live in this node's local space
    const childOrigin = { x: origin.x + tx, y: origin.y + ty };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of childrenOf(n)) {
      const bb = visit(k, childOrigin, n.id);
      if (!bb) continue;
      x0 = Math.min(x0, bb.x); y0 = Math.min(y0, bb.y); x1 = Math.max(x1, bb.x + bb.w); y1 = Math.max(y1, bb.y + bb.h);
    }
    if (ux.width != null && ux.height != null) {
      layer.w = ux.width;
      layer.h = ux.height;
    } else if (x1 > x0) {
      layer.x = x0; layer.y = y0; layer.w = x1 - x0; layer.h = y1 - y0;
    }
    return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
  };

  for (const root of agc?.children ?? []) {
    const g = geoMap[root.artboard?.ref];
    // top-level layers hold canvas coordinates: shift so (0,0) is the artboard's corner
    const start = { x: -(g?.x ?? 0), y: -(g?.y ?? 0) };
    const idx = out.length;
    visit({ ...root, transform: undefined }, start, undefined);
    const rootLayer = out[idx];
    rootLayer.x = 0;
    rootLayer.y = 0;
    if (g) { rootLayer.w = g.width; rootLayer.h = g.height; }
  }
  perDoc.set(ab.id, out);
  return out;
}

async function allLayers(doc: XdDoc, artboard?: Artboard): Promise<Layer[]> {
  const abs = artboard ? [artboard] : doc.artboards;
  const out: Layer[] = [];
  for (const ab of abs) out.push(...(await collectLayers(doc, ab)));
  return out;
}

/* ---------- design system ---------- */

const bump = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const ranked = <K>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);

export async function designSystem(doc: XdDoc, format: "json" | "css" | "tailwind") {
  const layers = await allLayers(doc);
  const colors = new Map<string, { fill: number; text: number; stroke: number }>();
  const addColor = (hex: string | undefined, role: "fill" | "text" | "stroke") => {
    if (!hex) return;
    const e = colors.get(hex) ?? { fill: 0, text: 0, stroke: 0 };
    e[role]++;
    colors.set(hex, e);
  };
  const type = new Map<string, number>();
  const radii = new Map<number, number>();
  const strokeWidths = new Map<number, number>();
  const shadows = new Map<string, number>();
  for (const l of layers) {
    if (l.type === "artboard") { addColor(l.fill?.hex, "fill"); continue; }
    addColor(l.fill?.hex, l.type === "text" ? "text" : "fill");
    addColor(l.stroke?.hex, "stroke");
    if (l.font) bump(type, `${l.font.family ?? "?"}|${l.font.style ?? ""}|${l.font.size ?? ""}`);
    if (l.radius) bump(radii, l.radius);
    if (l.stroke?.width) bump(strokeWidths, l.stroke.width);
    for (const s of l.shadows ?? []) bump(shadows, `${s.x}|${s.y}|${s.blur}|${s.hex}|${Math.round(s.alpha * 100) / 100}`);
  }
  const shared = await sharedAssets(doc);
  const libNames = new Map<string, string>();
  for (const c of (shared as Json).libraryColors ?? []) if (c.name) libNames.set(c.color, c.name);

  const colorList = [...colors.entries()]
    .map(([hex, r]) => ({ hex, uses: r.fill + r.text + r.stroke, ...r }))
    .sort((a, b) => b.uses - a.uses)
    .map((c, i) => ({ token: libNames.get(c.hex) ?? `color-${i + 1}`, ...c }));
  const typography = ranked(type).map(([k, uses], i) => {
    const [family, style, size] = k.split("|");
    return { token: `text-${i + 1}`, family, style, size: Number(size), uses };
  });
  const sizes = [...new Set(typography.map((t) => t.size).filter((s) => s > 0))].sort((a, b) => a - b);
  const radiusList = ranked(radii).map(([v, uses]) => ({ value: v, uses }));
  const shadowList = ranked(shadows).map(([k, uses], i) => {
    const [x, y, blur, hex, alpha] = k.split("|");
    return { token: `shadow-${i + 1}`, x: Number(x), y: Number(y), blur: Number(blur), color: hex, alpha: Number(alpha), uses };
  });
  const system = {
    colors: colorList,
    typography: { styles: typography, sizeScale: sizes, families: [...new Set(typography.map((t) => t.family))] },
    radii: radiusList,
    strokeWidths: ranked(strokeWidths).map(([value, uses]) => ({ value, uses })),
    shadows: shadowList,
    savedSwatches: (shared as Json).colorSwatches ?? [],
  };
  if (format === "json") return system;

  const rgba = (hex: string, a: number) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  const shadowCss = (s: (typeof shadowList)[number]) => `${s.x}px ${s.y}px ${s.blur}px ${rgba(s.color, s.alpha)}`;
  if (format === "css") {
    const lines = [":root {"];
    for (const c of colorList) lines.push(`  --${safeToken(c.token)}: ${c.hex};`);
    for (const s of sizes) lines.push(`  --font-size-${s}: ${s}px;`);
    for (const r of radiusList) lines.push(`  --radius-${r.value}: ${r.value}px;`);
    for (const s of shadowList) lines.push(`  --${s.token}: ${shadowCss(s)};`);
    lines.push("}");
    return lines.join("\n");
  }
  // tailwind: theme.extend
  return {
    theme: {
      extend: {
        colors: Object.fromEntries(colorList.map((c) => [safeToken(c.token), c.hex])),
        fontSize: Object.fromEntries(sizes.map((s) => [String(s), `${s}px`])),
        fontFamily: Object.fromEntries(system.typography.families.map((f, i) => [`family-${i + 1}`, [f]])),
        borderRadius: Object.fromEntries(radiusList.map((r) => [String(r.value), `${r.value}px`])),
        boxShadow: Object.fromEntries(shadowList.map((s) => [s.token, shadowCss(s)])),
      },
    },
  };
}

/** Token names come from file content: keep them to safe identifier characters. */
const safeToken = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "token";

/* ---------- audit ---------- */

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
export const contrastRatio = (a: string, b: string) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const dist = (a: string, b: string) => {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  return Math.hypot(((x >> 16) & 255) - ((y >> 16) & 255), ((x >> 8) & 255) - ((y >> 8) & 255), (x & 255) - (y & 255));
};

export interface Finding {
  check: string;
  severity: "error" | "warning" | "info";
  artboard?: string;
  layerId?: string;
  layer?: string;
  message: string;
}

export async function audit(doc: XdDoc, artboard?: Artboard, opts: { minTapTarget?: number; minFontSize?: number; maxPerCheck?: number } = {}) {
  const minTap = opts.minTapTarget ?? 44;
  const minFont = opts.minFontSize ?? 11;
  const cap = opts.maxPerCheck ?? 25;
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};
  const push = (f: Finding) => {
    counts[f.check] = (counts[f.check] ?? 0) + 1;
    if (counts[f.check] <= cap) findings.push(f);
  };

  const abs = artboard ? [artboard] : doc.artboards;
  const everything: Layer[] = [];
  for (const ab of abs) {
    const layers = await collectLayers(doc, ab);
    everything.push(...layers);
    const base = layers.find((l) => l.type === "artboard")?.fill?.hex ?? "#ffffff";
    const painted = layers.filter((l) => ((l.fill && l.fill.alpha >= 0.95) || l.imageFill) && l.type !== "text" && l.type !== "group" && l.w > 0 && l.h > 0);
    for (const l of layers) {
      const where = { artboard: ab.name, layerId: l.id, layer: l.name };
      if (l.type === "text" && l.text?.trim()) {
        if (l.fontSize && l.fontSize < minFont) push({ check: "small-text", severity: "warning", ...where, message: `Text is ${l.fontSize}px (minimum ${minFont}px).` });
        if (/lorem ipsum|dolor sit amet/i.test(l.text)) push({ check: "placeholder-text", severity: "warning", ...where, message: "Placeholder (lorem ipsum) text." });
        const textColors = l.runFills ?? (l.fill ? [l.fill.hex] : []);
        if (textColors.length) {
          const cx = l.x + Math.min(l.w, 40) / 2, cy = l.y + l.h / 2;
          let bg: string | undefined = base;
          for (const p of painted) if (p.order < l.order && p.type !== "artboard" && cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h) bg = p.fill ? p.fill.hex : undefined; // last one wins = topmost; a picture means unknown
          if (bg === undefined) continue;
          const worst = textColors.reduce((a, c) => (contrastRatio(c, bg!) < contrastRatio(a, bg!) ? c : a));
          const ratio = contrastRatio(worst, bg);
          const large = (l.fontSize ?? 0) >= 18 || ((l.fontSize ?? 0) >= 14 && /bold|black|heavy/i.test(l.font?.style ?? ""));
          const need = large ? 3 : 4.5;
          if (ratio < need) push({ check: "low-contrast", severity: ratio < 3 ? "error" : "warning", ...where, message: `Contrast ${ratio.toFixed(2)}:1 for ${worst} on ${bg} (needs ${need}:1). Background is estimated.` });
        }
      }
      if (l.interactive && l.type !== "artboard" && (l.w < minTap || l.h < minTap) && l.w > 0)
        push({ check: "small-tap-target", severity: "info", ...where, message: `Interactive layer is ${Math.round(l.w)}x${Math.round(l.h)}px (recommended at least ${minTap}x${minTap}px on touch screens).` });
      if (l.name && /^(Rectangle|Ellipse|Group|Path|Line|Polygon|Compound Shape|Component)\s?\d+$/i.test(l.name) && l.type !== "artboard")
        counts["default-layer-name"] = (counts["default-layer-name"] ?? 0) + 1;
    }
  }

  // document-level checks
  const colorUses = new Map<string, number>();
  const fontFamilies = new Map<string, number>();
  const sizes = new Set<number>();
  for (const l of everything) {
    if (l.type === "artboard") continue;
    if (l.fill) bump(colorUses, l.fill.hex);
    if (l.stroke) bump(colorUses, l.stroke.hex);
    if (l.font?.family) bump(fontFamilies, l.font.family);
    if (l.fontSize) sizes.add(l.fontSize);
  }
  const byUse = ranked(colorUses);
  const near = new Set<string>();
  for (const [hex, uses] of byUse) {
    if (near.has(hex)) continue;
    for (const [other, ou] of byUse) {
      if (other === hex || near.has(other) || ou >= uses) continue;
      const d = dist(hex, other);
      if (d > 0 && d <= 10) {
        near.add(other);
        push({ check: "near-duplicate-color", severity: "info", message: `${other} (${ou} uses) is almost identical to ${hex} (${uses} uses). Consider merging.` });
      }
    }
  }
  if (fontFamilies.size > 3) push({ check: "too-many-fonts", severity: "warning", message: `${fontFamilies.size} font families used: ${[...fontFamilies.keys()].join(", ")}.` });
  if (sizes.size > 10) push({ check: "too-many-font-sizes", severity: "info", message: `${sizes.size} different font sizes used. A type scale usually needs 6-8.` });
  if (counts["default-layer-name"])
    findings.push({ check: "default-layer-names", severity: "info", message: `${counts["default-layer-name"]} layers still have default names like "Rectangle 12" or "Group 3".` });

  const summary = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v]));
  return { artboardsChecked: abs.length, layersChecked: everything.length, summary, shown: findings.length, findings, note: `At most ${cap} findings per check are listed; see summary for totals. Contrast uses an estimated background.` };
}

/* ---------- search ---------- */

export async function findLayers(
  doc: XdDoc,
  q: { text?: string; name?: string; color?: string; type?: string; artboard?: Artboard; limit?: number },
) {
  const limit = q.limit ?? 50;
  const text = q.text?.toLowerCase(), name = q.name?.toLowerCase(), type = q.type?.toLowerCase();
  const color = q.color && /^#[0-9a-f]{6}$/i.test(q.color) ? q.color.toLowerCase() : undefined;
  if (q.color && !color) throw new Error("color must look like #rrggbb");
  const hits: Json[] = [];
  let total = 0;
  for (const l of await allLayers(doc, q.artboard)) {
    if (l.type === "artboard") continue;
    if (type && l.type !== type) continue;
    if (text && !l.text?.toLowerCase().includes(text)) continue;
    if (name && !l.name?.toLowerCase().includes(name)) continue;
    if (color && !(l.fill && dist(l.fill.hex, color) <= 6) && !(l.stroke && dist(l.stroke.hex, color) <= 6)) continue;
    total++;
    if (hits.length < limit)
      hits.push({ artboard: l.artboardName, id: l.id, name: l.name, type: l.type, text: l.text, fill: l.fill?.hex, x: Math.round(l.x), y: Math.round(l.y), width: Math.round(l.w), height: Math.round(l.h) });
  }
  return { total, shown: hits.length, results: hits };
}

/* ---------- copy deck ---------- */

const csvCell = (v: string) => {
  let s = v.replace(/\r?\n/g, "\n");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralize spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};

export async function copyDeck(doc: XdDoc, artboard: Artboard | undefined, format: "json" | "csv") {
  const rows: { artboard: string; layer: string; id: string; text: string }[] = [];
  for (const l of await allLayers(doc, artboard)) if (l.type === "text" && l.text?.trim()) rows.push({ artboard: l.artboardName, layer: l.name ?? "", id: l.id, text: l.text });
  if (format === "json") return { count: rows.length, rows };
  return ["artboard,layer,id,text", ...rows.map((r) => [r.artboard, r.layer, r.id, r.text].map(csvCell).join(","))].join("\n");
}

/* ---------- prototype flow ---------- */

const mermaidLabel = (s: string) => s.replace(/[^\p{L}\p{N} _.,&/()-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "screen";

export async function flowMap(doc: XdDoc) {
  const entry = doc.entries.find((e) => e === "interactions/interactions.json");
  if (!entry) return { home: null, edges: [], note: "No prototype interactions in this file." };
  const ij = await readJson(doc, entry);
  const names = new Map(doc.artboards.map((a) => [a.id.replace(/^artboard-/, ""), a.name]));
  const owner = new Map<string, Layer>();
  for (const ab of doc.artboards) for (const l of await collectLayers(doc, ab)) owner.set(l.id, l);

  const edges: Json[] = [];
  for (const [layerId, list] of Object.entries<Json>(ij.interactions ?? {})) {
    const src = owner.get(layerId);
    for (const i of list as Json[]) {
      const p = i.properties ?? {};
      edges.push({
        fromArtboard: src?.artboardName ?? "(unknown)",
        fromLayer: src?.name,
        fromLayerId: layerId,
        trigger: i.triggerEvent,
        action: i.action,
        toArtboard: names.get(p.destination) ?? undefined,
        destinationId: p.destination,
        transition: p.transition ?? undefined,
        duration: p.duration,
        easing: p.easing,
        delay: p.delay,
      });
    }
  }

  // artboard-to-artboard graph (state changes inside a screen are not drawn)
  const ids = new Map<string, string>();
  const idOf = (n: string) => ids.get(n) ?? (ids.set(n, "s" + ids.size), ids.get(n)!);
  const seen = new Set<string>();
  const lines = ["flowchart LR"];
  for (const e of edges) {
    if (!e.toArtboard || e.fromArtboard === "(unknown)" || e.fromArtboard === e.toArtboard) continue;
    const key = `${e.fromArtboard}>${e.toArtboard}>${e.trigger}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${idOf(e.fromArtboard)}["${mermaidLabel(e.fromArtboard)}"] -->|${mermaidLabel(String(e.trigger ?? ""))}| ${idOf(e.toArtboard)}["${mermaidLabel(e.toArtboard)}"]`);
  }
  const home = typeof ij.homeArtboard === "string" ? names.get(ij.homeArtboard) ?? ij.homeArtboard : null;
  return { home, edgeCount: edges.length, edges: edges.slice(0, 500), truncated: edges.length > 500, mermaid: lines.join("\n") };
}

/* ---------- project overview ---------- */

export async function projectOverview(dir: string, maxFiles = 60) {
  const root = await assertInsideRoots(dir);
  const found: string[] = [];
  const scan = async (d: string, depth: number) => {
    if (found.length >= maxFiles || depth > 3) return;
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the allowed roots
      if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) await scan(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".xd") && found.length < maxFiles) found.push(full);
    }
  };
  await scan(root, 0);
  const files: Json[] = [];
  for (const f of found) {
    try {
      const doc = await openXd(f);
      const st = await lstat(f);
      files.push({
        file: path.relative(root, f) || path.basename(f),
        name: doc.manifest?.name,
        sizeMB: Math.round((st.size / 1048576) * 10) / 10,
        artboards: doc.artboards.length,
        components: (await listComponents(doc)).length,
        hasInteractions: doc.entries.includes("interactions/interactions.json"),
      });
    } catch (e) {
      files.push({ file: path.relative(root, f), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { folder: root, count: files.length, files, truncated: found.length >= maxFiles };
}
