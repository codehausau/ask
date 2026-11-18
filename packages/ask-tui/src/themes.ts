// @termcn/opentui source-registry themes. See THIRD_PARTY_NOTICES.md.
import { amoledTheme } from "./themes/amoled.ts";
import { auraTheme } from "./themes/aura.ts";
import { ayuTheme } from "./themes/ayu.ts";
import { carbonfoxTheme } from "./themes/carbonfox.ts";
import { catppuccinTheme } from "./themes/catppuccin.ts";
import { catppuccinFrappeTheme } from "./themes/catppuccin-frappe.ts";
import { catppuccinMacchiatoTheme } from "./themes/catppuccin-macchiato.ts";
import { cobalt2Theme } from "./themes/cobalt2.ts";
import { cursorTheme } from "./themes/cursor.ts";
import { defaultTheme } from "./themes/default.ts";
import { draculaTheme } from "./themes/dracula.ts";
import { everforestTheme } from "./themes/everforest.ts";
import { flexokiTheme } from "./themes/flexoki.ts";
import { githubTheme } from "./themes/github.ts";
import { gruvboxTheme } from "./themes/gruvbox.ts";
import { highContrastTheme } from "./themes/high-contrast.ts";
import { highContrastLightTheme } from "./themes/high-contrast-light.ts";
import { kanagawaTheme } from "./themes/kanagawa.ts";
import { lucentOrngTheme } from "./themes/lucent-orng.ts";
import { materialTheme } from "./themes/material.ts";
import { matrixTheme } from "./themes/matrix.ts";
import { mercuryTheme } from "./themes/mercury.ts";
import { monokaiTheme } from "./themes/monokai.ts";
import { nightowlTheme } from "./themes/nightowl.ts";
import { nordTheme } from "./themes/nord.ts";
import { oc2Theme } from "./themes/oc-2.ts";
import { oneDarkTheme } from "./themes/one-dark.ts";
import { onedarkproTheme } from "./themes/onedarkpro.ts";
import { opencodeTheme } from "./themes/opencode.ts";
import { orngTheme } from "./themes/orng.ts";
import { osakaJadeTheme } from "./themes/osaka-jade.ts";
import { palenightTheme } from "./themes/palenight.ts";
import { rosepineTheme } from "./themes/rosepine.ts";
import { shadesofpurpleTheme } from "./themes/shadesofpurple.ts";
import { solarizedTheme } from "./themes/solarized.ts";
import { synthwave84Theme } from "./themes/synthwave84.ts";
import { tokyoNightTheme } from "./themes/tokyo-night.ts";
import { vercelTheme } from "./themes/vercel.ts";
import { vesperTheme } from "./themes/vesper.ts";
import { zenburnTheme } from "./themes/zenburn.ts";
import type { Theme } from "./themes/types.ts";

const themes: Readonly<Record<string, Theme>> = {
  amoled: amoledTheme, aura: auraTheme, ayu: ayuTheme, carbonfox: carbonfoxTheme,
  catppuccin: catppuccinTheme, "catppuccin-frappe": catppuccinFrappeTheme, "catppuccin-macchiato": catppuccinMacchiatoTheme,
  cobalt2: cobalt2Theme, cursor: cursorTheme, default: defaultTheme, dracula: draculaTheme,
  everforest: everforestTheme, flexoki: flexokiTheme, github: githubTheme, gruvbox: gruvboxTheme,
  "high-contrast": highContrastTheme, "high-contrast-light": highContrastLightTheme,
  kanagawa: kanagawaTheme, "lucent-orng": lucentOrngTheme, material: materialTheme,
  matrix: matrixTheme, mercury: mercuryTheme, monokai: monokaiTheme, nightowl: nightowlTheme,
  nord: nordTheme, "oc-2": oc2Theme, "one-dark": oneDarkTheme, onedarkpro: onedarkproTheme,
  opencode: opencodeTheme, orng: orngTheme, "osaka-jade": osakaJadeTheme, palenight: palenightTheme,
  rosepine: rosepineTheme, shadesofpurple: shadesofpurpleTheme, solarized: solarizedTheme,
  synthwave84: synthwave84Theme, "tokyo-night": tokyoNightTheme, vercel: vercelTheme,
  vesper: vesperTheme, zenburn: zenburnTheme,
};

export const ASK_PALETTE = {
  background: "#10151d", panel: "#1b2533", accent: "#82cfff", text: "#e2e8f0",
  muted: "#9baac1", heading: "#f8fafc", summary: "#cbd5e1", border: "#344256",
  code: "#a7f3d0", warning: "#fcd34d", error: "#fda4af",
} as const;
export type ThemeRole = keyof typeof ASK_PALETTE;
export type ThemePalette = Readonly<Record<ThemeRole, string>> & {
  readonly selectionBg?: string;
  readonly selectionFg?: string;
};
export type ThemeMode = "dark" | "light";
/** Built-in names, then custom ones as addCustomTheme registers them. "ask" stays first. */
export const THEME_NAMES: string[] = ["ask", ...Object.keys(themes).sort()];

/** User themes from config directories; they take precedence over built-ins. */
const custom = new Map<string, { palette: ThemePalette; mode: ThemeMode; file: string }>();

export function addCustomTheme(name: string, palette: ThemePalette, mode: ThemeMode, file: string): void {
  custom.set(name, { palette, mode, file });
  if (!THEME_NAMES.includes(name)) {
    THEME_NAMES.push(name);
    THEME_NAMES.splice(1, THEME_NAMES.length - 1, ...THEME_NAMES.slice(1).sort());
  }
}

/** A short description for the theme picker. */
export function themeDescription(name: string): string {
  const entry = custom.get(name);
  if (entry) return `Custom: ${entry.file}`;
  return name === "ask" ? "Original ask colors" : "";
}

/** termcn supplies fixed palettes, not invented light/dark variants. */
export function themeModes(name: string): readonly ThemeMode[] {
  const entry = custom.get(name);
  if (entry) return [entry.mode];
  if (name !== "ask" && !Object.hasOwn(themes, name)) throw new Error(`Unknown theme: ${name}`);
  return name === "high-contrast-light" ? ["light"] : ["dark"];
}

export function themePalette(name: string, mode: ThemeMode = themeModes(name)[0]!): ThemePalette {
  if (!themeModes(name).includes(mode)) throw new Error(`Theme ${name} does not provide a ${mode} variant.`);
  const entry = custom.get(name);
  if (entry) return entry.palette;
  if (name === "ask") return ASK_PALETTE;
  const { colors, border } = themes[name]!;
  return {
    background: colors.background, panel: colors.muted, accent: colors.primary,
    text: colors.foreground, heading: colors.foreground, summary: colors.foreground,
    muted: colors.mutedForeground, border: border.color, code: colors.success,
    warning: colors.warning, error: colors.error,
    selectionBg: colors.selection, selectionFg: colors.selectionForeground,
  };
}
