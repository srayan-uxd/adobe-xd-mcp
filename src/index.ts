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
} from "./xd.js";

const server = new McpServer({ name: "adobe-xd-mcp", version: "0.1.0" });

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
    description: "List the artboards in an Adobe XD file with their ids and names, plus document name.",
    inputSchema: { file },
  },
  guard(async ({ file }) => {
    const doc = await openXd(file);
    return text({
      name: doc.manifest?.name,
      artboardCount: doc.artboards.length,
      artboards: doc.artboards.map(({ id, name }) => ({ id, name })),
    });
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
    const data = await doc.zip.file(name)!.async("base64");
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
      const buf = await doc.zip.file(e)!.async("nodebuffer");
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

function sniffExt(b: Buffer): string {
  if (b.subarray(0, 4).toString("hex") === "89504e47") return ".png";
  if (b.subarray(0, 3).toString("hex") === "ffd8ff") return ".jpg";
  if (b.subarray(0, 3).toString("ascii") === "GIF") return ".gif";
  if (b.subarray(0, 4).toString("ascii") === "RIFF") return ".webp";
  if (b.subarray(0, 300).toString("utf8").includes("<svg")) return ".svg";
  return "";
}

await server.connect(new StdioServerTransport());
