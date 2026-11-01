import { XdDoc, arr, childrenOf, readJson } from "./xd.js";

/**
 * XD "linked components" appear in artboards as `{type:"syncRef", syncSourceGuid, guid}`.
 * The source layer lives elsewhere (another artboard or the shared resources file) and is keyed by `id`.
 * We keep a compact id -> location index so the (large) parsed files can be evicted from memory.
 */

type Json = any;

interface Loc {
  entry: string;
  root: number; // index into rootsOf(agc)
  path: number[]; // child indexes below that root
}

const indexes = new WeakMap<XdDoc, Promise<Map<string, Loc>>>();

/** Children plus XD component states (hover etc.): source layers can live inside either. */
const subNodes = (n: Json): Json[] => [...childrenOf(n), ...arr(n?.meta?.ux?.states)];

const rootsOf = (agc: Json): Json[] => [...arr(agc?.children), ...arr(agc?.resources?.meta?.ux?.symbols)];

async function build(doc: XdDoc): Promise<Map<string, Loc>> {
  const idx = new Map<string, Loc>();
  const MAX_INDEXED = 2_000_000;
  const entries = doc.entries.filter((e) => e.endsWith(".agc"));
  for (const entry of entries) {
    const agc = await readJson(doc, entry);
    const roots = rootsOf(agc);
    const walk = (n: Json, root: number, path: number[]) => {
      if (n?.id && !idx.has(n.id)) {
        if (idx.size >= MAX_INDEXED) throw new Error("Too many layers to index linked components.");
        idx.set(n.id, { entry, root, path });
      }
      const kids = subNodes(n);
      for (let i = 0; i < kids.length; i++) walk(kids[i], root, [...path, i]);
    };
    roots.forEach((r, i) => walk(r, i, []));
  }
  return idx;
}

export function idIndex(doc: XdDoc): Promise<Map<string, Loc>> {
  let p = indexes.get(doc);
  if (!p) indexes.set(doc, (p = build(doc)));
  return p;
}

export async function fetchLayer(doc: XdDoc, id: string): Promise<Json | undefined> {
  const loc = (await idIndex(doc)).get(id);
  if (!loc) return undefined;
  const agc = await readJson(doc, loc.entry);
  let n = rootsOf(agc)[loc.root];
  for (const i of loc.path) n = subNodes(n)[i];
  return n;
}

const MAX_SYNC_DEPTH = 8;

/** Collect every referenced source layer (recursively) for the subtree `root`. */
export async function prefetchSources(doc: XdDoc, root: Json): Promise<Map<string, Json>> {
  const found = new Map<string, Json>();
  let frontier: Json[] = [root];
  for (let level = 0; level <= MAX_SYNC_DEPTH && frontier.length; level++) {
    const wanted = new Set<string>();
    const walk = (n: Json) => {
      if (n?.type === "syncRef" && typeof n.syncSourceGuid === "string" && !found.has(n.syncSourceGuid)) wanted.add(n.syncSourceGuid);
      for (const k of childrenOf(n)) walk(k);
      for (const s of arr(n?.meta?.ux?.states)) walk(s);
      for (const m of arr(n?.meta?.ux?.clipPathResources?.children)) walk(m);
    };
    frontier.forEach(walk);
    frontier = [];
    for (const id of wanted) {
      const src = await fetchLayer(doc, id);
      if (src) {
        found.set(id, src);
        frontier.push(src);
      }
    }
  }
  return found;
}

export const MAX_SYNC = MAX_SYNC_DEPTH;
