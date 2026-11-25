// Custom themes: themes/<name>.json or .jsonc in each config directory.
//
//   { "extends": "nord", "mode": "dark", "accent": "#88c0d0", "panel": "#3b4252" }
//
// Keys are the TUI's colour roles (see ASK_PALETTE). Unset roles come from
// `extends` (a built-in or earlier custom theme), or else from the ask palette.
// Values must be hex colours: a theme can only change colours, never send text
// to the terminal. A later directory's theme replaces an earlier one's.

import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "@codehaus-au/ask/internal/config";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import { addCustomTheme, ASK_PALETTE, themeModes, themePalette, type ThemeMode, type ThemePalette, type ThemeRole } from "./themes.ts";

const MAX_THEME_BYTES = 64 * 1024;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
/** Colour roles a theme file may set; schema/theme.schema.json lists exactly these. */
export const THEME_ROLES: readonly string[] = [...Object.keys(ASK_PALETTE), "selectionBg", "selectionFg"];
const ROLES = new Set<string>(THEME_ROLES);

async function readThemeFile(file: string): Promise<string> {
  // Avoid blocking on a FIFO before we can check the opened file's type.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    const invalid = () => new Error(`${terminalField(file)}: not a regular file of 64 KiB or less`);
    if (!info.isFile() || info.size > MAX_THEME_BYTES) throw invalid();

    // The extra byte detects overflow if the file grows after the size check.
    const buffer = Buffer.alloc(MAX_THEME_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_THEME_BYTES) throw invalid();
    return buffer.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
}

/** Parse and validate one theme file against already-registered themes. */
function parseTheme(file: string, text: string): { palette: ThemePalette; mode: ThemeMode; notes: string[] } {
  const shown = terminalField(file);
  const value = parseJsonc(text, file);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${shown}: a theme must be a JSON object`);
  const notes: string[] = [];
  const raw = value as Record<string, unknown>;
  const base = raw["extends"];
  if (base !== undefined && typeof base !== "string") throw new Error(`${shown}: extends must be a theme name`);
  const mode = raw["mode"] ?? (base ? themeModes(base)[0] : "dark");
  if (mode !== "dark" && mode !== "light") throw new Error(`${shown}: mode must be "dark" or "light"`);
  // themeModes/themePalette throw "Unknown theme" for a bad `extends`.
  const palette: Record<string, string> = { ...(base ? themePalette(base, themeModes(base)[0]) : ASK_PALETTE) };
  for (const [key, color] of Object.entries(raw)) {
    if (key === "extends" || key === "mode" || key === "$schema") continue;
    if (!ROLES.has(key)) { notes.push(`${shown}: unknown colour role ${terminalField(key)} (ignored)`); continue; }
    if (typeof color !== "string" || !COLOR.test(color)) throw new Error(`${shown}: ${key} must be a hex colour such as #88c0d0`);
    palette[key as ThemeRole] = color;
  }
  return { palette: palette as ThemePalette, mode, notes };
}

/** Register every valid theme in `dirs`/themes/, lowest precedence first. Problems become notes. */
export async function loadCustomThemes(dirs: readonly string[]): Promise<{ names: string[]; notes: string[] }> {
  const names: string[] = [];
  const notes: string[] = [];
  for (const dir of dirs) {
    const themesDir = path.join(dir, "themes");
    const entries = await readdir(themesDir).catch(() => [] as string[]);
    const byName = new Map<string, string[]>();
    for (const entry of entries.sort()) {
      const match = /^(.*)\.jsonc?$/.exec(entry);
      if (!match) continue;
      byName.set(match[1]!, [...(byName.get(match[1]!) ?? []), entry]);
    }
    for (const [name, files] of byName) {
      const file = path.join(themesDir, files[0]!);
      if (!NAME.test(name)) { notes.push(`${terminalField(file)}: theme names use letters, digits, ".", "-" and "_" (skipped)`); continue; }
      if (files.length > 1) { notes.push(`${terminalField(themesDir)}: both ${name}.json and ${name}.jsonc exist; keep one (skipped)`); continue; }
      try {
        const theme = parseTheme(file, await readThemeFile(file));
        notes.push(...theme.notes);
        addCustomTheme(name, theme.palette, theme.mode, file);
        names.push(name);
      } catch (error) {
        notes.push(`${error instanceof Error ? error.message : String(error)} (theme ${name} skipped)`);
      }
    }
  }
  return { names, notes };
}
