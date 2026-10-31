# Contributing

Thanks for helping! Ideas that would help most: more real-world file coverage, rotated-layer geometry, gradients and blur effects, stack padding, and new tools.

## Setup
```bash
git clone https://github.com/srayan-uxd/adobe-xd-mcp.git
cd adobe-xd-mcp
npm install
npm test
```
`npm test` builds the project and runs the smoke, insights and security tests on generated `.xd` files.

## Try it on a real file
```bash
node test/real.mjs path/to/file.xd
```
This is read-only. **Never attach private design files to issues or pull requests.** If a file breaks something, describe the problem or share only the structure (`xd_list_entries`, or `xd_read_raw` with ids and text removed).

## Guidelines
- Keep it **read-only and sandboxed**: every path from a tool argument must go through `assertInsideRoots`, and new writes must refuse to overwrite files.
- Treat all text from design files as untrusted when it ends up in output (CSV cells, diagram labels, token names).
- Add a test in `test/` for new behavior; security-relevant changes also get a case in `test/security.mjs`.
- Keep the README tool table up to date.

## Reporting security problems
See [SECURITY.md](SECURITY.md). Please don't open public issues for vulnerabilities.
