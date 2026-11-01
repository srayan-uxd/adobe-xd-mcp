// Checks the SVG renderer (no browser needed) and, if Chrome/Edge is installed, the PNG screenshot.
import JSZip from "jszip";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildSvg, findBrowser, weightOf } from "../dist/render.js";

let fails = 0;
const check = (name, ok) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fails++; };

/* --- SVG structure, from an export-shaped tree --- */
const fakeDoc = { zip: { file: () => null }, entries: [] };
const tree = {
  type: "frame", id: "f", width: 200, height: 120, fills: [{ type: "solid", color: "#ffffff", opacity: 1 }],
  children: [
    { type: "group", id: "g", x: 10, y: 20, width: 100, height: 60,
      mask: { shape: "rectangle", x: 5, y: 6, width: 40, height: 30, radius: 4, localBox: { x: 0, y: 0, width: 40, height: 30 } },
      children: [{ type: "rectangle", id: "r", x: 0, y: 0, width: 100, height: 60, localBox: { x: 0, y: 0, width: 100, height: 60 },
        fills: [{ type: "gradient", kind: "linear", stops: [{ offset: 0, color: "#ff0000", opacity: 1 }, { offset: 1, color: "#0000ff", opacity: 1 }], x1: 0, y1: 0, x2: 1, y2: 0, units: "objectBoundingBox" }],
        strokes: [{ type: "solid", color: "#000000", opacity: 1, width: 2, align: "inside" }],
        effects: [{ type: "dropShadow", visible: true, shadows: [{ x: 1, y: 2, blur: 6, color: "#000000", alpha: 0.4 }] }] }] },
    { type: "text", id: "t", x: 100, y: 90, width: 60, height: 20, box: { x: 100, y: 90, width: 60, height: 20 },
      fills: [{ type: "solid", color: "#112233", opacity: 1 }],
      text: { characters: "Hi <script>alert(1)</script>\nSecond", alignment: "right", baselineY: 104, lineHeight: 16, font: { family: "Evil\" onload=\"x", style: "Bold", size: 12 }, styledRuns: [{ from: 0, to: 2, underline: true }] } },
  ],
};
const { svg } = await buildSvg(fakeDoc, tree, []);
check("svg is one document with defs", svg.startsWith("<svg") && svg.includes("<defs>") && svg.endsWith("</svg>"));
check("mask becomes a clipPath whose children are shapes (no <g>)", /<clipPath id="m\d+"><(rect|path)[^>]*transform="translate\(5 6\)"/.test(svg) && !/<clipPath[^>]*><g/.test(svg));
check("gradient and shadow filter are defined", svg.includes("<linearGradient") && svg.includes("<feGaussianBlur") && svg.includes('stdDeviation="3"'));
check("inside stroke is clipped to the shape", /<g clip-path="url\(#c\d+\)">/.test(svg));
check("text uses tspans, end anchor and underline", svg.includes('text-anchor="end"') && svg.includes('text-decoration="underline"') && (svg.match(/<tspan/g) ?? []).length >= 3);
check("text content and font names are escaped (no script injection)", !svg.includes("<script>") && svg.includes("&lt;script&gt;") && !/onload="x/.test(svg));
check("weight names map to numbers", weightOf("Bold") === 700 && weightOf("SemiBold") === 600 && weightOf("Heavy") === 800 && weightOf("Regular") === 400);

/* --- PNG screenshot through the server (only when a browser exists) --- */
const browser = await findBrowser();
if (!browser) console.log("SKIP screenshot test (no Chrome/Edge found)");
else {
  const solid = (r, g, b) => ({ type: "solid", color: { mode: "RGB", value: { r, g, b } } });
  const zip = new JSZip();
  zip.file("manifest", JSON.stringify({ name: "R", children: [{ name: "artwork", path: "artwork", children: [{ name: "Shot", path: "artboard-shot" }] }] }));
  zip.file("artwork/artboard-shot/graphics/graphicContent.agc", JSON.stringify({ children: [{ type: "artboard", id: "shot", style: { fill: solid(255, 255, 255) }, artboard: { ref: "r", children: [
    { id: "a", type: "shape", name: "Box", transform: { a: 1, b: 0, c: 0, d: 1, tx: 20, ty: 20 }, shape: { type: "rect", x: 0, y: 0, width: 100, height: 60, r: 8 }, style: { fill: solid(0, 51, 160) } }] } }] }));
  zip.file("resources/graphics/graphicContent.agc", JSON.stringify({ artboards: { r: { x: 0, y: 0, width: 320, height: 200 } }, resources: { meta: { ux: { symbols: [] } } } }));
  const dir = mkdtempSync(path.join(tmpdir(), "xdrender-"));
  const xd = path.join(dir, "r.xd");
  writeFileSync(xd, await zip.generateAsync({ type: "nodebuffer" }));
  const client = new Client({ name: "r", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: dir } }));
  const r = await client.callTool({ name: "xd_render_artboard", arguments: { file: xd, artboard: "Shot" } });
  const png = r.isError ? null : Buffer.from(r.content[0].data, "base64");
  check("screenshot is a PNG of the artboard size", !!png && png.readUInt32BE(0) === 0x89504e47 && png.readUInt32BE(16) === 320 && png.readUInt32BE(20) === 200);
  check("screenshot is not blank (more than a flat white image)", !!png && png.length > 800);
  const denied = await client.callTool({ name: "xd_render_artboard", arguments: { file: path.join(dir, "..", "x.xd"), artboard: "Shot" } });
  check("render respects the allowed roots", denied.isError === true);
  await client.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
