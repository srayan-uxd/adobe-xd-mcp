# Adobe XD MCP

[![CI](https://github.com/srayan-uxd/adobe-xd-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/srayan-uxd/adobe-xd-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Let your AI assistant **read Adobe XD (`.xd`) files**: screens, layers, text, colors, fonts, prototype links, images, and more.

It's a small [MCP](https://modelcontextprotocol.io) server. It runs **on your own computer**, only **reads** your files, and can only open the folders **you** allow. The server itself never connects to the internet.

> **Good to know:** whatever your AI reads from a file (for example a screen's text) becomes part of your chat with that AI, just like anything you type. Don't point it at designs you can't share with your AI provider.

Try asking: *"List the screens in my XD file"*, *"What colors and fonts does this design use?"*, *"Build the Home screen as React + Tailwind."*

**Mac:** [Jump to the step-by-step guide](#mac-step-by-step)

**Windows:** [Jump to the step-by-step guide](#windows-step-by-step)

---

## What can I do with it?

- **Design to code:** "Build the Home screen as React + Tailwind, using the file's real colors and fonts."
- **XD to Figma:** "Recreate the Login screen in Figma." ([details](#xd-to-figma-and-other-design-tools))
- **Design system in minutes:** "Give me this file's colors, type scale and shadows as Tailwind config / CSS variables."
- **Auto layout, by default:** "Recreate the Login screen in Figma." The result is one auto-layout frame, not a pile of grouped vectors.
- **Look at it:** "Render the Home screen so I can compare it with what you built."
- **Design QA:** "Audit this file for contrast, tiny text and small tap targets."
- **Copy and translation:** "Export all the text as CSV." Find placeholder text, or every use of a word.
- **Docs:** "Draw the prototype flow as a diagram and write a screen inventory."
- **Search:** "Which screens use the color `#0033a0`?"
- **Many files:** "Summarize every XD file in this folder."

Some MCP apps also show three ready-made prompts: `xd-to-figma`, `xd-to-code` and `xd-design-review`.

---

## All the tools

You don't call these yourself. Your AI picks the right one. This is what's available:

| Tool | What it does |
|---|---|
| `xd_list_artboards` | Lists every screen (artboard) with its name and id |
| `xd_get_artboard` | Layer tree of one screen: position, size, fills, strokes, radius, text, fonts |
| `xd_extract_text` | All text from one screen, or the whole file |
| `xd_get_design_tokens` | Colors and fonts used across the file, most-used first |
| `xd_get_design_system` | The design system **actually used** in the file: colors, type styles and size scale, radii, stroke widths, shadows. As JSON, **CSS variables**, a **Tailwind theme**, or **Figma variables** (collections, text styles named by role, effect styles) |
| `xd_audit_design` | Design QA: text contrast (WCAG), tiny text, small tap targets, placeholder text, near-duplicate colors, too many fonts, default layer names |
| `xd_find_layers` | Search the whole file by text, layer name, type or color |
| `xd_export_copy` | All the text as JSON or CSV (a copy deck for translation or review) |
| `xd_get_flow` | Prototype flow map: taps, hovers, transitions, destinations, plus a Mermaid diagram |
| `xd_get_interactions` | The raw prototype interactions stored in the file |
| `xd_export_artboard` | **Full-fidelity export** of a screen (or one layer) as clean JSON: frames, shapes, vector paths, text, fills, gradients, images, strokes, shadows, transforms, constraints, stacks, interactions. Linked components are resolved, big screens are paged, nothing is silently cut. Built for rebuilding designs in other tools ([XD to Figma](#xd-to-figma-and-other-design-tools)) |
| `xd_render_artboard` | **See the screen**: renders an artboard (or one layer) to a PNG using a local Chrome or Edge. Handy to check a rebuild against the original |
| `xd_infer_layout` | **Auto-layout proposal** from the exact export: cards, rows and columns, spacing, padding, buttons, **illustrations and icons kept as single units** (including loose pieces that were never grouped in XD), and a drift report showing how far the result moves things |
| `xd_export_svg` | Exports any layers (a group, or the pieces of a drawing) as **ONE self-contained SVG**, so an illustration or icon can be imported into Figma as a single vector |
| `xd_font_report` | Fonts used, whether they are installed on this computer, substitutions for missing weights, and a licence note |
| `xd_list_components` / `xd_export_component` | List reusable components (with usage counts and descriptions) and export one, including its states (hover etc.) as variants |
| `xd_ping` | Health check: version, allowed folders, browser found, and a built-in self-test |
| `xd_get_shared_assets` | Saved color swatches, library colors and text styles |
| `xd_get_preview` | The preview image saved inside the file |
| `xd_extract_assets` | Saves embedded images to a folder (inside your allowed folders) |
| `xd_project_overview` | Summarizes every `.xd` file in a folder |
| `xd_list_entries` / `xd_read_raw` | Advanced: look inside the raw `.xd` archive |

---

## XD to Figma (and other design tools)

Use this server together with the official Figma MCP server (set that up from Figma's help center) in an AI tool that supports several MCP servers (Claude, Cursor, Codex, ...). This server **reads** the XD file, the Figma server **writes** into Figma, and the AI connects the two.

**The default result is ONE auto-layout Figma frame** that looks as close to the XD original as possible: real, editable text, repeated items as components, illustrations and photos kept as they are, and semantic layer names. Small spacing differences (a few pixels) are fine; looks, hierarchy, colours, fonts and shadows should match. You don't have to ask for auto layout, and you don't get a second "exact copy" version (the exact export is only a temporary source for illustrations). If you really want a pixel-exact, non-auto-layout copy, say so.

**The recommended workflow** (you can paste this to your AI):

1. `xd_list_artboards`, then pick one screen. A 60-screen file is a lot of work, so go screen by screen.
2. `xd_font_report`: warn about fonts that aren't installed before building anything.
3. `xd_get_design_system` with format `figma-variables`: create variables, text styles and effect styles first.
4. `xd_list_components`: create components for repeated items, then use instances.
5. `xd_render_artboard`: look at the original so you know what you are aiming for.
6. `xd_export_artboard` (with `assetsDir` for images): the exact layer data, used for text styles and as the source for illustrations and photos.
7. `xd_infer_layout`: the auto-layout structure (cards, rows, columns, spacing, padding, sizing). Build the page from it. Illustrations and icons arrive as single fixed leaves: import each one with `xd_export_svg` (pass the leaf's `ref`, or its `parts` for a merged drawing) and place it inline or absolutely inside its card. Photos are cloned from the exact export through the `ref`.
8. `xd_render_artboard` again and compare it with your Figma result. Fix anything that looks different, name layers semantically (`suggestedName`), and remove temporary helper layers.

Example prompts:

- *"Recreate the 'Login' screen from `C:/Designs/app.xd` in my Figma file. Save images to `C:/Designs/_assets`."*
- *"Compare it with the original and fix what looks different. List anything you couldn't reproduce."*

**What's handled:** linked components (resolved to their real content), masks, text (top-left box, baseline, line breaks, alignment, auto-resize, partly underlined or mixed-style text), the full transform matrix (rotation and flips pivot about the layer's top-left), vector paths in local coordinates, solid, gradient and image fills, strokes, shadows, opacity, constraints, XD **stacks**, scroll settings, component states as variants, and **prototype interactions** on the layer they belong to.

**Big screens are paged.** If the JSON is large, the result comes in pages (`page`, `pageCount`, `hasMore`). Each page holds whole top-level layers, and nothing is ever cut silently (`truncated` is `false` unless *you* ask for a smaller `depth`). To go deeper into one big layer, pass its `nodeId`.

**About `xd_infer_layout`:** it is a heuristic proposal, not magic. It groups layers into cards by containment, finds rows and columns, measures spacing and padding (rounded to a 4px grid), keeps drawings and photos as fixed layers, and marks overlapping decorations as absolute. Where auto layout would move something by more than `maxDrift` pixels (default 10), that layer keeps its exact position instead. Lower `maxDrift` (for example to 5) for stricter positions with less auto layout; raise it for more auto layout with more drift. The `quality` block tells you what you got.

**How illustrations and icons are grouped:** a group with more than 20 vector parts (and no text) is kept as ONE illustration, and a small group (up to 64 px, no text) as ONE icon. Groups with photos, masks or rotations stay as single fixed units, and any text inside them is listed on the leaf (`textLayers`), so nothing is lost. Many XD files also contain drawings whose parts were never grouped: overlapping or touching free-form paths are merged into one illustration, listed in `parts`. Clusters made only of circles, rectangles and lines (a stepper, a progress bar) are left alone so they stay editable. The thresholds are adjustable (`illustrationMinParts`, `iconMaxSize`, `mergeLoose`, `looseMinParts`); the `grouping` block in the result says what was merged. This is a heuristic: check the result with `xd_render_artboard`.

**What doesn't carry over:** stack padding, "live" repeat grids (they come as their repeated layers plus the grid settings), text in rotated layers, and exact widths of single-line text (XD doesn't store them; they are estimated and flagged `widthApprox`). Treat the result as a strong head start and check it with `xd_render_artboard`.

**Fonts:** `xd_font_report` only reads font *names*. This tool never creates, edits or uploads fonts. If a weight is missing, use the substitution table it gives you (for example Medium to Regular) instead of generating one, and check each font's licence before uploading it to another tool.

---

## Safety

- **Local only.** The server makes no network calls and uploads nothing. (Your AI app still receives whatever the server returns, see the note at the top.)
- **Folder allow-list.** Files outside `XD_MCP_ROOTS` are refused, including sneaky paths (`..`, shortcuts/symlinks). If you don't set it, only the folder the app starts the server in is allowed, which can be a surprising place, so always set it.
- **Only `.xd` files** can be opened, and network paths (`\\server\share`) are blocked.
- **Booby-trapped files:** hard limits on file, entry and total size stop "zip bombs" from using up your memory.
- **Rendering stays on your computer.** `xd_render_artboard` starts your own Chrome or Edge in headless mode with networking switched off, on a temporary file that is deleted afterwards. It needs a browser installed (set `XD_MCP_CHROME` to its path if it isn't found).
- **Only trusted files.** Text inside a design is passed to your AI, and a malicious file could try to give the AI instructions. Open files from people you trust.

Details and how to report a problem privately: [SECURITY.md](SECURITY.md).

---

## Known limits

- XD's file format is closed and undocumented. This is built from files seen in practice, so unusual files may show gaps. [Open an issue](https://github.com/srayan-uxd/adobe-xd-mcp/issues) (without sharing private designs).
- The audit's contrast check **estimates** the background from the shapes behind the text (and skips text over pictures). Treat results as leads, not verdicts. Positions of rotated layers are approximate.
- Components are exported with their ids, usage counts and states, and repeat grids as their layers plus grid settings. Neither is rebuilt as a "live" object.
- `xd_render_artboard` is an approximation of how XD draws: "inside" and "outside" strokes, blend modes and fonts that aren't installed can look slightly different.
- Only drop shadows are mapped for effects; other effects are passed through raw. Gradients are passed through with colors converted to hex (not yet checked against many real files).
- Read-only. It can't edit or create `.xd` files.

---

## Quick start (3 steps)

**You need:** [Node.js](https://nodejs.org) 18 or newer (the "LTS" download) and [Git](https://git-scm.com). Check with `node -v` and `git --version`.

**Step 1. Pick the folder that holds your `.xd` files.**
For example `C:/Designs` (Windows) or `/Users/you/Designs` (Mac/Linux). The server can **only** read inside this folder. That's a safety feature, so always set it.

**Step 2. Add the server to your AI tool.** Find your tool in [Setup for each tool](#setup-for-each-tool), copy the setting, and replace the folder with yours.

**Step 3. Restart the tool and ask.** For example:
*"Use the adobe-xd tool to list the artboards in `C:/Designs/app.xd`."*

---

## Mac: step-by-step

This guide is for designers who have never used a terminal. It takes about 15 minutes and uses the **Claude desktop app**. Other AI tools work too (see [Setup for each tool](#setup-for-each-tool)).

> **Honest note:** the server is written to run on macOS, Windows and Linux, but so far it has only been tested on Windows. If something doesn't work on your Mac, please [open an issue](https://github.com/srayan-uxd/adobe-xd-mcp/issues) (without attaching private designs). You'd be helping a lot.

**What you need:** a Mac, a Claude account, a Figma account (only if you want to rebuild screens in Figma), and your `.xd` files.

### 1. Install Node.js
Go to [nodejs.org](https://nodejs.org), download the **LTS** version for macOS, and double-click the installer.

### 2. Install Git
Open **Terminal** (press `Cmd + Space`, type `Terminal`, press Return). Type this and press Return:

```bash
git --version
```

If a pop-up offers to install the developer tools, click **Install** and wait for it to finish.

### 3. Put your XD files in one folder
For example a folder called `XD` inside `Documents`. The server can only read the folder you give it.

**Get the folder's full path:** in Finder, right-click the folder, hold the `Option` key, and choose **Copy "XD" as Pathname**. It looks like `/Users/yourname/Documents/XD`.

### 4. Install the Claude desktop app
Download it from [claude.ai](https://claude.ai/download) and sign in.

### 5. Connect the server to Claude
In Claude, open **Settings → Developer → Edit Config**. A file called `claude_desktop_config.json` opens. Paste this into it (if the file already has content, add the `"adobe-xd"` part inside the existing `mcpServers`), and **replace the folder path with yours**:

```json
{
  "mcpServers": {
    "adobe-xd": {
      "command": "npx",
      "args": ["-y", "github:srayan-uxd/adobe-xd-mcp#v0.4.0"],
      "env": { "XD_MCP_ROOTS": "/Users/yourname/Documents/XD" }
    }
  }
}
```

`#v0.4.0` pins this tested version. To update later, change it to the newest version on the [Releases page](https://github.com/srayan-uxd/adobe-xd-mcp/releases).

Use the full path. A `~` shortcut does not work here. Then quit Claude completely (`Cmd + Q`) and open it again. The first start can take a minute while the server downloads.

**If Claude can't find `npx`** (common if you installed Node with Homebrew): in Terminal run `which npx`, then put the full path it prints (for example `/opt/homebrew/bin/npx` or `/usr/local/bin/npx`) in place of `"npx"` above.

**If macOS asks** whether Claude may access your Documents (or Desktop, Downloads) folder, click **Allow**.

### 6. Connect Figma (only for XD to Figma)
In Claude, open **Settings → Connectors**, add Figma's official connector, and sign in to Figma. The menu names change between Claude versions, so look for "Connectors" or "Integrations".

### 7. Check that it works
Ask Claude:

> Use the adobe-xd tool to list the screens in /Users/yourname/Documents/XD/myfile.xd.

You can also ask: *"Run xd_ping."* It reports the version, which folders the tool may read, and whether it can render previews.

### 8. Convert a screen to Figma
Ask Claude:

> Recreate the "Login" screen from that XD file in my Figma file. Keep the fonts, colours and images the same.

It builds the screen with **auto layout** by default, so you don't need to ask for it. Do one screen at a time. If something looks different from the original, ask: *"Compare it with the original and fix what looks different."*

### Good to know on a Mac
- **Screen previews** (`xd_render_artboard`) need Google Chrome, Microsoft Edge or Chromium in your Applications folder. They are found automatically.
- **Fonts:** if the fonts used in your XD file aren't installed, the text will change. Ask: *"Run xd_font_report"* to see which are missing.
- **Privacy:** what the AI reads from your files is shared with your AI provider, like anything you type to it.

---

## Windows: step-by-step

This guide is for designers who have never used a terminal. It takes about 15 minutes and uses the **Claude desktop app**. Other AI tools work too (see [Setup for each tool](#setup-for-each-tool)). Windows is the system this tool was built and tested on.

**What you need:** a Windows 10 or 11 PC, a Claude account, a Figma account (only if you want to rebuild screens in Figma), and your `.xd` files.

### 1. Install Node.js
Go to [nodejs.org](https://nodejs.org), download the **LTS** version for Windows, run the installer, and click **Next** through the steps (the default choices are fine).

### 2. Install Git
Go to [git-scm.com](https://git-scm.com), download **Git for Windows**, run the installer, and click **Next** through the steps (the default choices are fine).

### 3. Put your XD files in one folder
For example a folder called `XD` inside `Documents`. The server can only read the folder you give it.

**Get the folder's full path:** open the folder in File Explorer, click the address bar, and copy what it shows. It looks like `C:/Users/yourname/Documents/XD` (in the settings file below, use forward slashes `/`, or double every backslash).

### 4. Install the Claude desktop app
Download it from [claude.ai](https://claude.ai/download), run the installer, and sign in.

### 5. Connect the server to Claude
In Claude, open **Settings → Developer → Edit Config**. A file called `claude_desktop_config.json` opens. Paste this into it (if the file already has content, add the `"adobe-xd"` part inside the existing `mcpServers`), and **replace the folder path with yours**:

```json
{
  "mcpServers": {
    "adobe-xd": {
      "command": "npx",
      "args": ["-y", "github:srayan-uxd/adobe-xd-mcp#v0.4.0"],
      "env": { "XD_MCP_ROOTS": "C:/Users/yourname/Documents/XD" }
    }
  }
}
```

`#v0.4.0` pins this tested version. To update later, change it to the newest version on the [Releases page](https://github.com/srayan-uxd/adobe-xd-mcp/releases).

Then quit Claude completely and open it again. Closing the window can leave it running in the background, so right-click the Claude icon near the clock (bottom-right of the taskbar) and choose **Quit**. The first start can take a minute while the server downloads.

**If Claude says it can't find `npx`:** use this version of the settings instead:

```json
{
  "mcpServers": {
    "adobe-xd": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "github:srayan-uxd/adobe-xd-mcp#v0.4.0"],
      "env": { "XD_MCP_ROOTS": "C:/Users/yourname/Documents/XD" }
    }
  }
}
```

### 6. Connect Figma (only for XD to Figma)
In Claude, open **Settings → Connectors**, add Figma's official connector, and sign in to Figma. The menu names change between Claude versions, so look for "Connectors" or "Integrations".

### 7. Check that it works
Ask Claude:

> Use the adobe-xd tool to list the screens in C:/Users/yourname/Documents/XD/myfile.xd.

You can also ask: *"Run xd_ping."* It reports the version, which folders the tool may read, and whether it can render previews.

### 8. Convert a screen to Figma
Ask Claude:

> Recreate the "Login" screen from that XD file in my Figma file. Keep the fonts, colours and images the same.

It builds the screen with **auto layout** by default, so you don't need to ask for it. Do one screen at a time. If something looks different from the original, ask: *"Compare it with the original and fix what looks different."*

### Good to know on Windows
- **Screen previews** (`xd_render_artboard`) need Microsoft Edge or Google Chrome. Edge comes with Windows, so this usually works without doing anything.
- **Fonts:** if the fonts used in your XD file aren't installed, the text will change. Ask: *"Run xd_font_report"* to see which are missing.
- **Privacy:** what the AI reads from your files is shared with your AI provider, like anything you type to it.

---

## Setup for each tool

The server command is always the same:

```
npx -y github:srayan-uxd/adobe-xd-mcp#v0.4.0
```

The `#v0.4.0` part pins this exact, tested version, so nothing changes under you. To update later, look at the [Releases page](https://github.com/srayan-uxd/adobe-xd-mcp/releases) and change the version number (for example `#v0.4.0` to a newer one), then restart your AI tool.

The one setting you change is `XD_MCP_ROOTS`, your designs folder. To allow several folders, separate them with `;` on Windows or `:` on Mac/Linux. In JSON files use forward slashes (`C:/Designs`), or double every backslash (`C:\\Designs`).

### Claude Desktop
1. Open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`.
2. Add this, save, and restart Claude:
```json
{
  "mcpServers": {
    "adobe-xd": {
      "command": "npx",
      "args": ["-y", "github:srayan-uxd/adobe-xd-mcp#v0.4.0"],
      "env": { "XD_MCP_ROOTS": "C:/Designs" }
    }
  }
}
```
> **Windows tip:** if it says `npx` isn't found, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "github:srayan-uxd/adobe-xd-mcp#v0.4.0"]`.

### Claude Code
One command:
```bash
claude mcp add adobe-xd -e XD_MCP_ROOTS=/path/to/Designs -- npx -y github:srayan-uxd/adobe-xd-mcp#v0.4.0
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
      "args": ["-y", "github:srayan-uxd/adobe-xd-mcp#v0.4.0"],
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
args = ["-y", "github:srayan-uxd/adobe-xd-mcp#v0.4.0"]
env = { XD_MCP_ROOTS = "C:/Designs" }
```

### Gemini CLI
Edit `~/.gemini/settings.json` and add the same `mcpServers` block as Claude Desktop.

### Cline, Continue, Zed, and other apps
Almost every MCP app uses the same recipe: *command* `npx`, *args* `-y github:srayan-uxd/adobe-xd-mcp#v0.4.0`, and the environment variable `XD_MCP_ROOTS`. Look for "MCP servers" in the app's settings.

### ChatGPT, Replit, Lovable, and other web/cloud tools
These run in the cloud, so they **can't reach files on your computer**, and this server is a local one. Your options:
- Use one of the local tools above to read the XD file, then paste the result (text, colors, layout) into the cloud tool.
- Check whether the tool supports custom *local* (stdio) MCP servers. If it does, use the recipe above.

A hosted (HTTP) mode is not built yet. Contributions are welcome, but a file-reading server on the internet needs real care.

### Alternative: install from source
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

### Something not working?
- **The tool doesn't show up:** restart the app completely, and check that `node -v` prints 18 or higher.
- **"Access denied ... outside the allowed roots":** the file isn't inside your `XD_MCP_ROOTS` folder. Set it to the folder that holds the file.
- **`npx` not found (Windows):** use the `cmd /c` version from the Claude Desktop tip above.
- **Still stuck:** [open an issue](https://github.com/srayan-uxd/adobe-xd-mcp/issues). Please don't attach private designs.

---

## Contributing

Ideas and fixes are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [CHANGELOG](CHANGELOG.md).

```bash
npm install
npm test                              # builds, then runs the smoke, export, render, health, layout, insights and security tests
node test/real.mjs path/to/file.xd    # try the server on a real file (read-only)
```

---

## License

MIT. Not affiliated with or endorsed by Adobe. "Adobe XD" is a trademark of Adobe Inc.
