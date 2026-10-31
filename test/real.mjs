// Usage: node test/real.mjs <file.xd> [artboard]
// Exercises the built server against a real .xd file (read-only).
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const file = path.resolve(process.argv[2]);
const tmp = mkdtempSync(path.join(tmpdir(), "xd-real-"));
const client = new Client({ name: "real", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, XD_MCP_ROOTS: [path.dirname(file), tmp].join(path.delimiter) },
  }),
);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: { file, ...args } });
  return { isError: r.isError, text: r.content[0].type === "text" ? r.content[0].text : `[${r.content[0].type}]` };
};
const show = (title, r, max = 1500) =>
  console.log(`\n=== ${title}${r.isError ? " (ERROR)" : ""} ===\n${r.text.slice(0, max)}${r.text.length > max ? `\n… (${r.text.length} chars)` : ""}`);

const entries = await call("xd_list_entries", {});
const list = JSON.parse(entries.text);
console.log(`entries: ${list.length}`);
console.log(list.filter((e) => !/^resources\/[0-9a-f]{20,}/i.test(e)).slice(0, 30).join("\n"));

const ab = await call("xd_list_artboards", {});
show("artboards", ab, 800);
const parsed = JSON.parse(ab.text);
const target = process.argv[3] ?? parsed.artboards[0]?.name;
if (target) {
  show(`artboard "${target}"`, await call("xd_get_artboard", { artboard: target, depth: 2 }), 3000);
  show("text", await call("xd_extract_text", { artboard: target }), 1200);
}
const exp = await call("xd_export_artboard", { artboard: target, assetsDir: path.join(tmp, "img") });
const ej = JSON.parse(exp.text);
const kinds = {};
const walk = (n) => { kinds[n.type] = (kinds[n.type] ?? 0) + 1; (n.children ?? []).forEach(walk); };
walk(ej.node);
console.log("\n=== export ===");
console.log("size:", exp.text.length, "depthUsed:", ej.depthUsed, "root:", ej.node.type, ej.node.width + "x" + ej.node.height);
console.log("node types:", JSON.stringify(kinds));
console.log("images saved:", Object.keys(ej.images ?? {}).length, "of", ej.imageRefs.length);
show("components", await call("xd_list_components", {}), 500);
show("shared assets", await call("xd_get_shared_assets", {}), 500);
show("tokens", await call("xd_get_design_tokens", {}), 1500);
show("interactions", await call("xd_get_interactions", {}), 800);
show("preview", await call("xd_get_preview", {}), 100);
await client.close();
