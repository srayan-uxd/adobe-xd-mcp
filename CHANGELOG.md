# Changelog

## 0.2.0
- **New:** `xd_get_design_system` (JSON / CSS variables / Tailwind), `xd_audit_design`, `xd_find_layers`, `xd_export_copy`, `xd_get_flow` (with Mermaid diagram), `xd_project_overview`.
- **New:** `xd_export_artboard`, `xd_export_component`, `xd_list_components`, `xd_get_shared_assets` for rebuilding designs in Figma and other tools.
- Exports include XD stacks, scrolling and prototype interactions.
- Three MCP prompts: `xd-to-figma`, `xd-to-code`, `xd-design-review`.
- Fixed: top-level layer positions in exports are now relative to their artboard.
- Security: folder allow-list, UNC path blocking, zip-bomb limits, safe asset names (see SECURITY.md); CSV export is protected against formula injection; diagram labels and token names are sanitized.

## 0.1.0
- First release: read artboards, layers, text, colors, fonts, previews and assets from `.xd` files.
