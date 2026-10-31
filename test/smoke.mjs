// Builds a synthetic .xd, then talks to the built server over stdio.
import JSZip from "jszip";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const zip = new JSZip();
zip.file("mimetype", "application/vnd.adobe.sparkler.project+xd");
zip.file(
  "manifest",
  JSON.stringify({
    name: "Demo",
    children: [{ name: "artwork", path: "artwork", children: [{ name: "Home", path: "artboard-1" }] }],
  }),
);
zip.file(
  "artwork/artboard-1/graphics/graphicContent.agc",
  JSON.stringify({
    children: [
      {
        type: "artboard",
        name: "Home",
        artboard: {
          children: [
            {
              id: "a", type: "shape", name: "Button",
              transform: { tx: 10, ty: 20 },
              shape: { type: "rect", width: 100, height: 40, r: [8, 8, 8, 8] },
              style: { fill: { type: "solid", color: { mode: "RGB", value: { r: 255, g: 0, b: 0 } } } },
            },
            {
              id: "b", type: "text", name: "Label",
              text: { rawText: "Hello XD", frame: { width: 80, height: 20 } },
              style: { font: { family: "Inter", style: "Bold", size: 16 } },
            },
          ],
        },
      },
    ],
  }),
);
zip.file("interactions/interactions.json", JSON.stringify({ homeArtboardId: "artboard-1" }));
const dir = mkdtempSync(path.join(tmpdir(), "xd-"));
const xd = path.join(dir, "demo.xd");
writeFileSync(xd, await zip.generateAsync({ type: "nodebuffer" }));

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: dir } }));
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
console.log(await call("xd_list_artboards", { file: xd }));
console.log(await call("xd_get_artboard", { file: xd, artboard: "home" }));
console.log(await call("xd_extract_text", { file: xd }));
console.log(await call("xd_get_design_tokens", { file: xd }));
console.log(await call("xd_get_interactions", { file: xd }));
const denied = await client.callTool({ name: "xd_extract_assets", arguments: { file: xd, outDir: path.join(dir, "..", "escape") } });
console.log("outside-root write blocked:", denied.isError === true, denied.content[0].text);
const denied2 = await client.callTool({ name: "xd_list_artboards", arguments: { file: path.join(dir, "..", "x.xd") } });
console.log("outside-root read blocked:", denied2.isError === true);
const denied3 = await client.callTool({ name: "xd_list_artboards", arguments: { file: path.join(dir, "manifest.json") } });
console.log("non-.xd blocked:", denied3.isError === true);
await client.close();
