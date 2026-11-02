# Changelog

## 0.3.2
- **Auto layout is now the default** for rebuilding XD screens in Figma. The `xd-to-figma` prompt and the README workflow ask for ONE auto-layout frame (real text, components for repeated items, illustrations kept as they are, semantic layer names) instead of an exact copy plus a second version.
- `xd_infer_layout`: the default `maxDrift` is now 10 px (was 5), so more of a screen ends up in auto-layout frames. Lower it for stricter positions.

## 0.3.1 (security)
- **Fixed (high):** linked-component bombs. A file whose components link to themselves, or fan out (30 links per level, 8 levels), made `xd_export_artboard`, `xd_infer_layout` and `xd_render_artboard` run out of memory and crash the server. Self-links are now cut off (`cyclic: true`), and a 400,000-layer budget stops any other expansion with a clear error.
- **Fixed:** a total cap (200 MB) on image data embedded into one rendered SVG, so a file full of large pictures can't exhaust memory.
- **Fixed:** every loop over lists read from a file now accepts real arrays only. Malformed files produce a clear "unexpected data" error instead of internal exceptions.
- **Fixed:** `xd_infer_layout` crashed on frames whose contents all became absolute; non-string text no longer breaks CSV export.
- Tested with a fuzzer: about 2,000 tool calls on randomly corrupted files, with no crashes, hangs or timeouts. Regression tests added for both bombs.

## 0.3.0
Built from lessons learned rebuilding a real 100+ screen file in Figma.

- **Export fixes** (`xd_export_artboard`, `xd_export_component`):
  - Linked components (`syncRef`) are resolved to their real content, including ones nested in other components and in component states (up to 8 levels). Unresolvable ones are reported, not left empty.
  - Masks are positioned correctly (in the masked group's local space).
  - Text is normalised: top-left `box`, `baselineY`, soft line breaks (vertical tab, line separator) turned into `\n`, `lineHeight`, `alignment`, `autoResize`/`maxWidth`, exact width for right and centre aligned text, and styled runs with underline, colour, size and weight (offsets index into the normalised text).
  - The full transform matrix is always emitted with `transformOrigin: "top-left"`.
  - Paths are emitted as `svgPathLocal` (bounding box at 0,0) plus `localBox`; bounds of curves are exact, `boundsApprox` only when a path uses relative, smooth or arc commands.
  - Big artboards are paged by top-level layer (`page`, `pageCount`, `hasMore`). Depth is never reduced silently; `truncated` is `false` unless you ask for a smaller `depth`.
  - Hidden layers get a `hiddenReason`; component states are exported as `variants`; every export lists the `fonts` it uses; `semanticNames` adds `suggestedName` to layers.
- **New tools:**
  - `xd_render_artboard`: PNG of an artboard or layer, rendered to one SVG and screenshotted in a local headless Chrome or Edge (network disabled, temporary files removed).
  - `xd_infer_layout`: auto-layout proposal with cards, rows and columns, spacing, padding, buttons, fixed illustrations, absolute decorations, suggested names and a drift report. Frames that would drift more than `maxDrift` px keep exact positions.
  - `xd_font_report`: fonts used, installed or not, weight substitution table, licence note. Reads names only.
  - `xd_ping`: version, allowed folders, browser, and a self-test.
- `xd_list_components` now has usage counts, the artboards that use each component, variant counts and a description.
- `xd_get_design_system` has a `figma-variables` format.
- Fixed: font family names in the design system were broken by a bad regular expression; text boxes in the audit and layout now use the real top-left instead of the baseline origin.
- Render safety: temporary files only in a private temp folder, no network, no scripts, all text escaped.

## 0.2.1 (security)
- **Fixed:** decompression bombs with falsified zip header sizes. Entries are now inflated through a hard size cap instead of trusting the headers.
- **Fixed:** CSS injection in `xd_get_design_system` output. Corner radii, stroke widths, shadows and font sizes must now be real numbers.
- Hardened: object-key lookups from file data no longer touch the prototype chain; parsed-JSON cache is bounded; layer depth, layer count and contrast-check work are capped; folder scans skip directory links that leave the allowed roots.
- CI: least-privilege token, actions pinned to commit SHAs. Added Dependabot for npm and Actions.

## 0.2.0
- **New:** `xd_get_design_system` (JSON / CSS variables / Tailwind), `xd_audit_design`, `xd_find_layers`, `xd_export_copy`, `xd_get_flow` (with Mermaid diagram), `xd_project_overview`.
- **New:** `xd_export_artboard`, `xd_export_component`, `xd_list_components`, `xd_get_shared_assets` for rebuilding designs in Figma and other tools.
- Exports include XD stacks, scrolling and prototype interactions.
- Three MCP prompts: `xd-to-figma`, `xd-to-code`, `xd-design-review`.
- Fixed: top-level layer positions in exports are now relative to their artboard.
- Security: folder allow-list, UNC path blocking, zip-bomb limits, safe asset names (see SECURITY.md); CSV export is protected against formula injection; diagram labels and token names are sanitized.

## 0.1.0
- First release: read artboards, layers, text, colors, fonts, previews and assets from `.xd` files.
