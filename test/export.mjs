// Synthetic checks for the export pipeline: linked components, masks, text, transforms, paths, paging.
import JSZip from "jszip";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const solid = (r, g, b) => ({ type: "solid", color: { mode: "RGB", value: { r, g, b } } });
const T = (tx, ty, extra = {}) => ({ a: 1, b: 0, c: 0, d: 1, tx, ty, ...extra });
const VT = String.fromCharCode(11); // XD soft line break

const master = {
  id: "master", type: "group", name: "Btn", transform: T(0, 0),
  meta: { ux: { symbolId: "sym1", width: 40, height: 20 } },
  group: { children: [{ id: "src1", type: "shape", name: "Fill", transform: T(3, 4), shape: { type: "rect", x: 0, y: 0, width: 10, height: 12 }, style: { fill: solid(9, 9, 9) } }] },
};
const nested = { id: "nestedSrc", type: "shape", name: "Dot", transform: T(1, 1), shape: { type: "circle", cx: 5, cy: 5, r: 5 }, style: { fill: solid(1, 2, 3) } };
master.group.children.push({ type: "syncRef", syncSourceGuid: "nestedSrc", guid: "inner1" });

const big = (i) => ({ id: "big" + i, type: "group", name: "Big " + i, transform: T(0, 0), group: { children: Array.from({ length: 600 }, (_, k) => ({ id: `b${i}-${k}`, type: "shape", name: "Rectangle " + k, transform: T(k, k), shape: { type: "rect", x: 0, y: 0, width: 5, height: 5 }, style: { fill: solid(10, 20, 30) } })) } });

const top = {
  id: "grp", type: "group", name: "Top", transform: T(1100, 250),
  group: {
    children: [
      { type: "syncRef", syncSourceGuid: "src1", guid: "inst1" },
      { id: "txtR", type: "text", name: "Right", transform: T(200, 40),
        text: { rawText: "Hello" + VT + "World", frame: { type: "positioned" }, paragraphs: [{ lines: [[{ x: -60, y: 0, from: 0, to: 5, style: { textAttributes: { decoration: ["underline"] } } }], [{ x: -50, y: 20, from: 6, to: 11 }]] }] },
        style: { fill: solid(0, 0, 0), font: { family: "Inter", postscriptName: "Inter-Bold", style: "Bold", size: 10 }, textAttributes: { paragraphAlign: "right", lineHeight: 20 } } },
      { id: "instance", type: "group", name: "Btn", transform: T(500, 0), meta: { ux: { symbolId: "sym1" } }, group: { children: [{ type: "syncRef", syncSourceGuid: "src1", guid: "i2" }] } },
      { id: "rot", type: "shape", name: "Arrow", transform: { a: 0, b: 1, c: -1, d: 0, tx: 50, ty: 60 }, shape: { type: "rect", x: 0, y: 0, width: 20, height: 10 }, style: { fill: solid(5, 5, 5) } },
      { id: "pth", type: "shape", name: "Curve", transform: T(0, 0), shape: { type: "path", path: "M 110 110 C 120 100 130 100 140 110 L 140 130 Z" }, style: { fill: solid(7, 7, 7) } },
      { id: "msk", type: "group", name: "Masked", transform: T(300, 0), group: { children: [{ id: "inMask", type: "shape", name: "Photo", transform: T(0, 0), shape: { type: "rect", x: 0, y: 0, width: 100, height: 100 }, style: { fill: solid(1, 1, 1) } }] },
        meta: { ux: { clipPathResources: { type: "clipPath", children: [{ id: "m1", type: "shape", transform: T(12, 8), shape: { type: "rect", x: 0, y: 0, width: 40, height: 30, r: 6 } }] } } } },
    ],
  },
};

const zip = new JSZip();
zip.file("manifest", JSON.stringify({ name: "Exp", children: [{ name: "artwork", path: "artwork", children: [{ name: "Main", path: "artboard-main" }, { name: "Big", path: "artboard-big" }] }] }));
zip.file("artwork/artboard-main/graphics/graphicContent.agc", JSON.stringify({ children: [{ type: "artboard", id: "main", artboard: { ref: "r-main", children: [top] }, style: { fill: solid(255, 255, 255) } }] }));
zip.file("artwork/artboard-big/graphics/graphicContent.agc", JSON.stringify({ children: [{ type: "artboard", id: "big", artboard: { ref: "r-big", children: [big(1), big(2), big(3)] } }] }));
zip.file("resources/graphics/graphicContent.agc", JSON.stringify({ artboards: { "r-main": { x: 1000, y: 200, width: 800, height: 600 }, "r-big": { x: 0, y: 0, width: 800, height: 600 } }, resources: { meta: { ux: { symbols: [master, nested] } } } }));

const dir = mkdtempSync(path.join(tmpdir(), "xdexp-"));
const xd = path.join(dir, "exp.xd");
writeFileSync(xd, await zip.generateAsync({ type: "nodebuffer" }));

let fails = 0;
const check = (name, ok) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fails++; };
const client = new Client({ name: "exp", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: dir } }));
const j = async (name, args) => { const r = await client.callTool({ name, arguments: { file: xd, ...args } }); return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text); };
const find = (n, id) => n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean);

const e = await j("xd_export_artboard", { artboard: "Main" });
const g = find(e.node, "grp");
check("top-level group is artboard-relative", g.x === 100 && g.y === 50);

const inst = find(e.node, "inst1");
check("linked component resolved to source content", inst?.type === "rectangle" && inst.fills[0].color === "#090909" && inst.linkedFrom === "src1" && inst.width === 10);
const comp = await j("xd_export_component", { component: "sym1" });
check("syncRef inside a component source is resolved too (nested)", comp.node.children?.some((c) => c.type === "ellipse" && c.linkedFrom === "nestedSrc") && comp.syncRefs.unresolved === 0);
check("no syncRef or unresolved nodes left", e.syncRefs.unresolved === 0 && e.syncRefs.resolved >= 1);

const txt = find(e.node, "txtR");
check("soft break replaced by newline", txt.text.characters === "Hello\nWorld");
check("right-aligned text: exact width from line offsets, box starts left of anchor", txt.text.alignment === "right" && txt.box.width === 60 && txt.box.x === 140 && !txt.text.widthApprox);
check("baselineY, lineHeight and autoResize emitted", txt.text.baselineY === 40 && txt.text.lineHeight === 20 && txt.text.autoResize === "WIDTH_AND_HEIGHT");
check("box top = baseline minus ascent (approx formula)", Math.abs(txt.box.y - (40 - ((20 - 1.17 * 10) / 2 + 0.92 * 10))) < 0.02);
check("partial underline run keeps offsets", txt.text.styledRuns.some((r) => r.underline && r.from === 0 && r.to === 5));
check("font report lists the family", e.fonts.some((f) => f.family === "Inter" && f.style === "Bold"));

const rot = find(e.node, "rot");
check("rotated layer: full matrix + origin", rot.transform.b === 1 && rot.transform.c === -1 && rot.transformOrigin === "top-left" && rot.rotation === 90);

const pth = find(e.node, "pth");
const coords = pth.svgPathLocal.match(/-?[0-9]+(?:[.][0-9]+)?/g).map(Number);
check("path: svgPathLocal is translated to a 0,0 origin; localBox gives the offset", Math.min(...coords.filter((_, i) => i % 2 === 0)) >= -0.001 && pth.localBox.x === 110 && !pth.svgPath);
check("path bounds are exact for cubic curves (top of the curve)", pth.localBox.y > 100 && pth.localBox.y < 105 && !pth.boundsApprox);

const msk = find(e.node, "msk");
check("mask is positioned in the group's local space", msk.mask.x === 12 && msk.mask.y === 8 && msk.mask.width === 40 && msk.mask.radius === 6);

const bigE = await j("xd_export_artboard", { artboard: "Big", maxChars: 80000 });
check("big artboard is paged, not cut", bigE.pageCount >= 2 && bigE.truncated === false && bigE.hasMore === true);
let seen = 0, p = 0, more = true;
while (more) { const r = await j("xd_export_artboard", { artboard: "Big", maxChars: 80000, page: p++ }); seen += r.node.children.length; more = r.hasMore; }
check("all top-level layers are delivered across pages", seen === 3);
check("depth cap is explicit: marked truncated", (await j("xd_export_artboard", { artboard: "Big", depth: 1, maxChars: 900000 })).truncated === true);

const comps = await (async () => (await client.callTool({ name: "xd_list_components", arguments: { file: xd } })).content[0].text)();
check("component list has usage counts and description", /"usageCount": 1/.test(comps) && /Reusable component/.test(comps));

await client.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
