import { Artboard, XdDoc } from "./xd.js";
import { ExportNode, exportWhole } from "./export.js";

/**
 * Phase 2 of an XD -> design-tool conversion: take the EXACT export of a screen and propose a tree of frames
 * with auto-layout intent (direction, spacing, padding, alignment, sizing). Leaves keep a `ref` to the exact
 * layer so the agent can reuse it. Every proposal is a heuristic, so a drift report says how far the
 * auto-layout version would move things compared with the original.
 */

type Json = any;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Item {
  id: string;
  name: string;
  kind: "text" | "shape" | "illustration" | "image" | "icon" | "divider" | "transformed";
  node: ExportNode;
  box: Box; // artboard-relative
  order: number;
  hasFill: boolean;
  hasShadow: boolean;
  hasStroke: boolean;
  isRect: boolean;
}

interface LNode {
  kind: "leaf" | "frame";
  item?: Item; // leaf, or the card's background rectangle for frames
  box: Box;
  id: string;
  name: string;
  order: number;
  wrapper?: boolean;
  children: LNode[];
  absolute: LNode[];
  layout?: Layout;
  role?: string;
}

interface Layout {
  mode: "HORIZONTAL" | "VERTICAL" | "NONE";
  itemSpacing: number;
  padding: [number, number, number, number]; // top, right, bottom, left
  primaryAxisAlign: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlign: "MIN" | "CENTER" | "MAX";
}

export interface InferOptions {
  nodeId?: string;
  maxDrift?: number; // frames drifting more than this many px fall back to exact positions
  grid?: number;
  tolerance?: number; // px for "same row / same column"
}

const MAX_ITEMS = 4000;
const TOL_CONTAIN = 1.5;
const MAX_DEPTH = 6;

/* ---------- helpers ---------- */

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;
const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h);
const union = (bs: Box[]): Box => {
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map(right)), y1 = Math.max(...bs.map(bottom));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const inter = (a: Box, b: Box) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
const contains = (outer: Box, inner: Box, tol = TOL_CONTAIN) =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && right(inner) <= right(outer) + tol && bottom(inner) <= bottom(outer) + tol;
const rnd = (v: number, g: number) => (g > 1 ? Math.round(v / g) * g : Math.round(v * 10) / 10);
const r1 = (v: number) => Math.round(v * 10) / 10;

/* ---------- flatten the exact export into leaves ---------- */

const VECTOR = new Set(["path", "boolean", "ellipse", "line"]);
const identLin = (m?: Json) => !m || (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1);

function countVectors(n: ExportNode): number {
  let c = VECTOR.has(n.type) ? 1 : 0;
  for (const k of n.children ?? []) if (k.visible !== false) c += countVectors(k);
  return c;
}
function hasImage(n: ExportNode): boolean {
  if ([...(n.fills ?? []), ...(n.strokes ?? [])].some((f: Json) => f.type === "image")) return true;
  return (n.children ?? []).some((k: ExportNode) => k.visible !== false && hasImage(k));
}
function hasText(n: ExportNode): boolean {
  if (n.type === "text") return true;
  return (n.children ?? []).some((k: ExportNode) => k.visible !== false && hasText(k));
}
function hasTransform(n: ExportNode): boolean {
  if (!identLin(n.transform)) return true;
  return false;
}

function leafBox(n: ExportNode, ox: number, oy: number): Box | undefined {
  const w = n.width, h = n.height;
  if (typeof n.x !== "number" || typeof n.y !== "number" || typeof w !== "number" || typeof h !== "number") return undefined;
  const m = n.transform;
  if (identLin(m)) return { x: ox + n.x, y: oy + n.y, w, h };
  // rotated / flipped: bounding box of the transformed local box
  const tlx = ox + n.x, tly = oy + n.y;
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([px, py]) => ({ x: tlx + m.a * px + m.c * py, y: tly + m.b * px + m.d * py }));
  const x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function unionOf(n: ExportNode, ox: number, oy: number): Box | undefined {
  const boxes: Box[] = [];
  const walk = (k: ExportNode, px: number, py: number) => {
    if (k.visible === false || k.type === "unresolvedRef") return;
    if (k.type === "group") {
      for (const c of k.children ?? []) walk(c, px + (k.x ?? 0), py + (k.y ?? 0));
      return;
    }
    const b = leafBox(k, px, py);
    if (b) boxes.push(b);
  };
  walk(n, ox, oy);
  return boxes.length ? union(boxes) : undefined;
}

/** A row/list of separate small things (toolbar, icon strip), as opposed to one drawing made of overlapping parts. */
function isCollection(g: ExportNode, ox: number, oy: number): boolean {
  const kids = (g.children ?? []).filter((k: ExportNode) => k.visible !== false);
  if (kids.length < 3) return false;
  const boxes = kids.map((k: ExportNode) => unionOf(k.type === "group" ? { ...k, x: (k.x ?? 0), y: (k.y ?? 0) } : k, ox + (g.x ?? 0), oy + (g.y ?? 0))).filter(Boolean) as Box[];
  if (boxes.length < 3) return false;
  const total = union(boxes);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (inter(boxes[i], boxes[j]) / Math.max(1, Math.min(area(boxes[i]), area(boxes[j]))) > 0.05) return false;
  return boxes.every((b) => area(b) < 0.35 * area(total));
}

function flatten(root: ExportNode): Item[] {
  const items: Item[] = [];
  let order = 0;
  const push = (n: ExportNode, kind: Item["kind"], box: Box) => {
    const solid = (n.fills ?? []).find((f: Json) => f.type === "solid" && (f.opacity ?? 1) > 0.05);
    items.push({
      id: n.id ?? `n${order}`,
      name: n.name ?? "",
      kind,
      node: n,
      box,
      order: order++,
      hasFill: !!solid || (n.fills ?? []).some((f: Json) => f.type === "gradient"),
      hasStroke: (n.strokes ?? []).length > 0,
      hasShadow: (n.effects ?? []).some((e: Json) => e.type === "dropShadow" && e.visible !== false),
      // XD often stores plain cards as simple paths; short paths of a decent size count as rectangles
      isRect: n.type === "rectangle" || (n.type === "path" && String(n.svgPathLocal ?? "").length <= 520 && box.w >= 60 && box.h >= 30),
    });
  };
  const walk = (n: ExportNode, ox: number, oy: number) => {
    for (const k of n.children ?? []) {
      if (k.visible === false || k.type === "unresolvedRef") continue;
      if (k.type === "group") {
        const originX = ox + (k.x ?? 0), originY = oy + (k.y ?? 0);
        const small = !hasText(k) && !k.mask ? unionOf(k, ox, oy) : undefined;
        if (small && Math.max(small.w, small.h) <= 64 && countVectors(k) >= 1 && !hasImage(k) && !hasTransform(k)) {
          push(k, "icon", small); // a small drawing made of several parts is ONE icon
        } else if (k.mask && !hasText(k)) {
          const mb = k.mask.shapes ? undefined : { x: originX + (k.mask.x ?? 0), y: originY + (k.mask.y ?? 0), w: k.mask.width ?? 0, h: k.mask.height ?? 0 };
          const box = mb && mb.w > 0 && mb.h > 0 ? mb : unionOf(k, ox, oy);
          if (box) push(k, hasImage(k) ? "image" : "illustration", box);
        } else if (hasTransform(k) || ((countVectors(k) > 20 || hasImage(k)) && !hasText(k) && !isCollection(k, ox, oy))) {
          const box = unionOf(k, ox, oy);
          if (box) push(k, hasImage(k) ? "image" : hasTransform(k) ? "transformed" : "illustration", box);
        } else walk(k, originX, originY);
        continue;
      }
      const b = leafBox(k, ox, oy);
      if (!b) continue;
      if (k.type === "text") push(k, "text", b);
      else if (k.fills?.some((f: Json) => f.type === "image")) push(k, "image", b);
      else if (hasTransform(k)) push(k, "transformed", b);
      else if (k.type === "line" || (k.type === "rectangle" && Math.min(b.w, b.h) <= 2 && Math.max(b.w, b.h) >= 12)) push(k, "divider", b);
      else if (b.w <= 40 && b.h <= 40 && VECTOR.has(k.type)) push(k, "icon", b);
      else push(k, "shape", b);
    }
  };
  walk(root, 0, 0);
  return items;
}

/* ---------- cards (containment clustering) ---------- */

/**
 * An item belongs to a card when its centre is inside and most of it overlaps. (Strict containment fails for text,
 * whose frames in XD are often wider than what is visible, and for art that bleeds past the card edge.)
 */
const belongs = (card: Box, item: Box) => {
  const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
  if (cx < card.x || cx > right(card) || cy < card.y || cy > bottom(card)) return false;
  return inter(card, item) / Math.max(1, area(item)) >= 0.6;
};

function buildTree(items: Item[], page: Box): LNode {
  const root: LNode = { kind: "frame", id: "root", name: "Screen", box: page, order: -1, children: [], absolute: [], role: "screen" };

  // Candidate cards: filled/stroked/shadowed rectangles that fully contain something drawn above them.
  const cards = new Map<string, LNode>();
  const isPageBackground = (it: Item) => it.box.w >= page.w * 0.98 && it.box.h >= page.h * 0.98;
  const used: Item[] = [];
  for (const it of items) {
    if (!it.isRect || !(it.hasFill || it.hasStroke || it.hasShadow) || it.box.w < 24 || it.box.h < 16) continue;
    if (isPageBackground(it)) {
      root.item = it;
      continue;
    }
    if (used.some((u) => Math.abs(u.box.x - it.box.x) < 1 && Math.abs(u.box.y - it.box.y) < 1 && Math.abs(u.box.w - it.box.w) < 1 && Math.abs(u.box.h - it.box.h) < 1)) continue;
    const holds = items.some((o) => o !== it && o.order > it.order && belongs(it.box, o.box));
    if (!holds) continue;
    used.push(it);
    cards.set(it.id, { kind: "frame", item: it, id: it.id, name: it.name, box: it.box, order: it.order, children: [], absolute: [] });
  }

  const owner = (box: Box, order: number, selfId: string): LNode => {
    let best: LNode | undefined;
    for (const c of cards.values()) {
      if (c.id === selfId || c.order >= order || !belongs(c.box, box)) continue;
      if (!best || area(c.box) < area(best.box)) best = c;
    }
    return best ?? root;
  };

  for (const c of cards.values()) owner(c.box, c.order, c.id).children.push(c);
  for (const it of items) {
    if (cards.has(it.id) || it === root.item) continue;
    owner(it.box, it.order, it.id).children.push({ kind: "leaf", item: it, id: it.id, name: it.name, box: it.box, order: it.order, children: [], absolute: [] });
  }
  return root;
}

/* ---------- arranging children of one frame ---------- */

function clusterRows(nodes: LNode[], tol: number): LNode[][] {
  const sorted = [...nodes].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
  const rows: { items: LNode[]; cy: number; top: number; bot: number }[] = [];
  for (const n of sorted) {
    const cy = n.box.y + n.box.h / 2;
    const row = rows.find((r) => {
      const overlap = Math.min(r.bot, bottom(n.box)) - Math.max(r.top, n.box.y);
      const minH = Math.min(r.bot - r.top, n.box.h) || 1;
      return Math.abs(cy - r.cy) <= tol || overlap / minH >= 0.5;
    });
    if (row) {
      row.items.push(n);
      row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length;
      row.top = Math.min(row.top, n.box.y);
      row.bot = Math.max(row.bot, bottom(n.box));
    } else rows.push({ items: [n], cy, top: n.box.y, bot: bottom(n.box) });
  }
  return rows.sort((a, b) => a.cy - b.cy).map((r) => r.items.sort((a, b) => a.box.x - b.box.x));
}

function clusterColumns(nodes: LNode[]): LNode[][] {
  const sorted = [...nodes].sort((a, b) => a.box.x - b.box.x);
  const cols: { items: LNode[]; x0: number; x1: number }[] = [];
  for (const n of sorted) {
    const last = cols[cols.length - 1];
    if (last && n.box.x < last.x1 - 1) {
      last.items.push(n);
      last.x1 = Math.max(last.x1, right(n.box));
    } else cols.push({ items: [n], x0: n.box.x, x1: right(n.box) });
  }
  return cols.map((c) => c.items.sort((a, b) => a.box.y - b.box.y));
}

let wrapSeq = 0;
function wrapper(children: LNode[], role: string): LNode {
  const box = union(children.map((c) => c.box));
  return { kind: "frame", id: `wrap-${++wrapSeq}`, name: role, box, order: Math.min(...children.map((c) => c.order)), children, absolute: [], wrapper: true, role };
}

function findAbsolute(children: LNode[]): { flow: LNode[]; absolute: LNode[] } {
  const abs = new Set<LNode>();
  const isCard = (n: LNode) => n.kind === "frame" && !n.wrapper && n.children.length > 0;
  for (const a of children) {
    for (const b of children) {
      if (a === b || b.order <= a.order) continue; // a is below b
      const ov = inter(a.box, b.box);
      const small = Math.min(area(a.box), area(b.box));
      if (ov <= 0 || ov / Math.max(1, small) <= 0.12) continue;
      if (isCard(a) || isCard(b)) continue; // cards are content; their overlaps are handled inside them
      const aText = a.item?.kind === "text", bText = b.item?.kind === "text";
      if (aText && bText) abs.add(a);
      else if (aText && !bText) continue; // text beneath a shape: leave both in the flow
      else if (!aText && bText) {
        // art behind text is background decoration; text on a small icon is a badge on that icon
        const smallIcon = Math.max(a.box.w, a.box.h) <= 64;
        if (!smallIcon && area(a.box) > 6 * area(b.box)) abs.add(a);
        else abs.add(b);
      } else if (area(b.box) < area(a.box) && ov / Math.max(1, area(b.box)) > 0.8) abs.add(b); // small overlay on a bigger shape
      else abs.add(a);
    }
  }
  const flow = children.filter((c) => !abs.has(c));
  if (!flow.length && children.length) {
    const keep = [...children].sort((x, y) => area(y.box) - area(x.box))[0];
    abs.delete(keep);
    return { flow: [keep], absolute: children.filter((c) => c !== keep) };
  }
  return { flow, absolute: children.filter((c) => abs.has(c)) };
}

function arrange(frame: LNode, tol: number, grid: number, depth: number): void {
  const { flow, absolute } = findAbsolute(frame.children);
  frame.absolute.push(...absolute);
  frame.children = flow;
  for (const c of flow) if (c.kind === "frame" && !c.wrapper) arrange(c, tol, grid, 0);
  structure(frame, tol, grid, depth);
}

/** True when no two items are stacked above each other (x ranges don't overlap, allowing for estimated text widths). */
function disjointX(nodes: LNode[]): boolean {
  const byX = [...nodes].sort((a, b) => a.box.x - b.box.x);
  return byX.every((n, i) => {
    if (i === 0) return true;
    const prev = byX[i - 1].box;
    return right(prev) - n.box.x <= Math.max(4, 0.2 * Math.min(prev.w, n.box.w));
  });
}

function directionOf(nodes: LNode[], tol: number): "H" | "V" | "mixed" {
  if (nodes.length < 2) return "V";
  const rows = clusterRows(nodes, tol);
  if (rows.length === 1) {
    return "H"; // stacked columns inside the row are detected in structure()
  }
  if (rows.every((r) => r.length === 1)) return "V";
  return "mixed";
}

/** Decide direction, wrap sub-rows / sub-columns, and compute spacing, padding and alignment. */
function structure(frame: LNode, tol: number, grid: number, depth: number, force?: "H" | "V"): void {
  const kids = frame.children;
  if (kids.length === 0) return;
  let dir = force ?? directionOf(kids, tol);
  if (dir === "H" && kids.length > 1 && !disjointX(kids)) {
    // overlapping x ranges are only a problem if things are really stacked into columns
    const cols = clusterColumns(kids);
    const stacked = cols.length >= 2 && cols.some((c) => c.length > 1 && clusterRows(c, tol).length > 1);
    if (stacked) dir = "mixed";
  }

  if (dir === "mixed" && depth < MAX_DEPTH) {
    // Rows first (a page is a stack of bands). If everything overlaps vertically it is a single band, so try columns.
    const rows = clusterRows(kids, tol);
    if (rows.length > 1) {
      frame.children = rows.map((r) => (r.length === 1 ? r[0] : wrapper(r, "Row")));
      frame.children.filter((c) => c.wrapper).forEach((w) => structure(w, tol, grid, depth + 1, "H"));
      dir = "V";
    } else {
      const cols = clusterColumns(kids);
      if (cols.length >= 2 && cols.length <= 6) {
        frame.children = cols.map((c) => (c.length === 1 ? c[0] : wrapper(c, "Column")));
        frame.children.filter((c) => c.wrapper).forEach((w) => structure(w, tol, grid, depth + 1, "V"));
        dir = "H";
      } else dir = "V"; // overlaps in both axes: stack by position
    }
  }
  const mode = dir === "H" ? "HORIZONTAL" : "VERTICAL";
  const ordered = [...frame.children].sort((a, b) => (mode === "HORIZONTAL" ? a.box.x - b.box.x : a.box.y - b.box.y));

  // header-style rows: one big gap splits them into a left and a right group
  let primary: Layout["primaryAxisAlign"] = "MIN";
  let working = ordered;
  if (mode === "HORIZONTAL" && ordered.length >= 3) {
    const gaps = ordered.slice(1).map((c, i) => c.box.x - right(ordered[i].box));
    const maxGap = Math.max(...gaps);
    const rest = gaps.filter((g) => g !== maxGap);
    if (maxGap > 40 && maxGap > 2.5 * Math.max(median(rest), 4)) {
      const at = gaps.indexOf(maxGap) + 1;
      const left = ordered.slice(0, at), rightSide = ordered.slice(at);
      const group = (g: LNode[], name: string) => (g.length === 1 ? g[0] : wrapper(g, name));
      const lw = group(left, "Left"), rw = group(rightSide, "Right");
      for (const w of [lw, rw]) if (w.wrapper) structure(w, tol, grid, depth + 1, "H");
      working = [lw, rw];
      primary = "SPACE_BETWEEN";
    }
  }
  frame.children = working;

  // spacing: median gap between neighbours along the main axis
  const gaps = working.slice(1).map((c, i) => (mode === "HORIZONTAL" ? c.box.x - right(working[i].box) : c.box.y - bottom(working[i].box)));
  const spacing = primary === "SPACE_BETWEEN" ? 0 : Math.max(0, rnd(median(gaps), grid));

  // padding: distance from the frame edges to the content
  const content = union(working.map((c) => c.box));
  const b = frame.box;
  const pad: Layout["padding"] = frame.wrapper
    ? [0, 0, 0, 0]
    : [Math.max(0, rnd(content.y - b.y, grid)), Math.max(0, rnd(right(b) - right(content), grid)), Math.max(0, rnd(bottom(b) - bottom(content), grid)), Math.max(0, rnd(content.x - b.x, grid))];

  // cross-axis alignment
  const cross = (c: LNode) => (mode === "HORIZONTAL" ? { lo: c.box.y, hi: bottom(c.box) } : { lo: c.box.x, hi: right(c.box) });
  const los = working.map((c) => cross(c).lo), his = working.map((c) => cross(c).hi), mids = working.map((c) => (cross(c).lo + cross(c).hi) / 2);
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  const counter: Layout["counterAxisAlign"] = spread(los) <= tol ? "MIN" : spread(mids) <= tol ? "CENTER" : spread(his) <= tol ? "MAX" : "MIN";

  frame.layout = { mode, itemSpacing: spacing, padding: pad, primaryAxisAlign: primary, counterAxisAlign: counter };

  // a card whose only content is one centred text is a button
  if (!frame.wrapper && working.length === 1 && working[0].item?.kind === "text" && !frame.absolute.length) {
    const t = working[0].box;
    if (Math.abs(t.x + t.w / 2 - (b.x + b.w / 2)) <= 3 && Math.abs(t.y + t.h / 2 - (b.y + b.h / 2)) <= 4) {
      frame.role = "button";
      frame.layout = { mode: "HORIZONTAL", itemSpacing: 0, padding: [Math.max(0, rnd(t.y - b.y, grid)), Math.max(0, rnd(right(b) - right(t), grid)), Math.max(0, rnd(bottom(b) - bottom(t), grid)), Math.max(0, rnd(t.x - b.x, grid))], primaryAxisAlign: "CENTER", counterAxisAlign: "CENTER" };
    }
  }
}

/* ---------- drift simulation ---------- */

interface Stats {
  textErrors: number[];
  frameErrors: { node: LNode; max: number; mean: number }[];
  errors: number[];
  leaves: number;
  inLayout: number;
  absolute: number;
  frames: number;
}

/** Per-child position error (px) if this frame's layout replaced the original positions. */
function localErrors(frame: LNode): number[] {
  const lay = frame.layout;
  const kids = frame.children;
  const b = frame.box;
  if (!lay || lay.mode === "NONE" || !kids.length) return [];
  const H = lay.mode === "HORIZONTAL";
  const [pt, pr, pb, pl] = lay.padding;
  const innerX = b.x + pl, innerY = b.y + pt, innerW = b.w - pl - pr, innerH = b.h - pt - pb;
  const sizes = kids.map((k) => (H ? k.box.w : k.box.h));
  let cursor = H ? innerX : innerY;
  let space = lay.itemSpacing;
  if (lay.primaryAxisAlign === "SPACE_BETWEEN" && kids.length > 1) {
    const total = sizes.reduce((acc, v) => acc + v, 0);
    space = ((H ? innerW : innerH) - total) / (kids.length - 1);
  }
  return kids.map((k, i) => {
    const crossSize = H ? k.box.h : k.box.w;
    const innerCross = H ? innerH : innerW;
    const crossStart = H ? innerY : innerX;
    const predCross = lay.counterAxisAlign === "CENTER" ? crossStart + (innerCross - crossSize) / 2 : lay.counterAxisAlign === "MAX" ? crossStart + innerCross - crossSize : crossStart;
    const px = H ? cursor : predCross, py = H ? predCross : cursor;
    const err = Math.max(Math.abs(px - k.box.x), Math.abs(py - k.box.y));
    cursor += sizes[i] + space;
    return err;
  });
}

/**
 * Where auto-layout cannot reproduce the original (irregular spacing, free-form art), keep exact positions:
 * the frame becomes a plain container (layout NONE) and its children are placed absolutely.
 */
function relax(frame: LNode, threshold: number, tol: number, grid: number): void {
  for (const k of frame.children) if (k.kind === "frame") relax(k, threshold, tol, grid);
  // Repeatedly take the child that auto-layout would move the most out of the flow (it keeps its exact
  // position as an absolute child) and refit spacing/padding to the rest.
  for (let guard = 0; guard < 64 && frame.children.length; guard++) {
    const errs = localErrors(frame);
    if (!errs.length) break;
    const max = Math.max(...errs);
    if (max <= threshold) break;
    const worst = errs.indexOf(max);
    frame.absolute.push(frame.children.splice(worst, 1)[0]);
    if (!frame.children.length) break;
    structure(frame, tol, grid, MAX_DEPTH, frame.layout?.mode === "HORIZONTAL" ? "H" : "V");
  }
  if (!frame.children.length && frame.layout && frame.layout.mode !== "NONE")
    frame.layout = { mode: "NONE", itemSpacing: 0, padding: [0, 0, 0, 0], primaryAxisAlign: "MIN", counterAxisAlign: "MIN" };
}

const countLeaves = (n: LNode, text = false): number =>
  n.kind === "leaf" ? (!text || n.item?.kind === "text" ? 1 : 0) : [...n.children, ...n.absolute].reduce((acc, c) => acc + countLeaves(c, text), 0);

function drift(frame: LNode, stats: Stats): void {
  stats.frames++;
  const errs = localErrors(frame);
  frame.children.forEach((k, i) => {
    if (k.kind !== "leaf") return;
    stats.leaves++;
    stats.inLayout++;
    stats.errors.push(errs[i]);
    if (k.item?.kind === "text") stats.textErrors.push(errs[i]);
  });
  if (errs.length) stats.frameErrors.push({ node: frame, max: Math.max(...errs), mean: errs.reduce((acc, e) => acc + e, 0) / errs.length });
  for (const a of frame.absolute) {
    const c = countLeaves(a);
    stats.leaves += c;
    stats.absolute += c;
    stats.errors.push(...Array(c).fill(0));
    stats.textErrors.push(...Array(countLeaves(a, true)).fill(0));
  }
  for (const k of frame.children) if (k.kind === "frame") drift(k, stats);
}

/* ---------- naming ---------- */

/** Strip export-style suffixes: "Group_34330_224" -> "Group", "Rectangle 1221" -> "Rectangle". */
export function cleanName(raw: string | undefined): string {
  let s = String(raw ?? "").replace(/_/g, " ");
  s = s.replace(/(?:\s+[–-]\s*\d+|\s+\d+)+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s || "Layer";
}

const words = (t: string, n = 3) => t.replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ").slice(0, 28);

function textOf(n: LNode): string | undefined {
  if (n.item?.kind === "text") return String(n.item.node.text?.characters ?? "");
  return undefined;
}

function semanticName(n: LNode, siblingsText: string[]): string {
  const it = n.item;
  if (n.kind === "leaf" && it) {
    switch (it.kind) {
      case "text": {
        const size = it.node.text?.font?.size ?? 14;
        const bold = /bold|heavy|black/i.test(it.node.text?.font?.style ?? "");
        const label = words(textOf(n) ?? "");
        return `${size >= 20 ? "Title" : bold && size >= 14 ? "Heading" : "Text"} / ${label || "empty"}`;
      }
      case "illustration": return "Illustration";
      case "image": return "Image";
      case "icon": return "Icon";
      case "divider": return "Divider";
      case "transformed": return `${cleanName(it.name)} (rotated)`;
      default: return cleanName(it.name) === "Layer" ? "Shape" : cleanName(it.name);
    }
  }
  if (n.role === "button") return `Button / ${words(siblingsText[0] ?? "")}`.replace(/ \/ $/, "");
  if (n.role === "screen") return "Screen";
  if (n.wrapper) return n.role ?? "Group";
  const title = siblingsText.find((t) => t.trim().length > 2);
  return title ? `Card / ${words(title, 4)}` : "Card";
}

/* ---------- output ---------- */

export interface LayoutOut {
  type: string;
  kind?: string;
  name: string;
  suggestedName: string;
  originalName?: string;
  ref?: string;
  box: { x: number; y: number; width: number; height: number };
  layout?: Json;
  sizing?: { horizontal: string; vertical: string };
  style?: Json;
  text?: Json;
  children?: LayoutOut[];
  absoluteChildren?: Json[];
}

function allTexts(n: LNode): string[] {
  const out: string[] = [];
  const walk = (k: LNode) => {
    const t = textOf(k);
    if (t) out.push(t);
    k.children.forEach(walk);
  };
  n.children.forEach(walk);
  return out;
}

function emit(n: LNode, parent: LNode | undefined, grid: number): LayoutOut {
  const rel = parent ? { x: r1(n.box.x - parent.box.x), y: r1(n.box.y - parent.box.y) } : { x: 0, y: 0 };
  const box = { ...rel, width: r1(n.box.w), height: r1(n.box.h) };
  const texts = n.kind === "frame" ? allTexts(n) : [];
  const suggestedName = semanticName(n, texts);

  if (n.kind === "leaf" && n.item) {
    const it = n.item;
    const node = it.node;
    const inV = parent?.layout?.mode === "VERTICAL";
    const out: LayoutOut = {
      type: it.kind === "text" ? "text" : it.kind,
      name: it.name || it.kind,
      suggestedName,
      originalName: it.name || undefined,
      ref: n.id,
      box,
    };
    if (it.kind === "text") {
      const t = node.text ?? {};
      const multiline = String(t.characters ?? "").includes("\n") || t.autoResize === "HEIGHT" || t.autoResize === "NONE";
      out.text = { characters: String(t.characters ?? "").slice(0, 120), fontSize: t.font?.size, alignment: t.alignment, autoResize: multiline ? "HEIGHT" : "WIDTH_AND_HEIGHT" };
      out.sizing = { horizontal: multiline && inV ? "FILL" : "HUG", vertical: "HUG" };
    } else if (it.kind === "divider") {
      out.sizing = { horizontal: inV && parent && Math.abs(n.box.w - (parent.box.w - (parent.layout?.padding[1] ?? 0) - (parent.layout?.padding[3] ?? 0))) <= 2 ? "FILL" : "FIXED", vertical: "FIXED" };
    } else {
      out.sizing = { horizontal: "FIXED", vertical: "FIXED" };
      out.kind = it.kind === "illustration" || it.kind === "image" || it.kind === "transformed" ? "fixed-leaf" : undefined;
    }
    return out;
  }

  const lay = n.layout!;
  const out: LayoutOut = {
    type: "frame",
    kind: n.role,
    name: n.wrapper ? n.role ?? "Group" : n.item?.name || "Card",
    suggestedName,
    originalName: n.item?.name || undefined,
    ref: n.wrapper ? undefined : n.id,
    box,
    layout: { mode: lay.mode, itemSpacing: lay.itemSpacing, padding: lay.padding, primaryAxisAlign: lay.primaryAxisAlign, counterAxisAlign: lay.counterAxisAlign },
  };
  if (n.item && !n.wrapper) {
    const nd = n.item.node;
    out.style = { fills: nd.fills, strokes: nd.strokes, effects: nd.effects, cornerRadius: nd.cornerRadius };
  }
  // sizing of this frame inside its parent
  if (parent?.layout) {
    const pl = parent.layout;
    const innerW = parent.box.w - pl.padding[1] - pl.padding[3];
    const siblings = parent.children.filter((c) => c.kind === "frame");
    const equalRow = pl.mode === "HORIZONTAL" && siblings.length >= 2 && siblings.every((s) => Math.abs(s.box.w - n.box.w) <= 2);
    const fullWidth = pl.mode === "VERTICAL" && Math.abs(n.box.w - innerW) <= 2;
    out.sizing = { horizontal: equalRow || fullWidth ? "FILL" : "FIXED", vertical: n.absolute.length ? "FIXED" : "HUG" };
  }
  out.children = n.children.map((c) => emit(c, n, grid));
  if (n.absolute.length) {
    out.absoluteChildren = n.absolute.map((a) => {
      const e = emit(a, n, grid);
      return { ref: e.ref, type: e.type, name: e.name, suggestedName: e.suggestedName, x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height, children: e.children, layout: e.layout };
    });
  }
  return out;
}

export async function inferLayout(doc: XdDoc, ab: Artboard, opts: InferOptions = {}) {
  const grid = opts.grid ?? 4;
  const tol = opts.tolerance ?? 8;
  wrapSeq = 0;
  const whole = await exportWhole(doc, ab, { nodeId: opts.nodeId });
  const rootNode = whole.node;
  // the exported root's children are artboard-relative already; a sub-layer export is shifted to its own origin
  const page: Box = { x: 0, y: 0, w: rootNode.width ?? 0, h: rootNode.height ?? 0 };
  let items = flatten(rootNode);
  if (items.length > MAX_ITEMS) throw new Error(`This screen has ${items.length} layers after grouping; layout inference handles up to ${MAX_ITEMS}. Analyse a smaller part with nodeId.`);
  if (!page.w || !page.h) {
    const u = items.length ? union(items.map((i) => i.box)) : { x: 0, y: 0, w: 1, h: 1 };
    page.x = u.x; page.y = u.y; page.w = u.w; page.h = u.h;
  }
  const tree = buildTree(items, page);
  arrange(tree, tol, grid, 0);
  const driftLimit = opts.maxDrift ?? 5;
  const before = { errors: [] as number[] };
  if (driftLimit > 0) relax(tree, driftLimit, tol, grid);
  void before;

  const stats: Stats = { textErrors: [], frameErrors: [], errors: [], leaves: 0, inLayout: 0, absolute: 0, frames: 0 };
  drift(tree, stats);
  const errs = stats.errors;
  const mean = errs.length ? errs.reduce((a, e) => a + e, 0) / errs.length : 0;
  const within = (px: number) => errs.filter((e) => e <= px).length;
  const emitted = emit(tree, undefined, grid);
  if (tree.item) emitted.style = { fills: tree.item.node.fills };
  else if (rootNode.fills) emitted.style = { fills: rootNode.fills };
  emitted.name = ab.name;
  emitted.suggestedName = "Screen";

  return {
    artboard: { id: ab.id, name: ab.name },
    grid,
    tree: emitted,
    quality: {
      pixelDeltaEstimate: r1(mean), // mean position error (px) if the auto-layout version replaced the exact copy
      maxDrift: r1(errs.length ? Math.max(...errs) : 0),
      within3px: within(3),
      within5px: within(5),
      textLayers: stats.textErrors.length,
      textWithin3px: stats.textErrors.filter((e) => e <= 3).length,
      textWithin5px: stats.textErrors.filter((e) => e <= 5).length,
      elementsAutoLayout: stats.inLayout,
      elementsAbsolute: stats.absolute,
      frames: stats.frames,
      leaves: stats.leaves,
      worstFrames: stats.frameErrors
        .sort((a, b) => b.max - a.max)
        .slice(0, 5)
        .map((f) => ({ ref: f.node.wrapper ? undefined : f.node.id, name: f.node.name, mode: f.node.layout?.mode, children: f.node.children.length, maxError: r1(f.max), meanError: r1(f.mean), box: { x: r1(f.node.box.x), y: r1(f.node.box.y), width: r1(f.node.box.w), height: r1(f.node.box.h) } })),
    },
    notes: [
      "Heuristic proposal. Rebuild beside the exact copy and compare (xd_render_artboard) before replacing it.",
      "Leaves carry `ref` = layer id in the exact export (xd_export_artboard); reuse those layers for illustrations and images.",
      "Padding and spacing are rounded to the grid; the drift numbers show the cost of that rounding and of irregular spacing in the original.",
    ],
  };
}

/** Add `suggestedName` to every node of an export tree (used by xd_export_artboard with semanticNames). */
export function addSuggestedNames(node: ExportNode): void {
  const walk = (n: ExportNode) => {
    if (n.type === "text") {
      const size = n.text?.font?.size ?? 14;
      const bold = /bold|heavy|black/i.test(n.text?.font?.style ?? "");
      n.suggestedName = `${size >= 20 ? "Title" : bold && size >= 14 ? "Heading" : "Text"} / ${words(String(n.text?.characters ?? "")) || "empty"}`;
    } else if (n.component) n.suggestedName = cleanName(n.name);
    else n.suggestedName = cleanName(n.name);
    for (const c of n.children ?? []) walk(c);
    for (const v of n.variants ?? []) walk(v.node);
  };
  walk(node);
}
