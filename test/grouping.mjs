// Grouping of illustrations and icons, text never lost from the layout tree, and layers exported as one SVG.
import JSZip from "jszip";
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let fails = 0;
const check = (name, ok) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fails++; };

const solid = (r, g, b) => ({ type: "solid", color: { mode: "RGB", value: { r, g, b } } });
const T = (tx, ty) => ({ a: 1, b: 0, c: 0, d: 1, tx, ty });
const piece = (id, x, y, w = 40, h = 40) => ({ id, type: "shape", name: "Path", transform: T(x, y), shape: { type: "path", path: `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z` }, style: { fill: solid(30, 60, 200) } });
const rect = (id, x, y, w, h, fill = [245, 245, 245]) => ({ id, type: "shape", name: "Card bg", transform: T(x, y), shape: { type: "rect", x: 0, y: 0, width: w, height: h }, style: { fill: solid(...fill) } });
const text = (id, x, top, str, size = 14) => ({ id, type: "text", name: str, transform: T(x, top + 0.92 * size), text: { rawText: str, frame: { type: "area", width: 120, height: size * 1.17 } }, style: { fill: solid(0, 0, 0), font: { family: "Inter", style: "Regular", size } }, });

const drawing = [0, 1, 2, 3, 4, 5].map((i) => piece(`d${i}`, 300 + i * 20, 100 + i * 10)); // overlapping chain, never grouped
const dots = [0, 1, 2, 3, 4].map((i) => ({ id: `dot${i}`, type: "shape", name: "Dot", transform: T(20 + i * 30, 500), shape: { type: "ellipse", cx: 5, cy: 5, rx: 5, ry: 5 }, style: { fill: solid(0, 0, 0) } }));
const bigGroup = { id: "bg", type: "group", name: "Group", transform: T(500, 300), group: { children: Array.from({ length: 8 }, (_, i) => piece(`g${i}`, i * 10, i * 10, 30, 30)) } };
const dupCards = [
  rect("dup", 20, 20, 200, 80), text("t-one", 36, 40, "First card text"),
  rect("dup", 20, 140, 200, 80), text("t-two", 36, 160, "Second card text"),
];
const rotated = { id: "rot", type: "group", name: "Rotated", transform: { a: 0, b: 1, c: -1, d: 0, tx: 700, ty: 20 }, group: { children: [text("t-rot", 0, 0, "Rotated words")] } };

const zip = new JSZip();
zip.file("manifest", JSON.stringify({ name: "G", children: [{ name: "artwork", path: "artwork", children: [{ name: "Grouping", path: "artboard-g" }] }] }));
zip.file("artwork/artboard-g/graphics/graphicContent.agc", JSON.stringify({ children: [{ type: "artboard", id: "g", style: { fill: solid(255, 255, 255) }, artboard: { ref: "r", children: [...drawing, ...dots, bigGroup, ...dupCards, rotated] } }] }));
zip.file("resources/graphics/graphicContent.agc", JSON.stringify({ artboards: { r: { x: 0, y: 0, width: 800, height: 600 } }, resources: { meta: { ux: { symbols: [] } } } }));
const dir = mkdtempSync(path.join(tmpdir(), "xdgrp-"));
const outside = mkdtempSync(path.join(tmpdir(), "xdgrp-out-"));
const xd = path.join(dir, "g.xd");
writeFileSync(xd, await zip.generateAsync({ type: "nodebuffer" }));

const client = new Client({ name: "grp", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: dir } }));
const raw = (name, args) => client.callTool({ name, arguments: { file: xd, artboard: "Grouping", ...args } });
const infer = async (args = {}) => JSON.parse((await raw("xd_infer_layout", { maxDrift: 0, ...args })).content[0].text);
const leaves = (t) => { const out = []; const w = (n) => { if (n.type !== "frame") out.push(n); (n.children ?? []).forEach(w); (n.absoluteChildren ?? []).forEach(w); }; w(t); return out; };

const r = await infer();
const all = leaves(r.tree);
const merged = all.find((n) => n.parts && n.parts.length === 6);
check("six overlapping loose pieces become ONE illustration with their ids listed", !!merged && merged.type === "illustration" && merged.parts.every((id) => /^d[0-5]$/.test(id)));
check("the grouping report says what was merged", r.grouping.mergedDrawings >= 1 && r.grouping.mergedParts >= 6 && r.grouping.illustrations >= 1);
check("separate dots that don't touch stay separate icons", all.filter((n) => n.type === "icon" && /Dot|Icon/.test(n.name + n.suggestedName) && n.ref?.startsWith("dot")).length === 5);

const off = leaves((await infer({ mergeLoose: false })).tree);
check("mergeLoose:false keeps the pieces loose", !off.some((n) => n.parts) && off.filter((n) => n.ref?.startsWith("d") && /^d[0-5]$/.test(n.ref)).length === 6);
const few = await infer({ looseMinParts: 8 });
check("looseMinParts is adjustable", !leaves(few.tree).some((n) => n.parts && n.parts.length === 6));
const flatGroup = leaves((await infer({ mergeLoose: false })).tree).filter((n) => /^g[0-7]$/.test(n.ref ?? ""));
check("a group of 8 parts is flattened with the default threshold (20)", flatGroup.length === 8);
const collapsed = leaves((await infer({ mergeLoose: false, illustrationMinParts: 5 })).tree);
check("illustrationMinParts makes the same group ONE illustration", collapsed.some((n) => n.ref === "bg" && n.type === "illustration") && !collapsed.some((n) => /^g[0-7]$/.test(n.ref ?? "")));

// nothing may disappear from the tree
const texts = ["t-one", "t-two"];
check("two cards with the same layer id both keep their text", texts.every((t) => all.some((n) => n.ref === t)));
const rot = all.find((n) => n.ref === "rot");
check("text inside a rotated group is listed on its fixed leaf", !!rot && rot.textLayers?.some((t) => t.ref === "t-rot" && t.characters === "Rotated words"));
const exp = JSON.parse((await raw("xd_export_artboard", {})).content[0].text).node;
const expText = []; const wk = (n) => { if (n.type === "text") expText.push(n.id); (n.children ?? []).forEach(wk); }; wk(exp);
const treeText = new Set(all.flatMap((n) => [n.type === "text" ? n.ref : null, ...(n.textLayers ?? []).map((t) => t.ref)]).filter(Boolean));
check("every text layer of the screen is present in the layout tree", expText.every((id) => treeText.has(id)));

// layers as one SVG
const svgRes = await raw("xd_export_svg", { ids: merged.parts });
const svgJson = JSON.parse(svgRes.content[0].text);
check("xd_export_svg returns the pieces as one SVG", !svgRes.isError && svgJson.svg.startsWith("<svg") && (svgJson.svg.match(/<path/g) ?? []).length >= 6 && svgJson.layers === 6);
check("the SVG contains only the selection (no text, no page background)", !svgJson.svg.includes("<text") && !/<rect[^>]*width="800"/.test(svgJson.svg));
check("the SVG is cropped to the drawing", svgJson.width < 200 && svgJson.height < 150);
const partial = JSON.parse((await raw("xd_export_svg", { ids: ["d0", "nope"] })).content[0].text);
check("unknown ids are reported, known ones exported", partial.missingIds.includes("nope") && partial.layers === 1);
check("no matching ids is an error", (await raw("xd_export_svg", { ids: ["nope"] })).isError === true);
const saved = JSON.parse((await raw("xd_export_svg", { ids: merged.parts, saveTo: path.join(dir, "svgs") })).content[0].text);
check("saveTo writes the SVG inside the allowed folder", existsSync(saved.savedTo) && readFileSync(saved.savedTo, "utf8").startsWith("<svg") && saved.savedTo.startsWith(dir));
const again = JSON.parse((await raw("xd_export_svg", { ids: merged.parts, saveTo: path.join(dir, "svgs") })).content[0].text);
check("saving never overwrites an existing file", again.savedTo !== saved.savedTo && existsSync(saved.savedTo) && existsSync(again.savedTo));
check("saveTo outside the allowed folders is refused", (await raw("xd_export_svg", { ids: merged.parts, saveTo: outside })).isError === true);
check("the SVG text is escaped (no markup from layer data)", !svgJson.svg.includes("<script"));

await client.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
