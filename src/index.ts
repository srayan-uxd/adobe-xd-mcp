#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  openXd,
  assertInsideRoots,
  resolveArtboard,
  artboardTree,
  extractTexts,
  designTokens,
  interactions,
  readJson,
  jsonPath,
  readEntry,
  own,
  type XdDoc,
} from "./xd.js";
import { designSystem, audit, findLayers, copyDeck, flowMap, projectOverview } from "./insights.js";
import { exportArtboard, exportComponent, listComponents, sharedAssets, artboardGeometry } from "./export.js";

const server = new McpServer({ name: "adobe-xd-mcp", version: "0.2.1" });

const file = z.string().describe("Absolute path to a .xd file");
const MAX_OUT = 400_000;
const text = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return {
    content: [
      { type: "text" as const, text: s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `
… output truncated (${s.length} chars)` : s },
    ],
  };
};
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});
const guard =
  <A>(fn: (a: A) => Promise<any>) =>
  async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return fail(e);
    }
  };

server.registerTool(
  "xd_list_artboards",
  {
    description:
      "List the artboards in an Adobe XD file with their ids and names, plus document name. Set includeGeometry to also get each artboard's canvas position and size (slower on big files).",
    inputSchema: { file, includeGeometry: z.boolean().default(false) },
  },
  guard(async ({ file, includeGeometry }) => {
    const doc = await openXd(file);
    const geo = includeGeometry ? await artboardGeometry(doc) : {};
    const artboards = [];
    for (const { id, name, path: p } of doc.artboards) {
      const g = includeGeometry ? own(geo, (await readJson(doc, p))?.children?.[0]?.artboard?.ref) : undefined;
      artboards.push({ id, name, ...(g && { x: g.x, y: g.y, width: g.width, height: g.height }) });
    }
    return text({ name: doc.manifest?.name, artboardCount: artboards.length, artboards });
  }),
);

server.registerTool(
  "xd_get_artboard",
  {
    description:
      "Get the layer tree of one artboard (positions, sizes, fills, strokes, text, fonts). Match by id or name (partial ok).",
    inputSchema: {
      file,
      artboard: z.string().describe("Artboard id or name"),
      depth: z.number().int().min(0).max(20).default(6).describe("Max nesting depth to expand"),
    },
  },
  guard(async ({ file, artboard, depth }) => {
    const doc = await openXd(file);
    const ab = resolveArtboard(doc, artboard);
    return text({ artboard: { id: ab.id, name: ab.name }, layers: await artboardTree(doc, ab, depth ?? 6) });
  }),
);

server.registerTool(
  "xd_extract_text",
  {
    description: "Extract all text content from one artboard, or from every artboard if none is given.",
    inputSchema: { file, artboard: z.string().optional().describe("Artboard id or name; omit for all") },
  },
  guard(async ({ file, artboard }) => {
    const doc = await openXd(file);
    const abs = artboard ? [resolveArtboard(doc, artboard)] : doc.artboards;
    const result: Record<string, unknown> = {};
    for (const ab of abs) result[ab.name] = await extractTexts(doc, ab);
    return text(result);
  }),
);

server.registerTool(
  "xd_get_design_tokens",
  {
    description: "Summarize colors and fonts used across the document (by frequency), plus shared styles if present.",
    inputSchema: { file },
  },
  guard(async ({ file }) => text(await designTokens(await openXd(file)))),
);

server.registerTool(
  "xd_get_interactions",
  {
    description: "Return prototype interactions / flows (interactions.json) if the file has any.",
    inputSchema: { file },
  },
  guard(async ({ file }) => text((await interactions(await openXd(file))) ?? "No interactions found.")),
);

server.registerTool(
  "xd_list_entries",
  {
    description: "List every file inside the XD archive (for debugging / finding raw data).",
    inputSchema: { file },
  },
  guard(async ({ file }) => text((await openXd(file)).entries)),
);

server.registerTool(
  "xd_read_raw",
  {
    description:
      "Read a raw JSON entry from the archive (e.g. manifest, an artboard's graphicContent.agc), optionally drilling in with a dotted path like children.0.artboard.children.2. Output is truncated to maxChars.",
    inputSchema: {
      file,
      entry: z.string().describe("Archive path, e.g. 'manifest' or 'artwork/artboard-xxx/graphics/graphicContent.agc'"),
      path: z.string().default("").describe("Optional dotted path into the JSON"),
      maxChars: z.number().int().min(100).max(200000).default(20000),
    },
  },
  guard(async ({ file, entry, path: p, maxChars }) => {
    const doc = await openXd(file);
    const v = jsonPath(await readJson(doc, entry), p ?? "");
    const s = JSON.stringify(v, null, 2) ?? "undefined";
    const max = maxChars ?? 20000;
    return text(s.length > max ? s.slice(0, max) + `\n… truncated (${s.length} chars total)` : s);
  }),
);

server.registerTool(
  "xd_get_preview",
  {
    description: "Return the embedded preview image of the XD file (first artboard render).",
    inputSchema: { file },
  },
  guard(async ({ file }) => {
    const doc = await openXd(file);
    const name = ["preview.png", "thumbnail.png"].find((n) => doc.zip.file(n));
    if (!name) return fail("No preview image in this file.");
    const data = (await readEntry(doc, name, 20 * 1024 * 1024)).toString("base64");
    return { content: [{ type: "image" as const, data, mimeType: "image/png" }] };
  }),
);

server.registerTool(
  "xd_extract_assets",
  {
    description: "Extract embedded images/resources from the XD file into an output directory.",
    inputSchema: { file, outDir: z.string().describe("Absolute directory to write assets into") },
  },
  guard(async ({ file, outDir }) => {
    const doc = await openXd(file);
    const safeOut = await assertInsideRoots(outDir);
    await mkdir(safeOut, { recursive: true });
    const written: string[] = [];
    for (const e of doc.entries) {
      if (!e.startsWith("resources/") || e.endsWith(".agc") || e.endsWith(".json")) continue;
      const buf = await readEntry(doc, e);
      const ext = sniffExt(buf);
      // Fixed prefix + sanitized name: no traversal, no Windows device names (CON, NUL, ...), no ADS (a:b).
      const base = path.basename(e).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      const dest = path.join(safeOut, `asset-${written.length}-${base}${ext}`);
      await writeFile(dest, buf, { flag: "wx" }); // never overwrite, never follow a planted symlink
      written.push(dest);
    }
    return text({ count: written.length, files: written });
  }),
);

/** Write the embedded images with these uids as <uid>.<ext>; never overwrites or follows symlinks. */
async function saveImages(doc: XdDoc, uids: string[], outDir: string) {
  const safeOut = await assertInsideRoots(outDir);
  await mkdir(safeOut, { recursive: true });
  const files: Record<string, string> = {};
  for (const uid of uids) {
    if (!/^[0-9a-f]{16,64}$/i.test(uid)) continue; // only hash-like ids become file names
    if (!doc.zip.file(`resources/${uid}`)) continue;
    const buf = await readEntry(doc, `resources/${uid}`);
    const dest = path.join(safeOut, uid + sniffExt(buf));
    try {
      await writeFile(dest, buf, { flag: "wx" });
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e; // already extracted earlier
    }
    files[uid] = dest;
  }
  return files;
}

function sniffExt(b: Buffer): string {
  if (b.subarray(0, 4).toString("hex") === "89504e47") return ".png";
  if (b.subarray(0, 3).toString("hex") === "ffd8ff") return ".jpg";
  if (b.subarray(0, 3).toString("ascii") === "GIF") return ".gif";
  if (b.subarray(0, 4).toString("ascii") === "RIFF") return ".webp";
  if (b.subarray(0, 300).toString("utf8").includes("<svg")) return ".svg";
  return "";
}

const exportInput = {
  file,
  depth: z.number().int().min(1).max(64).optional().describe("Max nesting depth. Auto-reduced if the result is too large."),
  assetsDir: z
    .string()
    .optional()
    .describe("Optional absolute folder (inside the allowed roots). Referenced images are saved there as <imageRef>.<ext>."),
};

server.registerTool(
  "xd_export_artboard",
  {
    description:
      "Full-fidelity export of one artboard (or a sub-layer via nodeId) as clean JSON for rebuilding the design in another tool such as Figma: frames, rectangles (with corner radius), ellipses, lines, vector paths (SVG path data), boolean shapes, text (font, size, styled runs), fills (solid/gradient/image), strokes, shadows/effects, opacity, rotation, constraints, components, repeat grids and layout grids. Positions are relative to the parent. Images are referenced by imageRef; pass assetsDir to save them. For big screens, export a sub-layer with nodeId.",
    inputSchema: {
      ...exportInput,
      artboard: z.string().describe("Artboard id or name"),
      nodeId: z.string().optional().describe("Export only this layer id (from a previous export)"),
    },
  },
  guard(async ({ file, artboard, nodeId, depth, assetsDir }) => {
    const doc = await openXd(file);
    const ab = resolveArtboard(doc, artboard);
    if (assetsDir) await assertInsideRoots(assetsDir); // fail fast before doing any work
    const r = await exportArtboard(doc, ab, { nodeId, depth });
    const images = assetsDir ? await saveImages(doc, r.images, assetsDir) : undefined;
    return text(JSON.stringify({ artboard: { id: ab.id, name: ab.name }, depthUsed: r.depthUsed, imageRefs: r.images, images, node: r.node }));
  }),
);

server.registerTool(
  "xd_list_components",
  {
    description: "List the reusable components (symbols) defined in the file: id, name, size.",
    inputSchema: { file },
  },
  guard(async ({ file }) => text(await listComponents(await openXd(file)))),
);

server.registerTool(
  "xd_export_component",
  {
    description: "Export one component master (see xd_list_components) in the same format as xd_export_artboard.",
    inputSchema: { ...exportInput, component: z.string().describe("symbolId or component name") },
  },
  guard(async ({ file, component, depth, assetsDir }) => {
    const doc = await openXd(file);
    if (assetsDir) await assertInsideRoots(assetsDir);
    const r = await exportComponent(doc, component, { depth });
    const images = assetsDir ? await saveImages(doc, r.images, assetsDir) : undefined;
    return text(JSON.stringify({ depthUsed: r.depthUsed, imageRefs: r.images, images, node: r.node }));
  }),
);

server.registerTool(
  "xd_get_shared_assets",
  {
    description: "Document-level libraries: saved color swatches, library colors and character (text) styles.",
    inputSchema: { file },
  },
  guard(async ({ file }) => text(await sharedAssets(await openXd(file)))),
);

const optionalArtboard = z.string().optional().describe("Artboard id or name; omit for the whole file");
const pick = async (doc: XdDoc, a?: string) => (a ? resolveArtboard(doc, a) : undefined);

server.registerTool(
  "xd_get_design_system",
  {
    description:
      "Extract the design system actually used in the file: color palette (ranked, with fill/text/stroke usage), typography styles and size scale, corner radii, stroke widths and shadows. Output as json, css (custom properties) or tailwind (theme.extend).",
    inputSchema: { file, format: z.enum(["json", "css", "tailwind"]).default("json") },
  },
  guard(async ({ file, format }) => text(await designSystem(await openXd(file), format ?? "json"))),
);

server.registerTool(
  "xd_audit_design",
  {
    description:
      "Design QA. Checks text contrast (WCAG, background estimated), tiny text, small tap targets on interactive layers, placeholder text, near-duplicate colors, too many fonts/sizes and default layer names. Returns findings with artboard and layer ids plus per-check totals.",
    inputSchema: {
      file,
      artboard: optionalArtboard,
      minTapTarget: z.number().min(1).max(200).default(44),
      minFontSize: z.number().min(1).max(100).default(11),
      maxPerCheck: z.number().int().min(1).max(500).default(25),
    },
  },
  guard(async ({ file, artboard, minTapTarget, minFontSize, maxPerCheck }) => {
    const doc = await openXd(file);
    return text(await audit(doc, await pick(doc, artboard), { minTapTarget, minFontSize, maxPerCheck }));
  }),
);

server.registerTool(
  "xd_find_layers",
  {
    description: "Search layers across the file by text content, layer name, type (text, rectangle, ellipse, path, group, ...) or color (#rrggbb, matched with a small tolerance).",
    inputSchema: {
      file,
      text: z.string().optional(),
      name: z.string().optional(),
      type: z.string().optional(),
      color: z.string().optional().describe("#rrggbb"),
      artboard: optionalArtboard,
      limit: z.number().int().min(1).max(500).default(50),
    },
  },
  guard(async ({ file, artboard, ...q }) => {
    const doc = await openXd(file);
    return text(await findLayers(doc, { ...q, artboard: await pick(doc, artboard) }));
  }),
);

server.registerTool(
  "xd_export_copy",
  {
    description: "Export all text content (a copy deck) for translation or review, as json or csv. CSV cells are protected against spreadsheet formula injection.",
    inputSchema: { file, artboard: optionalArtboard, format: z.enum(["json", "csv"]).default("json") },
  },
  guard(async ({ file, artboard, format }) => {
    const doc = await openXd(file);
    return text(await copyDeck(doc, await pick(doc, artboard), format ?? "json"));
  }),
);

server.registerTool(
  "xd_get_flow",
  {
    description: "Prototype flow map: every interaction (tap/hover/time triggers, transitions, destinations) with source screen and layer, the home screen, and a Mermaid flowchart of screen-to-screen links.",
    inputSchema: { file },
  },
  guard(async ({ file }) => text(await flowMap(await openXd(file)))),
);

server.registerTool(
  "xd_project_overview",
  {
    description: "Scan a folder (inside the allowed roots) for .xd files and summarize each: name, size, artboard and component counts, whether it has a prototype. Searches up to 3 levels deep, max 60 files.",
    inputSchema: { folder: z.string().describe("Absolute folder path") },
  },
  guard(async ({ folder }) => text(await projectOverview(folder))),
);

/* Ready-made prompts: shown as one-click starters in clients that support MCP prompts. */
const promptArgs = { file: z.string().describe("Absolute path to the .xd file"), artboard: z.string().describe("Artboard name") };
const userPrompt = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

server.registerPrompt(
  "xd-to-figma",
  { title: "Rebuild an XD screen in Figma", description: "Recreate one artboard in Figma (needs the Figma MCP server too).", argsSchema: promptArgs },
  ({ file, artboard }) =>
    userPrompt(
      `Rebuild the artboard "${artboard}" from ${file} in Figma. First call xd_export_artboard (use assetsDir for images), then create frames, shapes, text and images in Figma from that JSON, keeping positions, fills, strokes, shadows, corner radii and fonts. Create components for any xd_list_components items you reuse. Compare against xd_get_preview when done and list what could not be reproduced.`,
    ),
);

server.registerPrompt(
  "xd-to-code",
  { title: "Turn an XD screen into code", description: "Generate a responsive UI component from one artboard.", argsSchema: { ...promptArgs, stack: z.string().default("React + Tailwind") } },
  ({ file, artboard, stack }) =>
    userPrompt(
      `Build the artboard "${artboard}" from ${file} as ${stack ?? "React + Tailwind"}. Call xd_get_design_system (format tailwind or css) first and use those tokens, then xd_export_artboard for layout, text and images. Use flex layout where the export shows stacks or aligned rows, keep text exact, and note any assumptions.`,
    ),
);

server.registerPrompt(
  "xd-design-review",
  { title: "Review a design file", description: "Run a design QA pass over a whole file.", argsSchema: { file: z.string().describe("Absolute path to the .xd file") } },
  ({ file }) =>
    userPrompt(
      `Review ${file}. Call xd_audit_design and xd_get_design_system, then summarize the most important accessibility, consistency and system issues with specific screens and layers, ordered by impact. Suggest concrete fixes.`,
    ),
);

await server.connect(new StdioServerTransport());
