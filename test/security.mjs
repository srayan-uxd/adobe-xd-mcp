// Adversarial checks against the built server.
import JSZip from "jszip";
import { writeFileSync, mkdtempSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(path.join(tmpdir(), "xdsec-"));
const outside = mkdtempSync(path.join(tmpdir(), "xdout-"));
let fails = 0;
const check = (name, ok) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fails++; };

const mk = async (files) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }); };

// 1. hostile archive: traversal / device / ADS names in resources
const evil = await mk({
  manifest: "{}",
  "resources/../../escape.png": "x",
  "resources/CON": "x",
  "resources/a:stream": "x",
  "resources/ok.png": Buffer.from("89504e470d0a1a0a", "hex"),
});
writeFileSync(path.join(dir, "evil.xd"), evil);

// 2. zip bomb: 100MB of zeros per entry x 12 > 1GB total declared, tiny on disk
const bombFiles = { manifest: "{}" };
const zeros = Buffer.alloc(60 * 1024 * 1024);
for (let n = 0; n < 18; n++) bombFiles[`resources/b${n}`] = zeros;
writeFileSync(path.join(dir, "bomb.xd"), await mk(bombFiles));

// 3. single huge entry over per-entry cap
writeFileSync(path.join(dir, "big.xd"), await mk({ manifest: "{}", "artwork/artboard-1/graphics/graphicContent.agc": Buffer.alloc(70 * 1024 * 1024, 32) }));

// 4. symlink file inside root pointing outside (may need privileges on Windows)
let symOk = true;
try { writeFileSync(path.join(outside, "secret.xd"), await mk({ manifest: "{}" })); symlinkSync(path.join(outside, "secret.xd"), path.join(dir, "link.xd")); } catch { symOk = false; }

const client = new Client({ name: "sec", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: dir } }));
const call = (name, args) => client.callTool({ name, arguments: args });
const txt = (r) => r.content[0].text;

let r = await call("xd_list_artboards", { file: String.raw`\\127.0.0.1\share\a.xd` });
check("UNC path rejected before FS access", r.isError && /UNC/.test(txt(r)));
r = await call("xd_list_artboards", { file: "//evil/share/a.xd" });
check("UNC (forward slashes) rejected", r.isError && /UNC/.test(txt(r)));
r = await call("xd_list_artboards", { file: path.join(dir, "..", "..", "Windows", "x.xd") });
check("traversal read rejected", r.isError);
r = await call("xd_list_artboards", { file: path.join(dir, "evil.xd") + "\0.png" });
check("NUL byte rejected", r.isError);

r = await call("xd_extract_assets", { file: path.join(dir, "evil.xd"), outDir: path.join(dir, "assets") });
const written = existsSync(path.join(dir, "assets")) ? readdirSync(path.join(dir, "assets")) : [];
console.log("  wrote:", written);
check("hostile entry names stay inside outDir", !r.isError && written.every((n) => n.startsWith("asset-")) && !existsSync(path.join(dir, "escape.png")) && !existsSync(path.join(dir, "..", "escape.png")));
r = await call("xd_extract_assets", { file: path.join(dir, "evil.xd"), outDir: path.join(dir, "assets") });
check("re-extract does not overwrite (wx)", r.isError === true);
r = await call("xd_extract_assets", { file: path.join(dir, "evil.xd"), outDir: outside });
check("outDir outside root rejected", r.isError);

r = await call("xd_list_artboards", { file: path.join(dir, "bomb.xd") });
check("zip bomb (total) rejected", r.isError && /too much|too large/i.test(txt(r)));
r = await call("xd_list_artboards", { file: path.join(dir, "big.xd") });
check("oversized entry rejected", r.isError && /too large/i.test(txt(r)));

if (symOk) {
  r = await call("xd_list_artboards", { file: path.join(dir, "link.xd") });
  check("symlink escaping root rejected", r.isError && /Access denied/.test(txt(r)));
} else console.log("SKIP symlink test (no privilege)");

writeFileSync(path.join(dir, "ok.xd"), await mk({ manifest: '{"name":"x"}', "artwork/artboard-1/graphics/graphicContent.agc": "{}" }));
for (const p of ["__proto__", "constructor.constructor", "children.constructor"]) {
  r = await call("xd_read_raw", { file: path.join(dir, "ok.xd"), entry: "manifest", path: p });
  check(`read_raw blocks ${p}`, txt(r) === "undefined");
}
r = await call("xd_read_raw", { file: path.join(dir, "ok.xd"), entry: "../../etc/passwd" });
check("read_raw cannot read outside archive", r.isError);
// archive whose headers lie about the size of a 100 MB entry: the real output must be capped
{
  const z = new JSZip();
  z.file("manifest", "{}");
  z.file("artwork/artboard-1/graphics/graphicContent.agc", Buffer.alloc(100 * 1024 * 1024, 32));
  const buf = await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  for (let i = 0; i < buf.length - 46; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50 && buf.readUInt32LE(i + 24) > 1000) buf.writeUInt32LE(1000, i + 24);
    if (buf.readUInt32LE(i) === 0x04034b50 && buf.readUInt32LE(i + 22) > 1000) buf.writeUInt32LE(1000, i + 22);
  }
  writeFileSync(path.join(dir, "lie.xd"), buf);
  r = await call("xd_read_raw", { file: path.join(dir, "lie.xd"), entry: "artwork/artboard-1/graphics/graphicContent.agc", maxChars: 100 });
  check("zip with falsified header sizes is capped while inflating", r.isError && /too large/i.test(txt(r)));
}

// hostile corner radius must not reach the CSS output
{
  const hostile = "4px; } body { background:url(//evil/x) } :root { --x:";
  const z = new JSZip();
  z.file("manifest", "{}");
  z.file("artwork/artboard-1/graphics/graphicContent.agc", JSON.stringify({ children: [{ type: "artboard", id: "1", artboard: { ref: "r", children: [{ id: "r", type: "shape", transform: { tx: 0, ty: 0 }, shape: { type: "rect", x: 0, y: 0, width: 5, height: 5, r: hostile }, style: { fill: { type: "solid", color: { mode: "RGB", value: { r: 1, g: 2, b: 3 } } }, stroke: { type: "solid", width: hostile, color: { mode: "RGB", value: { r: 1, g: 2, b: 3 } } } } }] } }] }));
  writeFileSync(path.join(dir, "css.xd"), await z.generateAsync({ type: "nodebuffer" }));
  r = await call("xd_get_design_system", { file: path.join(dir, "css.xd"), format: "css" });
  check("CSS output contains only numeric token values", !r.isError && !/evil|body|url/.test(txt(r)) && /^:root \{/.test(txt(r)));
}

// new tools obey the same folder rules
for (const [tool, extra] of [["xd_font_report", {}], ["xd_infer_layout", { artboard: "x" }], ["xd_render_artboard", { artboard: "x" }], ["xd_export_artboard", { artboard: "x" }]]) {
  r = await call(tool, { file: path.join(dir, "..", "x.xd"), ...extra });
  check(`${tool} refuses files outside the roots`, r.isError && /outside the allowed roots/.test(txt(r)));
}

// a gigantic artboard must not be handed to the browser
{
  const z = new JSZip();
  z.file("manifest", "{}");
  z.file("artwork/artboard-1/graphics/graphicContent.agc", JSON.stringify({ children: [{ type: "artboard", id: "1", artboard: { ref: "r", children: [] } }] }));
  z.file("resources/graphics/graphicContent.agc", JSON.stringify({ artboards: { r: { x: 0, y: 0, width: 40000, height: 40000 } }, resources: { meta: { ux: { symbols: [] } } } }));
  writeFileSync(path.join(dir, "huge.xd"), await z.generateAsync({ type: "nodebuffer" }));
  r = await call("xd_render_artboard", { file: path.join(dir, "huge.xd"), artboard: "artboard-1" });
  check("huge artboards are refused before rendering", r.isError && (/too large/.test(txt(r)) || /No Chrome or Edge/.test(txt(r))));
}

r = await call("xd_export_artboard", { file: path.join(dir, "ok.xd"), artboard: "artboard-1", assetsDir: outside });
check("export assetsDir outside root rejected", r.isError && /Access denied/.test(txt(r)));
await client.close();

// roots misconfiguration: filesystem root refused
const c2 = new Client({ name: "sec2", version: "0" });
await c2.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, XD_MCP_ROOTS: path.parse(dir).root } }));
r = await c2.callTool({ name: "xd_list_artboards", arguments: { file: path.join(dir, "ok.xd") } });
check("drive root as allowed root refused", r.isError && /root/i.test(txt(r)));
await c2.close();

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
