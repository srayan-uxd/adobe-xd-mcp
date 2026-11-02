// Keeps the docs honest: every install example in the README must be pinned to the current release,
// and the CHANGELOG must have an entry for it. CI fails if a release forgets to update them.
import { readFileSync } from "node:fs";

let fails = 0;
const check = (name, ok, detail = "") => { console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail); if (!ok) fails++; };

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const tag = "v" + pkg.version;
const readme = readFileSync("README.md", "utf8");
const spec = "github:srayan-uxd/adobe-xd-mcp";

let found = 0;
const wrong = [];
for (let i = readme.indexOf(spec); i >= 0; i = readme.indexOf(spec, i + spec.length)) {
  found++;
  const after = readme.slice(i + spec.length, i + spec.length + tag.length + 2);
  const ok = after.startsWith("#" + tag) && !/[0-9.]/.test(after.slice(tag.length + 1, tag.length + 2));
  if (!ok) wrong.push(readme.slice(i, i + spec.length + 12));
}
check("README has install examples", found >= 5, `found ${found}`);
check(`every install example in the README is pinned to ${tag}`, wrong.length === 0, `not pinned to ${tag}: ${wrong.join(" | ")}`);

const changelog = readFileSync("CHANGELOG.md", "utf8");
check(`CHANGELOG has an entry for ${pkg.version}`, changelog.includes("## " + pkg.version));
check("README links to the Releases page for updates", readme.includes("github.com/srayan-uxd/adobe-xd-mcp/releases"));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
