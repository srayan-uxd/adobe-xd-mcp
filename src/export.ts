import { Artboard, XdDoc, childrenOf, readJson, rootNodes } from "./xd.js";

/**
 * Full-fidelity, tool-friendly export of an XD scene graph.
 * Output uses design-tool vocabulary (frame, rectangle, ellipse, path, text, fills, strokes, effects)
 * so an AI can rebuild it in Figma or similar. Anything not modelled is kept in `raw*` fields.
 */

const RES_PATH = "resources/graphics/graphicContent.agc";
const MAX_DEPTH_CAP = 64;

type Json = any;

export interface ExportNode {
  id?: string;
  type: string;
  name?: string;
  [k: string]: Json;
}

/* ---------- colors / paints ---------- */

const round = (n: any, p = 100) => (typeof n === "number" ? Math.round(n * p) / p : n);
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

function isColor(c: any): boolean {
  return c && typeof c === "object" && c.mode === "RGB" && c.value && typeof c.value.r === "number";
}

function colorOf(c: any): { color: string; alpha: number } | undefined {
  if (!isColor(c)) return undefined;
  const v = c.value;
  return { color: `#${hex2(v.r)}${hex2(v.g)}${hex2(v.b)}`, alpha: round(c.alpha ?? 1, 1000) };
}

/** Deep-copy `o`, replacing XD color objects by {color, alpha}. */
function convertColors(o: Json): Json {
  if (Array.isArray(o)) return o.map(convertColors);
  if (isColor(o)) return colorOf(o);
  if (o && typeof o === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(o)) out[k] = convertColors(v);
    return out;
  }
  return o;
}

function paintOf(p: Json, images: Set<string>): Json | undefined {
  if (!p || p.type === "none") return undefined;
  if (p.type === "solid") {
    const c = colorOf(p.color);
    return c && { type: "solid", color: c.color, opacity: c.alpha };
  }
  if (p.type === "pattern") {
    const pat = p.pattern ?? {};
    const uid = pat.meta?.ux?.uid;
    if (uid) images.add(uid);
    return {
      type: "image",
      imageRef: uid,
      scaleBehavior: pat.meta?.ux?.scaleBehavior, // "cover" | "fill" | "tile" ...
      flipX: pat.meta?.ux?.flipX,
      flipY: pat.meta?.ux?.flipY,
      sourceWidth: pat.width,
      sourceHeight: pat.height,
    };
  }
  // gradients and anything else: keep everything, colors converted
  return convertColors(p);
}

function strokeOf(s: Json, images: Set<string>): Json | undefined {
  const paint = paintOf(s, images);
  if (!paint) return undefined;
  return {
    ...paint,
    width: s.width,
    align: s.align, // inside | center | outside
    cap: s.cap,
    join: s.join,
    miterLimit: s.miterLimit,
    dash: s.dash,
    dashOffset: s.dashOffset,
  };
}

function effectsOf(style: Json): Json[] {
  const out: Json[] = [];
  for (const f of style?.filters ?? []) {
    if (f?.type === "dropShadow") {
      out.push({
        type: "dropShadow",
        visible: f.visible !== false,
        shadows: (f.params?.dropShadows ?? []).map((s: Json) => ({
          x: s.dx,
          y: s.dy,
          blur: s.r,
          ...colorOf(s.color),
        })),
      });
    } else {
      out.push({ type: f?.type ?? "unknown", visible: f?.visible !== false, params: convertColors(f?.params), raw: undefined });
    }
  }
  if (style?.blur) out.push({ type: "blur", params: convertColors(style.blur) });
  return out;
}

/* ---------- geometry ---------- */

interface M {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

const ident = (t: M) => t.a === 1 && t.b === 0 && t.c === 0 && t.d === 1;

function matrixOf(n: Json): M {
  const t = n.transform ?? {};
  return { a: t.a ?? 1, b: t.b ?? 0, c: t.c ?? 0, d: t.d ?? 1, tx: t.tx ?? 0, ty: t.ty ?? 0 };
}

function pathBounds(d: string): { x: number; y: number; width: number; height: number } | undefined {
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number);
  if (!nums || nums.length < 2) return undefined;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    x0 = Math.min(x0, nums[i]);
    x1 = Math.max(x1, nums[i]);
    y0 = Math.min(y0, nums[i + 1]);
    y1 = Math.max(y1, nums[i + 1]);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Local (untransformed) bounding box of a shape, in the node's own coordinate space. */
function localBox(shape: Json): { x: number; y: number; width: number; height: number; approx?: boolean } | undefined {
  switch (shape?.type) {
    case "rect":
      return { x: shape.x ?? 0, y: shape.y ?? 0, width: shape.width, height: shape.height };
    case "circle":
      return { x: shape.cx - shape.r, y: shape.cy - shape.r, width: shape.r * 2, height: shape.r * 2 };
    case "ellipse":
      return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, width: shape.rx * 2, height: shape.ry * 2 };
    case "line": {
      const x = Math.min(shape.x1, shape.x2);
      const y = Math.min(shape.y1, shape.y2);
      return { x, y, width: Math.abs(shape.x2 - shape.x1), height: Math.abs(shape.y2 - shape.y1) };
    }
    case "path":
    case "compound": {
      const b = typeof shape.path === "string" ? pathBounds(shape.path) : undefined;
      return b && { ...b, approx: true }; // control points included, so slightly generous
    }
  }
  return undefined;
}

/* ---------- node conversion ---------- */

interface Ctx {
  images: Set<string>;
  maxDepth: number;
}

function constraintsOf(ux: Json): Json | undefined {
  if (!ux || ux.constraintsDisabled) return undefined;
  const keys = ["Left", "Right", "Top", "Bottom", "Width", "Height"];
  if (!keys.some((k) => ux["constraint" + k] !== undefined)) return undefined;
  return {
    left: !!ux.constraintLeft,
    right: !!ux.constraintRight,
    top: !!ux.constraintTop,
    bottom: !!ux.constraintBottom,
    fixedWidth: !!ux.constraintWidth,
    fixedHeight: !!ux.constraintHeight,
  };
}

function textOf(n: Json) {
  const t = n.text;
  const font = n.style?.font;
  const runs: Json[] = [];
  for (const p of t.paragraphs ?? [])
    for (const line of p.lines ?? [])
      for (const r of line) if (r.style) runs.push({ from: r.from, to: r.to, style: convertColors(r.style) });
  return {
    characters: t.rawText,
    font: font && {
      family: font.family,
      postscriptName: font.postscriptName,
      style: font.style,
      size: font.size,
    },
    attributes: convertColors(n.style?.textAttributes), // alignment, line height, letter spacing, ...
    frame: t.frame && { type: t.frame.type, width: t.frame.width, height: t.frame.height },
    styledRuns: runs.length ? runs : undefined,
  };
}

function clean<T extends Record<string, any>>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete o[k];
  }
  return o;
}

function convert(n: Json, ctx: Ctx, depth: number, isArtboardRoot: boolean, geometry?: Json): ExportNode {
  const ux = n.meta?.ux ?? {};
  const style = n.style ?? {};
  const m = matrixOf(n);
  const out: ExportNode = { id: n.id, type: n.type, name: n.name };

  if (n.visible === false) out.visible = false;
  if (style.opacity != null && style.opacity !== 1) out.opacity = style.opacity;
  if (style.blendMode && style.blendMode !== "pass-through" && style.blendMode !== "normal") out.blendMode = style.blendMode;

  const fill = paintOf(style.fill, ctx.images);
  const stroke = style.stroke ? strokeOf(style.stroke, ctx.images) : undefined;
  if (fill) out.fills = [fill];
  if (stroke) out.strokes = [stroke];
  out.effects = effectsOf(style);

  const constraints = constraintsOf(ux);
  if (constraints) out.constraints = constraints;
  if (ux.markedForExport) out.markedForExport = true;
  if (ux.symbolId) out.component = { symbolId: ux.symbolId, role: ux.isMaster ? "master" : "instance", kind: ux.componentType };
  if (ux.repeatGrid) out.repeatGrid = ux.repeatGrid;
  if (ux.clipPathResources) out.mask = convertColors(ux.clipPathResources);

  // position / size
  const rot = typeof ux.rotation === "number" ? ux.rotation : Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI * 100) / 100;
  if (rot) out.rotation = rot;
  if (!ident(m)) out.transform = m;

  const kids = childrenOf(n);
  switch (n.type) {
    case "artboard": {
      out.type = "frame";
      if (geometry) Object.assign(out, { x: round(geometry.x), y: round(geometry.y), width: geometry.width, height: geometry.height });
      if (ux.gridStyle) out.layoutGrid = convertColors(ux.gridStyle);
      if (ux.guidesModel) out.guides = ux.guidesModel;
      if (geometry?.viewportHeight) out.viewportHeight = geometry.viewportHeight;
      break;
    }
    case "shape": {
      const s = n.shape ?? {};
      const box = localBox(s);
      const kind = s.type;
      out.type = kind === "rect" ? "rectangle" : kind === "circle" || kind === "ellipse" ? "ellipse" : kind === "compound" ? "boolean" : kind === "line" ? "line" : kind === "path" ? "path" : (kind ?? "shape");
      if (box) {
        // top-left of the local box after applying the node transform
        out.x = round(m.a * box.x + m.c * box.y + m.tx);
        out.y = round(m.b * box.x + m.d * box.y + m.ty);
        out.width = round(box.width);
        out.height = round(box.height);
        if (box.approx) out.boundsApprox = true;
      }
      if (kind === "rect" && s.r != null) out.cornerRadius = s.r;
      if (kind === "line") out.points = [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
      if (typeof s.path === "string") out.svgPath = s.path; // coordinates are local to this node
      if (kind === "compound") {
        out.operation = s.operation; // add | subtract | intersect | exclude
        out.children = (s.children ?? []).map((c: Json) => convert({ ...c }, ctx, depth + 1, false));
      }
      if (s.fillRule) out.fillRule = s.fillRule;
      break;
    }
    case "text": {
      out.type = "text";
      const t = textOf(n);
      out.text = clean(t);
      out.x = round(m.tx);
      out.y = round(m.ty);
      if (t.frame?.width != null) out.width = round(t.frame.width);
      if (t.frame?.height != null) out.height = round(t.frame.height);
      break;
    }
    default: {
      // group (includes components, repeat grids, masks)
      out.x = round(m.tx);
      out.y = round(m.ty);
      if (ux.width != null) out.width = ux.width;
      if (ux.height != null) out.height = ux.height;
    }
  }

  if (n.type !== "shape" || n.shape?.type !== "compound") {
    if (kids.length) {
      if (depth >= ctx.maxDepth) {
        out.childCount = kids.length;
        out.truncated = true;
      } else {
        out.children = kids.map((k: Json) => convert(k, ctx, depth + 1, false));
      }
    }
  }
  return clean(out);
}

/* ---------- public API ---------- */

export interface ExportResult {
  node: ExportNode;
  depthUsed: number;
  images: string[];
}

function findById(n: Json, id: string): Json | undefined {
  if (n.id === id) return n;
  for (const c of childrenOf(n)) {
    const r = findById(c, id);
    if (r) return r;
  }
  return undefined;
}

export async function artboardGeometry(doc: XdDoc): Promise<Json> {
  return doc.entries.includes(RES_PATH) ? (await readJson(doc, RES_PATH))?.artboards ?? {} : {};
}

export async function exportArtboard(
  doc: XdDoc,
  ab: Artboard,
  opts: { nodeId?: string; depth?: number; maxChars?: number },
): Promise<ExportResult> {
  const agc = await readJson(doc, ab.path);
  const geometry = await artboardGeometry(doc);
  const root = rootNodes(agc)[0];
  if (!root) throw new Error("Artboard has no content.");

  const target = opts.nodeId ? findById(root, opts.nodeId) : root;
  if (!target) throw new Error(`No layer with id "${opts.nodeId}" in artboard "${ab.name}".`);
  const geo = target === root ? geometry[root.artboard?.ref] : undefined;

  const limit = opts.maxChars ?? 300_000;
  let depth = Math.min(opts.depth ?? MAX_DEPTH_CAP, MAX_DEPTH_CAP);
  for (;;) {
    const ctx: Ctx = { images: new Set(), maxDepth: depth };
    const node = convert(target, ctx, 0, target === root, geo);
    const size = JSON.stringify(node).length;
    if (size <= limit || depth <= 1) {
      if (size > limit) throw new Error(`Export is ${size} chars even at depth 1; pass a nodeId to export a smaller subtree.`);
      return { node, depthUsed: depth, images: [...ctx.images] };
    }
    depth--;
  }
}

/** Component masters (symbols) defined in the document. */
export async function listComponents(doc: XdDoc) {
  if (!doc.entries.includes(RES_PATH)) return [];
  const res = await readJson(doc, RES_PATH);
  const symbols: Json[] = res?.resources?.meta?.ux?.symbols ?? [];
  return symbols.map((s) => ({
    symbolId: s.meta?.ux?.symbolId,
    name: s.name,
    width: s.meta?.ux?.width,
    height: s.meta?.ux?.height,
    nodeId: s.id,
  }));
}

export async function exportComponent(doc: XdDoc, symbolId: string, opts: { depth?: number; maxChars?: number }) {
  const res = await readJson(doc, RES_PATH);
  const symbols: Json[] = res?.resources?.meta?.ux?.symbols ?? [];
  const s = symbols.find((x) => x.meta?.ux?.symbolId === symbolId || x.id === symbolId || x.name === symbolId);
  if (!s) throw new Error(`Component "${symbolId}" not found. Use xd_list_components.`);
  const limit = opts.maxChars ?? 300_000;
  let depth = Math.min(opts.depth ?? MAX_DEPTH_CAP, MAX_DEPTH_CAP);
  for (;;) {
    const ctx: Ctx = { images: new Set(), maxDepth: depth };
    const node = convert({ ...s, meta: { ux: { ...s.meta?.ux, isMaster: true } } }, ctx, 0, false);
    if (JSON.stringify(node).length <= limit || depth <= 1) return { node, depthUsed: depth, images: [...ctx.images] } as ExportResult;
    depth--;
  }
}

/** Document-wide design tokens from XD's own libraries (color swatches, etc.). */
export async function sharedAssets(doc: XdDoc) {
  if (!doc.entries.includes(RES_PATH)) return {};
  const ux = (await readJson(doc, RES_PATH))?.resources?.meta?.ux ?? {};
  const swatches = (ux.colorSwatches ?? []).map((c: Json) => colorOf(c)?.color).filter(Boolean);
  const lib = ux.documentLibrary?.elements ?? [];
  const colors = lib
    .filter((e: Json) => e.type?.includes("element.color"))
    .map((e: Json) => ({ name: e.name || undefined, ...colorOf(e.representations?.[0]?.content) }));
  const characterStyles = lib
    .filter((e: Json) => e.type?.includes("characterstyle"))
    .map((e: Json) => ({ name: e.name || undefined, content: convertColors(e.representations?.[0]?.content) }));
  return { colorSwatches: swatches, libraryColors: colors, characterStyles };
}
