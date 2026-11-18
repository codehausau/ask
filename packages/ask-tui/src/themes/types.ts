// Theme-only interfaces from @termcn/opentui/ui/types, without React context
// interfaces. See THIRD_PARTY_NOTICES.md. No runtime code or dependency.
export interface ColorTokens {
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  accent: string;
  accentForeground: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  error: string;
  errorForeground: string;
  info: string;
  infoForeground: string;
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  focusRing: string;
  selection: string;
  selectionForeground: string;
}
export interface Theme {
  name: string;
  colors: ColorTokens;
  spacing: { 0: number; 1: number; 2: number; 3: number; 4: number; 6: number; 8: number };
  typography: { bold: boolean; sm: string; base: string; lg: string; xl: string };
  border: { style: "single" | "double" | "rounded" | "heavy"; color: string; focusColor: string };
}
