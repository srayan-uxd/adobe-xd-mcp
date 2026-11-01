// xd_infer_layout on a synthetic screen: cards, rows, buttons, header, illustrations, decorations, drift report.
import JSZip from "jszip";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanName } from "../dist/layout.js";

let fails = 0;
const check = (name, ok) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fails++; };

const solid = (r, g, b) => ({ type: "solid", color: { mode: "RGB", value: { r, g, b } } });
const T = (tx, ty) => ({ a: 1, b: 0, c: 0, d: 1, tx, ty });
let id = 0;
const rect = (x, y, w, h, fill, name = "Rectangle") => ({ id: `r${id++}`, type: "shape", name, transform: T(x, y), shape: { type: "rect", x: 0, y: 0, width: w, height: h }, style: { fill: solid(...fill) } });
// area text: `top` is the top of the text box, so the baseline is 0.92 * size below it (default line height)
const text = (x, top, w, str, size = 14, style = "Regular", lines = 1) => ({
  id: `t${id++}`, type: "text", name: str, transform: T(x, top + 0.92 * size),
  text: { rawText: str, frame: { type: "area", width: w, height: lines * size * 1.17 } },
  style: { fill: solid(20, 20, 20), font: { family: "Inter", style, size }, textAttributes: {} },
});
const pathPiece = (x, y) => ({ id: `p${id++}`, type: "shape", name: "Path", transform: T(x, y), shape: { type: "path", path: "M 0 0 L 24 0 L 24 24 L 0 24 Z" }, style: { fill: solid(30, 60, 200) } });

const cards = [20, 280, 540].flatMap((x, i) => [
  rect(x, 100, 240, 160, [245, 245, 245], "Card bg"),
  text(x + 16, 116, 200, `Card title ${i + 1}`, 16, "Bold"),
  text(x + 16, 148, 200, "Body copy that explains the card", 12, "Regular", 2),
  rect(x + 16, 212, 100, 32, [0, 51, 160], "Button bg"),
  text(x + 16 + 50 - 30, 212 + 8, 60, "Go", 14, "Bold"),
]);
const decoration = { id: "deco", type: "shape", name: "Art", transform: T(660, 100), shape: { type: "ellipse", cx: 50, cy: 50, rx: 50, ry: 50 }, style: { fill: solid(220, 230, 255) } };
const header = [rect(20, 20, 24, 24, [0, 51, 160], "Logo"), text(56, 22, 80, "Brand", 14, "Bold"), rect(700, 20, 24, 24, [90, 90, 90], "Icon a"), rect(730, 20, 24, 24, [90, 90, 90], "Icon b"), rect(760, 20, 24, 24, [90, 90, 90], "Icon c")];
const art = { id: "ill", type: "group", name: "Illustration", transform: T(20, 300), group: { children: Array.from({ length: 25 }, (_, k) => pathPiece((k % 5) * 14, Math.floor(k / 5) * 14)) } };

const zip = new JSZip();
zip.file("manifest", JSON.stringify({ name: "L", children: [{ name: "artwork", path: "artwork", children: [{ name: "Screen", path: "artboard-s" }] }] }));
zip.file("artwork/artboard-s/graphics/graphicContent.agc", JSON.stringify({ children: [{ type: "artboard", id: "s", artboard: { ref: "r", children: [...header, ...cards, decoration, art] }, style: { fill: solid(255, 255, 255) } }] }));
zip.file("resources/graphics/graphicContent.agc", JSON.stringify({ artboards: { r: { x: 0, y: 0, width: 800, height: 600 } }, resources: { meta: { ux: { symbols: [] } } } }));
const dir = mkdtempSync(path.join(tmpdir(), "xdlay-"));
const xd = path.join(dir, "l.xd");
writeFileSync(xd, await zip.generateAsync({ type: "nodebuffer" }));

const client = new Client({ name: "l", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: dir } }));
const infer = async (args = {}) => { const r = await client.callTool({ name: "xd_infer_layout", arguments: { file: xd, artboard: "Screen", ...args } }); return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text); };

const r = await infer({ maxDrift: 40 });
const all = [];
const walk = (n) => { all.push(n); (n.children ?? []).forEach(walk); (n.absoluteChildren ?? []).forEach(walk); };
walk(r.tree);
if (process.env.DEBUG_LAYOUT) { const show = (n, d) => { console.log("  ".repeat(d) + `${n.type}${n.kind ? "(" + n.kind + ")" : ""} "${n.suggestedName}" ${n.box.width}x${n.box.height} @${n.box.x},${n.box.y} ${n.layout ? n.layout.mode[0] + " sp=" + n.layout.itemSpacing + " pad=" + n.layout.padding.join("/") + " " + n.layout.primaryAxisAlign + "/" + n.layout.counterAxisAlign : ""} ${n.sizing ? n.sizing.horizontal : ""}${n.absoluteChildren ? " abs=" + n.absoluteChildren.map((a) => a.name).join("|") : ""}`); (n.children ?? []).forEach((c) => show(c, d + 1)); }; show(r.tree, 0); console.log(JSON.stringify(r.quality)); }
const frames = all.filter((n) => n.type === "frame");

check("quality report has the drift fields", ["pixelDeltaEstimate", "elementsAbsolute", "elementsAutoLayout", "within3px", "within5px", "textWithin5px"].every((k) => typeof r.quality[k] === "number"));
const cardFrames = frames.filter((f) => /^Card \/ Card title/.test(f.suggestedName));
check("three cards found by containment, named from their title", cardFrames.length === 3);
check("cards sit in a horizontal row with equal FILL widths", (() => { const row = frames.find((f) => f.children?.filter((c) => /^Card/.test(c.suggestedName)).length === 3); return !!row && row.layout.mode === "HORIZONTAL" && row.layout.itemSpacing === 20 && row.children.every((c) => c.sizing?.horizontal === "FILL"); })());
check("a card stacks its text vertically with spacing and padding rounded to the grid", cardFrames.every((c) => c.layout.mode === "VERTICAL" && c.layout.padding.every((p) => p % 4 === 0)));
const buttons = frames.filter((f) => f.kind === "button");
check("centred label on a filled rectangle becomes a button", buttons.length === 3 && buttons.every((b) => b.layout.primaryAxisAlign === "CENTER" && b.layout.counterAxisAlign === "CENTER" && /^Button \/ Go/.test(b.suggestedName)));
check("big art behind a card's text is an absolute child", cardFrames.some((c) => (c.absoluteChildren ?? []).length > 0) || frames.some((f) => (f.absoluteChildren ?? []).some((a) => /Art|ellipse/i.test(a.name + a.type))));
check("a drawing of many vector parts is one fixed illustration leaf", all.some((n) => n.type === "illustration" && n.kind === "fixed-leaf" && n.box.width > 20));
const header2 = frames.find((f) => f.layout?.primaryAxisAlign === "SPACE_BETWEEN");
check("header row with a big gap is SPACE_BETWEEN with left and right groups", !!header2 && header2.children.length === 2);
check("suggested names: titles and text are labelled by content", all.some((n) => n.type === "text" && /^Heading \/ Card title/.test(n.suggestedName)));
check("leaves reference exact layers by ref", all.filter((n) => n.type === "text").every((n) => typeof n.ref === "string"));

const strict = await infer({ maxDrift: 5 });
check("drift limit keeps every text within 5px of the original", strict.quality.textWithin5px === strict.quality.textLayers);
const loose = await infer({ maxDrift: 0 });
check("maxDrift 0 never falls back to exact positions", loose.quality.elementsAutoLayout >= strict.quality.elementsAutoLayout);

check("cleanName strips export suffixes", cleanName("Group_34330_224") === "Group" && cleanName("Rectangle 1221") === "Rectangle" && cleanName("Card – 4") === "Card" && cleanName("") === "Layer");
const named = JSON.parse((await client.callTool({ name: "xd_export_artboard", arguments: { file: xd, artboard: "Screen", semanticNames: true } })).content[0].text);
check("export can add suggestedName to every layer", named.node.children.every((c) => typeof c.suggestedName === "string"));

await client.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
