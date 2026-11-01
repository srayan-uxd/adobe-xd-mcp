# Security

## What this server does and doesn't do

- **Read-only.** The only thing it writes is extracted images (`xd_extract_assets`), and only inside a folder you allowed.
- **Sandboxed.** Every file path is checked against the folders in `XD_MCP_ROOTS` (default: the folder the server starts in). Symlinks are resolved first, network paths (`\\host\share`) are rejected before any file access, and only `.xd` files can be opened. A drive root such as `C:\` is refused as an allowed folder.
- **Zip-bomb limits.** 200 MB per file, 20,000 entries, 64 MB per entry, 1 GB expanded.
- **No network access.** The server makes no network calls.
- **Rendering.** `xd_render_artboard` launches your installed Chrome or Edge (headless) on a temporary SVG made of the exported data only: no scripts, all text escaped, all images embedded, name resolution disabled so nothing can be fetched. The file lives in a private temporary folder and is deleted afterwards. The browser path can be set with `XD_MCP_CHROME`, which should be a path you trust.
- **Font report.** It runs a fixed system command to list installed fonts (PowerShell on Windows, `fc-list` where available). It never reads or changes font files.

## Things to keep in mind

- **Prompt injection.** Text inside a design file (layer names, text layers) is returned to your AI assistant. A malicious `.xd` file could contain text that tries to instruct the assistant. Only open files you trust, and keep `XD_MCP_ROOTS` as narrow as you can.
- **Extracted SVGs** can contain scripts. Don't open extracted assets in a browser unless you trust the file.

## Reporting a vulnerability

Please use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Please don't open a public issue for security problems.
