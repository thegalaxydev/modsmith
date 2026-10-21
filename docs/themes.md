# Themes

Settings → Appearance chooses two themes:

- The **application theme** colors the workbench: rail, toolbar, file tree, tabs, menus, dialogs, inputs, buttons, tooltips, notifications, the status bar and the output panels.
- The **code theme** colors the editor: syntax, semantic colors, selection, current line, line numbers, search matches, bracket matching, diagnostics, and the completion and hover popups.

**Match application to code theme** colors the whole app from the code theme's workbench colors.

Clicking a theme previews it at once. Open files, unsaved edits, cursors and scroll positions are kept, because a preview only changes CSS variables and stylesheets. **Apply** keeps the preview, and **Cancel preview** (or closing Settings) restores the saved themes.

## Built-in themes

| Theme | Kind |
| --- | --- |
| Modsmith Dark (default) | Dark |
| Modsmith Light | Light |
| Modsmith High Contrast | High contrast dark |
| One Dark | Dark. Colors from `@codemirror/theme-one-dark` (MIT), based on the One Dark theme for Atom and VS Code |

Built-in themes cannot be removed.

## Importing VS Code themes

**Import Theme…** accepts:

- A VS Code color theme file (`.json` or `.jsonc`).
- A theme extension package (`.vsix`). If the package contributes several themes, you choose which ones to import.

Files are read, never run:

- JSONC comments and trailing commas are accepted.
- `include` chains are followed, with the included theme merged first, as VS Code does. Includes must be relative and must stay inside the theme's folder or the extension, and cycles are reported.
- `tokenColors` may be an array or a path to a JSON file. `.tmTheme` token files are not supported and produce a warning.
- For a `.vsix`, only `extension/package.json` (`contributes.themes`) and the theme files are read. Archive paths are checked for traversal, and the package has size and file-count limits (100 MB package, 20,000 entries, 300 MB unpacked, 5 MB per theme file).

Imported themes are copied to `<data>/themes/<id>/`: a normalized `theme.json` plus the source files it used. Importing the same theme again updates it in place.

- Ids are `publisher.extension.label` for extensions and `file.<name>` for theme files.
- The selection is stored with the other interface settings, in the renderer's local storage. The selected imported themes are also cached there, so they apply before the service has started.
- Removing a theme that is in use switches to the built-in theme of the same kind.

The service methods are `theme.inspect`, `theme.install`, `theme.list` and `theme.remove`. They are UI-only and not exposed over MCP. They take local paths; a remote catalog can later supply files to the same install path.

## How VS Code colors map

The theme manager (`src/renderer/theme`) turns every theme into the same normalized form. Each value falls back to the theme's own background and foreground, then to the defaults for its kind (dark, light, high contrast dark, high contrast light). A theme that leaves values out never shows colors from the previously applied theme.

- **Workbench colors** become app variables, for example:
  - `editor.background` → workspace
  - `sideBar.background` → panels
  - `activityBar.background` → rail
  - `statusBar.*` → status bar
  - `tab.*` → tabs
  - `button.*` and `focusBorder` → accent
  - `list.*` → selection and hover
  - `editorError/Warning/Info.foreground` → status colors
- **Editor colors** (`editor.*`, `editorLineNumber.*`, `editorCursor.*`, `editorSuggestWidget.*`, `editorHoverWidget.*`, `editorBracketMatch.*`) style the editor directly.
- **Token colors** are matched to Modsmith's highlighting categories (comment, string, keyword, control keyword, storage, type, function, variable, property, annotation and others). Each category is matched by representative TextMate scopes, using VS Code's rule: the most specific prefix wins, then the later rule. Foreground and font style are resolved separately.
- **Semantic colors** (`semanticTokenColors`, plus the standard fallback from semantic types to TextMate scopes) apply to Java while jdtls runs. They are used only when the theme sets `semanticHighlighting: true`, which matches VS Code's default.

## Not supported

- Exact TextMate highlighting. Modsmith highlights with CodeMirror's Lezer grammars, so colors that depend on grammar-specific scopes are approximated.
- Rules with parent scopes (`meta.class entity.name.type`) or exclusions (`- string`), which are skipped. Token `background` colors are also ignored.
- Workbench colors with no Modsmith equivalent, such as the terminal, minimap, diff editor, git decorations, breadcrumbs and bracket pair colors. The theme details list how many were ignored.
- Semantic colors for languages other than Java, language-qualified selectors for other languages, and semantic token deltas or ranges.
- `.tmTheme` token color files, icon themes, product icon themes and fonts.
- Theme extensions' code, which is never run.
- User overrides such as `workbench.colorCustomizations` and `editor.tokenColorCustomizations`.
- Browsing or downloading themes from a marketplace.
