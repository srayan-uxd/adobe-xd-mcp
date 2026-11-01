// xd_ping and xd_font_report on a synthetic file, plus the weight-substitution helper.
import JSZip from "jszip";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { weightFallbacks, weightNumber } from "../dist/fonts.js";

let fails = 0;
const check = (name, ok) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fails++; };

const fb = weightFallbacks([400, 700, 800]);
check("Medium falls back to Regular, SemiBold to Bold", fb.Medium === "Regular" && fb.SemiBold === "Bold");
check("used weights are never remapped", !("Regular" in fb) && !("Bold" in fb) && fb.Black === "ExtraBold");
check("weight names parse", weightNumber("Heavy") === 800 && weightNumber("Semibold Italic") === 600 && weightNumber("Regular") === 400);

const text = (id, style, size) => ({ id, type: "text", transform: { tx: 0, ty: 20 }, text: { rawText: "x", frame: { type: "positioned" } }, style: { font: { family: "Zzz Imaginary Sans", postscriptName: "ZzzImaginary-" + style, style, size } } });
const zip = new JSZip();
zip.file("manifest", JSON.stringify({ name: "H", children: [{ name: "artwork", path: "artwork", children: [{ name: "One", path: "artboard-one" }] }] }));
zip.file("artwork/artboard-one/graphics/graphicContent.agc", JSON.stringify({ children: [{ type: "artboard", id: "one", artboard: { ref: "r", children: [text("a", "Regular", 12), text("b", "Regular", 14), text("c", "Bold", 12)] } }] }));
zip.file("resources/graphics/graphicContent.agc", JSON.stringify({ artboards: { r: { x: 0, y: 0, width: 100, height: 100 } }, resources: { meta: { ux: { symbols: [] } } } }));
const dir = mkdtempSync(path.join(tmpdir(), "xdh-"));
const xd = path.join(dir, "h.xd");
writeFileSync(xd, await zip.generateAsync({ type: "nodebuffer" }));

const client = new Client({ name: "h", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: dir } }));
const j = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const p = await j("xd_ping", { file: xd });
check("ping reports version, roots and a passing self-test", /^\d+\.\d+\.\d+/.test(p.version) && p.allowedRoots.length === 1 && p.selfTest.passed === true);
check("ping can test-open a file", p.file.ok === true && p.file.artboards === 1 && p.file.firstArtboardExports === true);
const bad = await j("xd_ping", { file: path.join(dir, "..", "nope.xd") });
check("ping refuses files outside the roots (reports, does not throw)", bad.file.ok === false && /outside the allowed roots/.test(bad.file.error));

const r = await j("xd_font_report", { file: xd });
const fam = r.families.find((f) => f.family === "Zzz Imaginary Sans");
check("font report groups styles under the family", fam && fam.styles.length === 2 && fam.totalUses === 3);
check("an unknown font is reported as not installed (or unknown) with a warning when detectable", fam.installed === false ? /not installed/.test(r.warning) : fam.installed === "unknown");
check("fallback table and licence note present", fam.weightFallbacks.Medium === "Regular" && /never synthesise/i.test(fam.licenceNote) && fam.fallbackStack.includes("sans-serif"));

await client.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
