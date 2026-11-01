import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Artboard, XdDoc, readEntry } from "./xd.js";
import { ExportNode, exportWhole } from "./export.js";

/**
 * Renders an exported artboard to ONE self-contained SVG (nested groups, clip paths, gradients,
 * data-URI images, text tspans, shadow filters) and screenshots it with a locally installed
 * Chromium-based browser (Chrome or Edge) running headless. Nothing leaves the machine: the browser is
 * started with name resolution disabled, and the SVG only contains data it was generated from.
 */

type Json = any;

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const n = (v: unknown, d = 3) => {
  const x = Number(v);
  return Number.isFinite(x) ? String(Math.round(x * 10 ** d) / 10 ** d) : "0";
};
/** Only accept #rrggbb colours in attributes. */
const col = (c: unknown) => (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#000000");

interface Img {
  uri: string;
  width: number;
  height: number;
}

interface RCtx {
  defs: string[];
  images: Map<string, Img>;
  usedImages: Set<string>;
  seq: number;
  fontFallback: string;
}

const uid = (c: RCtx, p: string) => `${p}${c.seq++}`;

/* ---------- font helpers ---------- */

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold|heavy/i, 800],
  [/black/i, 900],
  [/bold/i, 700],
  [/medium/i, 500],
];

export function weightOf(style?: string): number {
  for (const [re, w] of WEIGHTS) if (re.test(style ?? "")) return w;
  return 400;
}

const isItalic = (style?: string) => /italic|oblique/i.test(style ?? "");

/* ---------- paints ---------- */

function paintAttr(c: RCtx, paint: Json, box: { x: number; y: number; width: number; height: number }): { value: string; opacity?: number } {
  if (!paint) return { value: "none" };
  if (paint.type === "solid") return { value: col(paint.color), opacity: paint.opacity };
  if (paint.type === "gradient") {
    const id = uid(c, "g");
    const stops = (paint.stops ?? [])
      .map((s: Json) => `<stop offset="${n(s.offset)}" stop-color="${col(s.color)}" stop-opacity="${n(s.opacity ?? 1)}"/>`)
      .join("");
    const units = paint.units === "userSpaceOnUse" ? "userSpaceOnUse" : "objectBoundingBox";
    const gt = paint.transform ? ` gradientTransform="matrix(${[paint.transform.a, paint.transform.b, paint.transform.c, paint.transform.d, paint.transform.tx, paint.transform.ty].map((v) => n(v ?? 0, 5)).join(" ")})"` : "";
    if (paint.kind === "radial")
      c.defs.push(`<radialGradient id="${id}" gradientUnits="${units}" cx="${n(paint.cx ?? 0.5, 5)}" cy="${n(paint.cy ?? 0.5, 5)}" r="${n(paint.r ?? 0.5, 5)}" fx="${n(paint.fx ?? paint.cx ?? 0.5, 5)}" fy="${n(paint.fy ?? paint.cy ?? 0.5, 5)}"${gt}>${stops}</radialGradient>`);
    else
      c.defs.push(`<linearGradient id="${id}" gradientUnits="${units}" x1="${n(paint.x1 ?? 0, 5)}" y1="${n(paint.y1 ?? 0, 5)}" x2="${n(paint.x2 ?? 1, 5)}" y2="${n(paint.y2 ?? 0, 5)}"${gt}>${stops}</linearGradient>`);
    return { value: `url(#${id})` };
  }
  if (paint.type === "image") {
    const img = paint.imageRef ? c.images.get(paint.imageRef) : undefined;
    if (!img) return { value: "#cccccc" };
    c.usedImages.add(paint.imageRef);
    const id = uid(c, "p");
    const sw = paint.sourceWidth ?? img.width, sh = paint.sourceHeight ?? img.height;
    const { x, y, width: w, height: h } = box;
    let tf: string;
    let pw = w, ph = h;
    if (paint.scaleBehavior === "fill") tf = `translate(${n(x)} ${n(y)}) scale(${n(w / sw, 5)} ${n(h / sh, 5)})`;
    else if (paint.scaleBehavior === "tile") {
      tf = `translate(${n(x)} ${n(y)})`;
      pw = sw; ph = sh;
    } else {
      const s = Math.max(w / sw, h / sh); // cover
      tf = `translate(${n(x + (w - sw * s) / 2)} ${n(y + (h - sh * s) / 2)}) scale(${n(s, 5)})`;
    }
    const flip = paint.flipX || paint.flipY ? `<g transform="translate(${paint.flipX ? n(x * 2 + w) : 0} ${paint.flipY ? n(y * 2 + h) : 0}) scale(${paint.flipX ? -1 : 1} ${paint.flipY ? -1 : 1})">` : "";
    c.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${n(x)}" y="${n(y)}" width="${n(pw)}" height="${n(ph)}">${flip}<use href="#img-${esc(paint.imageRef)}" transform="${tf}"/>${flip ? "</g>" : ""}</pattern>`);
    return { value: `url(#${id})` };
  }
  return { value: "#cccccc" };
}

/* ---------- geometry ---------- */

function roundedRect(x: number, y: number, w: number, h: number, r: number | number[]): string {
  const rs = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.max(0, Math.min(Number(v) || 0, w / 2, h / 2)));
  const [tl, tr, br, bl] = [rs[0] ?? 0, rs[1] ?? rs[0] ?? 0, rs[2] ?? rs[0] ?? 0, rs[3] ?? rs[0] ?? 0];
  return `M${n(x + tl)} ${n(y)}H${n(x + w - tr)}A${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)}V${n(y + h - br)}A${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)}H${n(x + bl)}A${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)}V${n(y + tl)}A${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}Z`;
}

const matrixAttr = (m: Json) => `matrix(${[m.a, m.b, m.c, m.d, m.tx, m.ty].map((v) => n(v ?? 0, 6)).join(" ")})`;

/** Shape element in the node's local space. `attrs` is a ready-made attribute string. */
function geom(node: ExportNode, attrs: string, tf?: string): string {
  const t = tf ? ` transform="${tf}"` : "";
  const b = node.localBox ?? { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
  switch (node.type) {
    case "rectangle": {
      const r = node.cornerRadius;
      if (Array.isArray(r)) return `<path${t} d="${roundedRect(b.x, b.y, b.width, b.height, r)}" ${attrs}/>`;
      const rr = Math.max(0, Math.min(Number(r) || 0, b.width / 2, b.height / 2));
      return `<rect${t} x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}"${rr ? ` rx="${n(rr)}"` : ""} ${attrs}/>`;
    }
    case "ellipse":
      return `<ellipse${t} cx="${n(b.x + b.width / 2)}" cy="${n(b.y + b.height / 2)}" rx="${n(b.width / 2)}" ry="${n(b.height / 2)}" ${attrs}/>`;
    case "line": {
      const p = node.points ?? [];
      return p.length === 2 ? `<line${t} x1="${n(p[0].x)}" y1="${n(p[0].y)}" x2="${n(p[1].x)}" y2="${n(p[1].y)}" ${attrs}/>` : "";
    }
    case "path":
    case "boolean":
      return node.svgPathLocal ? `<path transform="${tf ? tf + " " : ""}translate(${n(b.x)} ${n(b.y)})" d="${esc(node.svgPathLocal)}"${node.fillRule ? ` fill-rule="${node.fillRule === "evenodd" ? "evenodd" : "nonzero"}"` : ""} ${attrs}/>` : "";
  }
  return "";
}

function shadowFilter(c: RCtx, effects: Json[] | undefined): string | undefined {
  const shadows = (effects ?? []).filter((e) => e.type === "dropShadow" && e.visible !== false).flatMap((e) => e.shadows ?? []);
  if (!shadows.length) return undefined;
  const id = uid(c, "f");
  const parts = shadows.map(
    (s: Json, i: number) =>
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${n((s.blur ?? 0) / 2)}" result="b${i}"/><feOffset in="b${i}" dx="${n(s.x)}" dy="${n(s.y)}" result="o${i}"/><feFlood flood-color="${col(s.color)}" flood-opacity="${n(s.alpha ?? 1)}" result="c${i}"/><feComposite in="c${i}" in2="o${i}" operator="in" result="s${i}"/>`,
  );
  const merge = shadows.map((_: Json, i: number) => `<feMergeNode in="s${i}"/>`).join("") + `<feMergeNode in="SourceGraphic"/>`;
  c.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${parts.join("")}<feMerge>${merge}</feMerge></filter>`);
  return id;
}

/* ---------- text ---------- */

function renderText(c: RCtx, node: ExportNode): string {
  const t = node.text;
  const box = node.box ?? { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 };
  const size = t.font?.size ?? 14;
  const lh = t.lineHeight ?? size * 1.17;
  const fill = (node.fills ?? [])[0];
  const baseColor = fill?.type === "solid" ? col(fill.color) : fill?.type === "gradient" ? col(fill.stops?.[0]?.color) : "#000000";
  const baseOpacity = fill?.type === "solid" ? fill.opacity : 1;
  const family = `${esc(t.font?.family ?? "sans-serif")}, ${c.fontFallback}`;
  const weight = weightOf(t.font?.style);
  const lines: string[] = String(t.characters ?? "").split("\n");
  const anchor = t.alignment === "right" ? "end" : t.alignment === "center" ? "middle" : "start";
  const ax = anchor === "end" ? box.x + box.width : anchor === "middle" ? box.x + box.width / 2 : box.x;
  const spacing = t.letterSpacing?.px ? ` letter-spacing="${n(t.letterSpacing.px)}"` : "";
  const runs: Json[] = t.styledRuns ?? [];

  let offset = 0;
  const out: string[] = [];
  lines.forEach((line, li) => {
    const y = (t.baselineY ?? box.y + size) + li * lh;
    const start = offset, end = offset + line.length;
    offset = end + 1;
    // split the line at run boundaries
    const cuts = new Set<number>([start, end]);
    for (const r of runs) for (const p of [r.from, r.to]) if (p > start && p < end) cuts.add(p);
    const pts = [...cuts].sort((a, b) => a - b);
    const spans: string[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const seg = line.slice(a - start, b - start);
      const r = runs.filter((x) => x.from <= a && x.to >= b).reduce((acc: Json, x: Json) => ({ ...acc, ...x }), {});
      const at = [
        r.color ? `fill="${col(r.color)}"` : "",
        r.size ? `font-size="${n(r.size)}"` : "",
        r.weight ? `font-weight="${weightOf(r.weight)}"${isItalic(r.weight) ? ' font-style="italic"' : ""}` : "",
        r.family ? `font-family="${esc(r.family)}, ${c.fontFallback}"` : "",
        r.underline ? `text-decoration="underline"` : "",
        r.strikethrough ? `text-decoration="line-through"` : "",
      ].filter(Boolean).join(" ");
      spans.push(`<tspan${i === 0 ? ` x="${n(ax)}" y="${n(y)}"` : ""}${at ? " " + at : ""}>${esc(seg)}</tspan>`);
    }
    if (!spans.length) spans.push(`<tspan x="${n(ax)}" y="${n(y)}"> </tspan>`);
    out.push(...spans);
  });
  const deco = t.underline ? ` text-decoration="underline"` : "";
  return `<text xml:space="preserve" font-family="${family}" font-size="${n(size)}" font-weight="${weight}"${isItalic(t.font?.style) ? ' font-style="italic"' : ""} fill="${baseColor}"${baseOpacity != null && baseOpacity !== 1 ? ` fill-opacity="${n(baseOpacity)}"` : ""} text-anchor="${anchor}"${spacing}${deco}>${out.join("")}</text>`;
}

/* ---------- tree ---------- */

function styleAttrs(node: ExportNode): string {
  const parts: string[] = [];
  if (node.opacity != null && node.opacity !== 1) parts.push(`opacity="${n(node.opacity)}"`);
  if (["multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"].includes(node.blendMode))
    parts.push(`style="mix-blend-mode:${node.blendMode}"`);
  return parts.join(" ");
}

function maskClip(c: RCtx, mask: Json): string {
  const shapes: Json[] = mask.shapes ?? [mask];
  const id = uid(c, "m");
  const els = shapes
    .map((s) => {
      const node: ExportNode = { type: s.shape, localBox: s.localBox, width: s.width, height: s.height, cornerRadius: s.radius, svgPathLocal: s.svgPathLocal, points: s.points } as ExportNode;
      const lb = s.localBox ?? { x: 0, y: 0 };
      // clipPath children must be shapes (a <g> would be ignored and clip everything away)
      return geom(node, "", s.transform ? origin(s.transform, s.x, s.y, lb.x, lb.y) : `translate(${n((s.x ?? 0) - lb.x)} ${n((s.y ?? 0) - lb.y)})`);
    })
    .join("");
  c.defs.push(`<clipPath id="${id}">${els}</clipPath>`);
  return id;
}

/** matrix(a b c d ox oy) so that the local box corner (bx,by) lands on the exported (x,y). */
function origin(m: Json, x: number, y: number, bx: number, by: number): string {
  const ox = x - (m.a * bx + m.c * by);
  const oy = y - (m.b * bx + m.d * by);
  return `matrix(${[m.a, m.b, m.c, m.d].map((v) => n(v, 6)).join(" ")} ${n(ox)} ${n(oy)})`;
}

function renderNode(c: RCtx, node: ExportNode): string {
  if (node.visible === false || node.type === "unresolvedRef") return "";
  const sa = styleAttrs(node);
  const filter = shadowFilter(c, node.effects);
  const wrap = (inner: string, tf?: string) => {
    const attrs = [tf ? `transform="${tf}"` : "", sa, filter ? `filter="url(#${filter})"` : ""].filter(Boolean).join(" ");
    return attrs ? `<g ${attrs}>${inner}</g>` : inner;
  };

  switch (node.type) {
    case "text":
      return wrap(renderText(c, node));
    case "rectangle":
    case "ellipse":
    case "line":
    case "path":
    case "boolean": {
      const lb = node.localBox ?? { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
      const x = node.x ?? 0, y = node.y ?? 0;
      const m = node.transform;
      const tf = m ? origin(m, x, y, lb.x, lb.y) : `translate(${n(x - lb.x)} ${n(y - lb.y)})`;
      const box = { x: lb.x, y: lb.y, width: lb.width, height: lb.height };
      const f = node.fills?.[0];
      const fp = f ? paintAttr(c, f, box) : { value: "none" };
      const fillAttrs = `fill="${fp.value}"${fp.opacity != null && fp.opacity !== 1 ? ` fill-opacity="${n(fp.opacity)}"` : ""}`;
      const s = node.strokes?.[0];
      let strokeEl = "";
      let underStroke = "";
      let fillOnly = geom(node, `${fillAttrs} stroke="none"`);
      if (node.type === "boolean" && !node.svgPathLocal) fillOnly = (node.children ?? []).map((k: ExportNode) => renderNode(c, k)).join("");
      if (s && s.width) {
        const sp = paintAttr(c, s, box);
        const common = `fill="none" stroke="${sp.value}"${sp.opacity != null && sp.opacity !== 1 ? ` stroke-opacity="${n(sp.opacity)}"` : ""}${s.cap ? ` stroke-linecap="${s.cap === "round" ? "round" : s.cap === "square" ? "square" : "butt"}"` : ""}${s.join ? ` stroke-linejoin="${s.join === "round" ? "round" : s.join === "bevel" ? "bevel" : "miter"}"` : ""}${s.miterLimit ? ` stroke-miterlimit="${n(s.miterLimit)}"` : ""}${Array.isArray(s.dash) && s.dash.length ? ` stroke-dasharray="${s.dash.map((d: number) => n(d)).join(" ")}"` : ""}`;
        if (s.align === "inside" && node.type !== "line") {
          const cid = uid(c, "c");
          c.defs.push(`<clipPath id="${cid}">${geom(node, "")}</clipPath>`);
          strokeEl = `<g clip-path="url(#${cid})">${geom(node, `${common} stroke-width="${n(s.width * 2)}"`)}</g>`;
        } else if (s.align === "outside" && node.type !== "line") {
          underStroke = geom(node, `${common} stroke-width="${n(s.width * 2)}"`); // the fill is drawn over the inner half
        } else strokeEl = geom(node, `${common} stroke-width="${n(s.width)}"`);
      }
      return wrap(underStroke + fillOnly + strokeEl, tf);
    }
    default: {
      // frame / group
      const kids = (node.children ?? []).map((k: ExportNode) => renderNode(c, k)).join("");
      const m = node.transform;
      const lin = m && !(m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) ? ` matrix(${[m.a, m.b, m.c, m.d].map((v) => n(v, 6)).join(" ")} 0 0)` : "";
      const tf = node.type === "frame" ? undefined : `translate(${n(node.x ?? 0)} ${n(node.y ?? 0)})${lin}`;
      let inner = kids;
      if (node.type !== "frame" && node.fills?.length) {
        const b = { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
        const fp = paintAttr(c, node.fills[0], b);
        if (b.width && b.height) inner = `<rect width="${n(b.width)}" height="${n(b.height)}" fill="${fp.value}"/>` + inner;
      }
      if (node.mask) inner = `<g clip-path="url(#${maskClip(c, node.mask)})">${inner}</g>`;
      return wrap(inner, tf);
    }
  }
}

/** Bounding box (parent space) of a non-frame subtree root, used when exporting one layer. */
function viewportOf(node: ExportNode): { x: number; y: number; width: number; height: number } {
  if (node.type === "frame") return { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (k: ExportNode, ox: number, oy: number) => {
    const w = k.width ?? 0, h = k.height ?? 0;
    const x = ox + (k.x ?? 0), y = oy + (k.y ?? 0);
    if (w && h && k.type !== "group") { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
    const isGroup = k.type === "group";
    for (const c of k.children ?? []) walk(c, isGroup ? x : ox, isGroup ? y : oy);
  };
  walk({ ...node, x: 0, y: 0 }, 0, 0);
  return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: node.width ?? 100, height: node.height ?? 100 };
}

function imageSize(b: Buffer): { width: number; height: number } {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  if (b.length > 10 && b.subarray(0, 3).toString("ascii") === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  return { width: 100, height: 100 };
}

function mimeOf(b: Buffer): string {
  if (b.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (b.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (b.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (b.subarray(0, 4).toString("ascii") === "RIFF") return "image/webp";
  if (b.subarray(0, 300).toString("utf8").includes("<svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export interface SvgResult {
  svg: string;
  width: number;
  height: number;
  missingImages: string[];
}

export async function buildSvg(doc: XdDoc, node: ExportNode, imageRefs: string[]): Promise<SvgResult> {
  const images = new Map<string, Img>();
  const missing: string[] = [];
  for (const ref of imageRefs) {
    if (!/^[0-9a-f]{16,64}$/i.test(ref) || !doc.zip.file(`resources/${ref}`)) { missing.push(ref); continue; }
    try {
      const buf = await readEntry(doc, `resources/${ref}`);
      const { width, height } = imageSize(buf);
      images.set(ref, { uri: `data:${mimeOf(buf)};base64,${buf.toString("base64")}`, width, height });
    } catch {
      missing.push(ref);
    }
  }
  const c: RCtx = { defs: [], images, usedImages: new Set(), seq: 1, fontFallback: "'Segoe UI', Arial, Helvetica, sans-serif" };
  const body = renderNode(c, node);
  const vp = viewportOf(node);
  const defImages = [...c.usedImages].map((r) => `<image id="img-${esc(r)}" width="${images.get(r)!.width}" height="${images.get(r)!.height}" href="${images.get(r)!.uri}"/>`);
  const w = Math.max(1, Math.ceil(vp.width)), h = Math.max(1, Math.ceil(vp.height));
  const bg = node.type === "frame" ? "" : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${n(vp.x)} ${n(vp.y)} ${w} ${h}">${bg}<defs>${defImages.join("")}${c.defs.join("")}</defs>${body}</svg>`;
  return { svg, width: w, height: h, missingImages: missing };
}

/* ---------- screenshot ---------- */

const WIN_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const LINUX_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];

export async function findBrowser(): Promise<string | undefined> {
  const env = process.env.XD_MCP_CHROME;
  const list = [...(env ? [env] : []), ...(process.platform === "win32" ? WIN_CANDIDATES : process.platform === "darwin" ? MAC_CANDIDATES : LINUX_CANDIDATES)];
  for (const p of list) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.end();
  });
}

const MAX_CSS_EDGE = 16384; // px of the unscaled artboard
const MAX_PNG_BYTES = 12 * 1024 * 1024;

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
  missingImages: string[];
  browser: string;
}

export async function renderArtboard(
  doc: XdDoc,
  ab: Artboard,
  opts: { scale?: number; nodeId?: string; maxEdge?: number } = {},
): Promise<RenderResult> {
  const browser = await findBrowser();
  if (!browser) throw new Error("No Chrome or Edge found. Install one, or set XD_MCP_CHROME to the browser executable.");
  const whole = await exportWhole(doc, ab, { nodeId: opts.nodeId });
  const { svg, width, height, missingImages } = await buildSvg(doc, whole.node, [...whole.images]);

  if (width > MAX_CSS_EDGE || height > MAX_CSS_EDGE)
    throw new Error(`This artboard is ${width}x${height}px, too large to render in one go (limit ${MAX_CSS_EDGE}). Render a smaller part with nodeId.`);
  const maxEdge = Math.min(opts.maxEdge ?? 4096, 8192);
  const scale = Math.max(0.05, Math.min(opts.scale ?? 1, maxEdge / Math.max(width, height), 4));
  const dir = await mkdtemp(path.join(tmpdir(), "xd-render-"));
  try {
    const svgPath = path.join(dir, "artboard.svg");
    const outPath = path.join(dir, "out.png");
    await writeFile(svgPath, svg, "utf8");
    await run(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--disable-extensions",
        "--disable-background-networking",
        "--host-resolver-rules=MAP * ~NOTFOUND", // no network, even if something tried
        `--user-data-dir=${path.join(dir, "profile")}`,
        `--force-device-scale-factor=${scale}`,
        `--window-size=${width},${height}`,
        "--virtual-time-budget=6000",
        `--screenshot=${outPath}`,
        pathToFileURL(svgPath).href,
      ],
      90_000,
    );
    const png = await readFile(outPath);
    if (png.length > MAX_PNG_BYTES) throw new Error(`The PNG is ${Math.round(png.length / 1048576)} MB; lower scale or maxEdge.`);
    return { png, width: Math.round(width * scale), height: Math.round(height * scale), scale, missingImages, browser: path.basename(browser) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
