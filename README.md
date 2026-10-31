# Adobe XD MCP

Let your AI assistant **read Adobe XD (`.xd`) files**: artboards, layers, text, colors, fonts, preview images and assets.

It's a small [MCP](https://modelcontextprotocol.io) server. It runs **on your own computer**, only **reads** your files, and can only see the folders **you** allow. Nothing is uploaded anywhere.

> Ask things like: *"List the screens in my XD file"*, *"Extract all the text from the Login screen"*, *"What colors and fonts does this design use?"*, *"Build the Home screen as React + Tailwind."*

---

## What it can do

| Tool | What it does |
|---|---|
| `xd_list_artboards` | Lists every screen (artboard) with its name and id |
| `xd_get_artboard` | Layer tree of one screen: position, size, fills, strokes, radius, text, fonts |
| `xd_extract_text` | All text from one screen, or the whole file |
| `xd_get_design_tokens` | Colors and fonts used across the file, most-used first |
| `xd_get_interactions` | Prototype links, if the file has them |
| `xd_get_preview` | The preview image saved inside the file |
| `xd_extract_assets` | Saves embedded images to a folder |
| `xd_export_artboard` | **Full-fidelity export** of a screen (or one layer) as clean JSON: frames, shapes, vector paths, text, fills, gradients, images, strokes, shadows, rotation, constraints, components. Built for rebuilding designs in other tools. See [XD to Figma](#xd-to-figma-and-other-design-tools) |
| `xd_list_components` / `xd_export_component` | List and export reusable components (symbols) |
| `xd_get_shared_assets` | Saved color swatches, library colors and text styles |
| `xd_get_design_system` | The design system **actually used** in the file: colors (ranked), type styles and size scale, radii, stroke widths, shadows. Output as JSON, **CSS variables** or a **Tailwind theme** |
| `xd_audit_design` | Design QA: text contrast (WCAG), tiny text, small tap targets, placeholder text, near-duplicate colors, too many fonts, default layer names |
| `xd_find_layers` | Search the whole file by text, layer name, type or color |
| `xd_export_copy` | All the text as JSON or CSV (a copy deck for translation or review) |
| `xd_get_flow` | Prototype flow map: taps, hovers, transitions, destinations, plus a Mermaid diagram |
| `xd_project_overview` | Summarize every `.xd` file in a folder |
| `xd_list_entries` / `xd_read_raw` | Advanced: look inside the raw `.xd` archive |

## What can I do with it?

- **Design to code:** "Build the Home screen as React + Tailwind, using the file's real colors and fonts."
- **XD to Figma:** "Recreate the Login screen in Figma." ([details](#xd-to-figma-and-other-design-tools))
- **Design system in minutes:** "Give me this file's colors, type scale and shadows as Tailwind config / CSS variables."
- **Design QA:** "Audit this file for contrast, tiny text and small tap targets."
- **Copy and translation:** "Export all the text as CSV." Find placeholder text, or every use of a word.
- **Docs:** "Draw the prototype flow as a diagram and write a screen inventory."
- **Search:** "Which screens use the color `#0033a0`?"
- **Many files:** "Summarize every XD file in this folder."

Some MCP apps also show three ready-made prompts (`xd-to-figma`, `xd-to-code`, `xd-design-review`).

---

## Quick start (3 steps)

**You need:** [Node.js](https://nodejs.org) version 18 or newer (download the "LTS" one), and [Git](https://git-scm.com).

### Step 1: Pick the folder with your `.xd` files
Example: `C:/Designs` (Windows) or `/Users/you/Designs` (Mac/Linux). The server will **only** be able to read inside this folder. This is a safety feature.

### Step 2: Add the server to your AI tool
Find your tool below and copy the setting. Replace the folder path with yours.

### Step 3: Restart the tool and ask it about your design
Try: *"Use the adobe-xd tool to list the artboards in `C:/Designs/app.xd`."*

---

## Setup for each tool

The server command is always the same:

```
npx -y github:srayan-uxd/adobe-xd-mcp
```

and the one setting you change is `XD_MCP_ROOTS` (your designs folder). To allow more than one folder, separate them with `;` on Windows or `:` on Mac/Linux.

### Claude Desktop
1. Open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`.
2. Add this, save, and restart Claude:
```json
{
  "mcpServers": {
    "adobe-xd": {
      "command": "npx",
      "args": ["-y", "github:srayan-uxd/adobe-xd-mcp"],
      "env": { "XD_MCP_ROOTS": "C:/Designs" }
    }
  }
}
```
> **Windows tip:** if it says `npx` isn't found, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "github:srayan-uxd/adobe-xd-mcp"]`.

### Claude Code
One command:
```bash
claude mcp add adobe-xd -e XD_MCP_ROOTS=/path/to/Designs -- npx -y github:srayan-uxd/adobe-xd-mcp
```

### Cursor
1. Open **Settings → MCP → Add new MCP server** (or edit `~/.cursor/mcp.json`).
2. Paste the same JSON as Claude Desktop above.

### VS Code (GitHub Copilot)
Create `.vscode/mcp.json` in your project:
```json
{
  "servers": {
    "adobe-xd": {
      "command": "npx",
      "args": ["-y", "github:srayan-uxd/adobe-xd-mcp"],
      "env": { "XD_MCP_ROOTS": "C:/Designs" }
    }
  }
}
```

### Windsurf
Open **Settings → Cascade → MCP Servers → View raw config** (`~/.codeium/windsurf/mcp_config.json`) and paste the Claude Desktop JSON.

### OpenAI Codex (CLI)
Edit `~/.codex/config.toml`:
```toml
[mcp_servers.adobe-xd]
command = "npx"
args = ["-y", "github:srayan-uxd/adobe-xd-mcp"]
env = { XD_MCP_ROOTS = "C:/Designs" }
```

### Gemini CLI
Edit `~/.gemini/settings.json` and add the same `mcpServers` block as Claude Desktop.

### Cline, Continue, Zed, and other apps
Almost every MCP-capable app uses the same recipe: *command* `npx`, *args* `-y github:srayan-uxd/adobe-xd-mcp`, and the environment variable `XD_MCP_ROOTS`. Look for "MCP servers" in the app's settings.

### ChatGPT, Replit, Lovable, and other web/cloud tools
These run in the cloud, so they **can't reach files on your computer**, and this server is a local one. Your options:
- Use a local tool above (Claude, Cursor, Codex, Gemini CLI, ...) to read the XD file, then paste the result (text, colors, layout) into the cloud tool.
- Ask the tool whether it supports custom *local/stdio* MCP servers; if it does, use the recipe above.

Hosted (HTTP) support is not built in yet. Contributions are welcome. Note that exposing a file-reading server to the internet needs real care.

---

## XD to Figma (and other design tools)

You can use this server together with the official Figma MCP server (set it up from Figma's help center) in an AI tool that supports several MCP servers (Claude, Cursor, Codex, ...). This server **reads** the XD file; the Figma server **writes** into Figma; the AI connects them.

Try prompts like:

1. *"List the artboards in `C:/Designs/app.xd`."*
2. *"Export the 'Login' artboard with `xd_export_artboard`, saving images to `C:/Designs/_assets`, and recreate it in my Figma file."*
3. *"First create Figma components from `xd_list_components`, then use them in the screens."*

Tips for big files:
- **One screen at a time.** A 60-screen file is a lot of work for an AI, so go screen by screen.
- **Big screen?** Export a smaller part with `nodeId` (the ids are in the export), or lower `depth`.
- **Images:** pass `assetsDir` so the exported images are saved as files, and each image fill points to its file by `imageRef`.

What carries over well: frames, rectangles with corner radius, ellipses, lines, vector paths (SVG path data), text with font, size and mixed styles, solid/gradient/image fills, strokes, shadows, opacity, rotation, constraints, and component/instance info.

Also included: XD **stacks** (direction and the gap after each child), scroll settings, and **prototype interactions** attached to the layer they belong to (trigger, destination screen, transition, duration, easing).

What doesn't: padding of stacks, repeat grids are exported as their repeated layers with the grid settings attached, and exact bounds for rotated layers and vector paths (flagged as `boundsApprox`). Treat this as a strong head start, not a pixel-perfect converter, and check the result against the preview image (`xd_get_preview`).

---

## Alternative install: from source

If `npx` gives you trouble:
```bash
git clone https://github.com/srayan-uxd/adobe-xd-mcp.git
cd adobe-xd-mcp
npm install
npm run build
```
Then use `node` as the command and the full path to `dist/index.js` as the argument:
```json
{
  "mcpServers": {
    "adobe-xd": {
      "command": "node",
      "args": ["/full/path/to/adobe-xd-mcp/dist/index.js"],
      "env": { "XD_MCP_ROOTS": "C:/Designs" }
    }
  }
}
```

---

## Safety

- **Local only.** No network calls, no uploads.
- **Folder allow-list.** Files outside `XD_MCP_ROOTS` are refused (symlinks and `..` tricks included). If you don't set it, only the folder the server starts in is allowed.
- **Only `.xd` files** can be opened. Network paths (`\\server\share`) are blocked.
- **Zip-bomb limits** protect your memory from booby-trapped files.
- **Be careful with files you don't trust.** Text inside a design is passed to your AI, and a malicious file could try to give the AI instructions.

Details and how to report a problem: [SECURITY.md](SECURITY.md).

---

## Known limits

- Built from the XD file format as it appears in current files; XD is closed and undocumented, so unusual files may show gaps. [Open an issue](https://github.com/srayan-uxd/adobe-xd-mcp/issues) (without sharing private designs).
- Design audit contrast checks **estimate** the background from the shapes behind the text (and skip text over pictures), so treat them as leads, not verdicts. Positions of rotated layers are approximate.
- Components are exported with their ids, and repeat grids as their layers plus grid settings; neither is rebuilt as a "live" object.
- Only drop shadows are mapped for effects; other effects are passed through raw. Gradients are passed through with colors converted to hex (not yet verified against many real files).
- Read-only. It can't edit or create `.xd` files.

## Develop

```bash
npm install
npm test          # builds, then runs the smoke + security tests
node test/real.mjs path/to/file.xd   # try the server on a real file
```

## License

MIT. Not affiliated with or endorsed by Adobe. "Adobe XD" is a trademark of Adobe Inc.
