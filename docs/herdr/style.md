# herdr look for Fresh

What the fork copies from herdr's chrome, so the editor reads as part of the same tool. Taken from
herdr 0.9.5 (`herdrdev/herdr` 143bf5f) with its **Tokyo Night** palette, the one the team uses.
Paths in brackets are herdr's.

## Palette (`src/app/state.rs` `Palette::tokyo_night`)

| slot | RGB | used for |
|---|---|---|
| accent / blue | 122,162,247 | focus, active tab, selected row, primary button, popup border |
| panel_bg | 26,27,38 | tab bar, status/mode bar, popups, menus; also the text on an accent fill |
| active_row_bg | 35,38,54 | focused row |
| selection_bg | 45,54,80 | cursor row while navigating, selections |
| surface0 | 36,40,59 | chips: inactive tabs, inputs, secondary buttons |
| surface1 | 65,72,104 | rules inside popups, drag targets |
| overlay0 | 86,95,137 | muted text, unfocused borders, separators |
| overlay1 | 105,113,150 | secondary text, scrollbar thumb |
| text | 192,202,245 | main text |
| subtext0 | 169,177,214 | unfocused names |
| mauve | 187,154,247 | branch names, RESIZE badge |
| green / yellow / red / teal / peach | 158,206,106 / 224,175,104 / 247,118,142 / 125,207,255 / 255,158,100 | idle / working / blocked / done; peach unused in chrome |

## Rules

- **Backgrounds**: content (terminal panes, sidebar) stays on the terminal's own background
  (`Reset`); bars, menus and popups sit on `panel_bg`; small raised things on `surface0`.
- **One accent**: everything focused or selected is `accent`, with `panel_bg` text on it, bold.
- **Borders**: square light box drawing `┌┐└┘│─├┤┬┴┼`, never rounded, never heavy. Focused pane's
  border and title in accent (title bold), others overlay0. Title ` label ` on the top border right
  after the corner. No shadows. [`ui/panes.rs`]
- **Tabs**: one row on `panel_bg`; each tab a chip, label centred, width label+4 (min 8), one
  `panel_bg` column between chips, no separator glyphs, no close buttons. Active: `panel_bg` on
  accent. Inactive: overlay0 on surface0. [`client/shell/tabs.rs`]
- **Status bar**: `panel_bg` row, quiet overlay text; mode as a badge ` NAVIGATE ` (`panel_bg` on
  accent, bold); key hints as accent bold key + overlay0 label, groups two spaces apart.
  [`client/shell/render.rs`]
- **Lists / sidebar**: label with one leading space; focused row on active_row_bg with text bold,
  others subtext0; secondary tokens overlay0 (mauve when focused), separated by ` · `; tree
  connectors `├─ └─ │` in overlay0; state dots `● ○ ·` in the state colours; headers ` name` in
  overlay0 bold; group toggles `▸ ▾` in accent. [`ui/sidebar.rs`]
- **Popups and menus**: square accent border on `panel_bg`; selected row `panel_bg` on accent,
  bold, full width; title in accent on the top border at x+2; a surface1 `─` rule under a search
  line; modal dialogs dim what's behind them. [`client/shell/overlays.rs`]
- **Scrollbars**: track `▕`, thumb `▐` (focused, overlay1 on an overlay0 track) or `▕` (unfocused,
  overlay0 on a near-invisible track). [`ui/scrollbar.rs`]
- **Glyphs**: plain Unicode only, no Nerd Font icons. Truncate with `…`. No italics; bold for focus
  and keys, dim for backdrops and empty states.

## In Fresh

| Fresh | herdr | how |
|---|---|---|
| editor, explorer, terminal background | pane, sidebar | theme `Default` (terminal background) |
| tab bar | tab bar | theme chips + `view/ui/tabs.rs` layout (centred labels, gaps, no ×) |
| status bar | mode bar | theme `panel_bg` + `view/ui/status_bar.rs` segments |
| file explorer | sidebar | `view/ui/file_explorer.rs`: row backgrounds, connectors, muted secondary text |
| menus, popups, pickers, prompts | overlays | theme + square accent borders (`view/popup.rs`, `view/ui/menu.rs`) |
| split borders | pane borders | overlay0, accent at the focused split |
| scrollbars | scrollbars | `▕` / `▐` glyphs in `view/ui/scroll_panel.rs` and split rendering |

The colours are the built-in `herdr` theme (`crates/fresh-editor-core/themes/herdr.json`), the
default. Layout changes are behind `editor.chrome_style: "herdr"` (default `"fresh"` upstream, set by
`herdr-defaults.json`), so Fresh's own layout and tests stay intact. Done so far: tab chips with the
close mark on hover, the status bar's ` · ` separators and accent key hint, the `{mode}` badge
(`EDIT`, `TERMINAL`, `EXPLORER`, `PROMPT`, `NOTEBOOK`, …) at the left of the status bar, the hidden
menu bar, quiet scrollbars, and the explorer as herdr's sidebar (accent border and title when
focused, `▸ ▾` toggles in accent, folder names in plain text, through the `ui.explorer_*` theme
keys), with no italics on the preview tab; the command palette's selected row as panel text on the
accent across all its columns (`ui.suggestion_selected_*`), and its mode hints on a surface0 strip
(`ui.quick_open_hints_*`).

## Feel (decided with the team)

- **No permanent menu bar**: the top row is the tab bar, as in herdr. The menu opens on F10 / Alt
  and in the command palette, drawn as a herdr popup.
- **Tabs are chips**: the close `×` shows only while the pointer is over a tab.
- **Status bar is herdr's mode bar**: a mode badge (accent chip), key hints as accent key + muted
  label, file / position / LSP on the right separated by ` · `, state shown with dots.
- **Keys stay Fresh's**: herdr's prefix key stays herdr's; only the way hints are shown follows herdr.
- **Borders are square everywhere**: rounded `╭╮╰╯` boxes become `┌┐└┘`.
