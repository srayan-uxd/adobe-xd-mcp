// Synthetic checks for design-system, audit, search, copy, flow and project tools.
import JSZip from "jszip";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rgb = (r, g, b) => ({ type: "solid", color: { mode: "RGB", value: { r, g, b } } });
const text = (id, name, raw, color, size, tx, ty) => ({
  id, type: "text", name, transform: { tx, ty },
  text: { rawText: raw, frame: { type: "positioned" } },
  style: { fill: rgb(...color), font: { family: "Inter", style: "Regular", size } },
});
const board = (id, children, extra = {}) => ({
  children: [{ type: "artboard", id, name: "x", style: { fill: rgb(255, 255, 255) }, artboard: { ref: "r-" + id, children }, ...extra }],
});

const zip = new JSZip();
zip.file("manifest", JSON.stringify({ name: "Demo", children: [{ name: "artwork", path: "artwork", children: [{ name: "Home", path: "artboard-home" }, { name: "Detail", path: "artboard-detail" }] }] }));
zip.file("artwork/artboard-home/graphics/graphicContent.agc", JSON.stringify(board("home", [
  { id: "btn", type: "shape", name: "Button", transform: { tx: 10, ty: 20 }, shape: { type: "rect", x: 0, y: 0, width: 30, height: 20, r: 6 }, style: { fill: rgb(0, 51, 160) }, meta: { ux: { interactions: [{ guid: "g" }] } } },
  text("t1", "Light text", "Hello", [200, 200, 200], 9, 10, 100),
  text("t2", "Dark text", "=HYPERLINK(\"http://evil\")", [0, 0, 0], 16, 10, 140),
  { id: "grp", type: "group", name: "Group 12", transform: { tx: 0, ty: 0 }, group: { children: [] }, meta: { ux: { contentStackType: "vertical" } } },
])));
zip.file("artwork/artboard-detail/graphics/graphicContent.agc", JSON.stringify(board("detail", [text("t3", "Lorem", "Lorem ipsum dolor sit amet", [0, 0, 0], 16, 505, 5)])));
zip.file("resources/graphics/graphicContent.agc", JSON.stringify({ artboards: { "r-home": { x: 0, y: 0, width: 375, height: 667 }, "r-detail": { x: 500, y: 0, width: 375, height: 667 } }, resources: { meta: { ux: { symbols: [] } } } }));
zip.file("interactions/interactions.json", JSON.stringify({ version: "0.24", homeArtboard: "home", interactions: { btn: [{ triggerEvent: "tap", action: "artboard-transition", properties: { destination: "detail", transition: "dissolve", duration: 0.3, easing: "ease-out" } }] } }));

const dir = mkdtempSync(path.join(tmpdir(), "xdin-"));
const xd = path.join(dir, "demo.xd");
writeFileSync(xd, await zip.generateAsync({ type: "nodebuffer" }));

let fails = 0;
const check = (name, ok) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fails++; };
const client = new Client({ name: "ins", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: dir } }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { err: r.isError, t: r.content[0].text }; };
const j = async (name, args) => JSON.parse((await call(name, { file: xd, ...args })).t);

let d = await j("xd_get_design_system", {});
check("design system: colors ranked", d.colors.some((c) => c.hex === "#0033a0") && d.typography.sizeScale.join() === "9,16");
check("design system: radius", d.radii[0]?.value === 6);
const css = (await call("xd_get_design_system", { file: xd, format: "css" })).t;
check("design system: css output", css.startsWith(":root {") && css.includes("--color-1:"));

const fig = await j("xd_get_design_system", { format: "figma-variables" });
check("figma-variables: collections for color, radius and typography", ["Color", "Radius", "Typography"].every((n) => fig.collections.some((c) => c.name === n)));
check("figma-variables: text styles are named by role", fig.textStyles.some((t) => t.name === "Caption/S" && t.fontSize === 9) && fig.textStyles.some((t) => t.name === "Body/L" && t.fontSize === 16));
check("figma-variables: colors named by use, with scopes", fig.collections[0].variables.every((v) => /^(text|border|surface|brand)\/\d+$/.test(v.name) && v.scopes.length >= 1));
check("design system keeps family names intact", d.typography.families.every((f) => f === "Inter"));

d = await j("xd_audit_design", {});
check("audit: low contrast found", d.summary["low-contrast"] >= 1);
check("audit: small text found", d.summary["small-text"] >= 1);
check("audit: placeholder text found", d.summary["placeholder-text"] === 1);
check("audit: small tap target found", d.summary["small-tap-target"] === 1);
check("audit: dark text not flagged", !d.findings.some((f) => f.layer === "Dark text" && f.check === "low-contrast"));

d = await j("xd_find_layers", { text: "hello" });
check("find by text", d.total === 1 && d.results[0].artboard === "Home");
d = await j("xd_find_layers", { color: "#0033a0" });
check("find by color", d.total === 1 && d.results[0].name === "Button");
check("find rejects bad color", (await call("xd_find_layers", { file: xd, color: "red" })).err === true);

const csv = (await call("xd_export_copy", { file: xd, format: "csv" })).t;
check("copy csv: formula injection neutralized", csv.includes(`"'=HYPERLINK`) && !csv.includes(`,"=HYPERLINK`));

d = await j("xd_get_flow", {});
check("flow: edge resolved", d.edgeCount === 1 && d.edges[0].fromArtboard === "Home" && d.edges[0].toArtboard === "Detail" && d.home === "Home");
check("flow: mermaid", d.mermaid.startsWith("flowchart LR") && d.mermaid.includes("-->"));

const ex = await j("xd_export_artboard", { artboard: "home" });
const btn = ex.node.children.find((n) => n.id === "btn");
const grp = ex.node.children.find((n) => n.id === "grp");
check("export: interactions attached", btn.interactions?.[0]?.destinationName === "Detail");
check("export: stack info", grp.stack?.direction === "vertical");
const det = await j("xd_export_artboard", { artboard: "detail" });
check("export: top-level coords are artboard-relative", det.node.children[0].x === 5 && det.node.children[0].text.baselineY === 5);

const ov = JSON.parse((await call("xd_project_overview", { folder: dir })).t);
check("project overview lists the file", ov.count === 1 && ov.files[0].artboards === 2 && ov.files[0].hasInteractions);
check("project overview outside roots rejected", (await call("xd_project_overview", { folder: path.join(dir, "..") })).err === true);

await client.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
