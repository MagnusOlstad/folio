export type ThemeId = "original" | "light" | "dark" | "editorial";

export type ThemeOption = {
  id: ThemeId;
  label: string;
  description: string;
  colorScheme: "light" | "dark";
  swatches: readonly [string, string, string];
};

export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: "original",
    label: "Original",
    description: "Folio's original earthy dark palette.",
    colorScheme: "dark",
    swatches: ["#161816", "#20231f", "#b7d892"],
  },
  {
    id: "light",
    label: "Light",
    description: "A clear, neutral palette for everyday work.",
    colorScheme: "light",
    swatches: ["#eef1f5", "#ffffff", "#245ea8"],
  },
  {
    id: "dark",
    label: "Dark",
    description: "A restrained charcoal palette with blue accents.",
    colorScheme: "dark",
    swatches: ["#111315", "#1b1e22", "#6ea8fe"],
  },
  {
    id: "editorial",
    label: "Editorial",
    description: "Warm paper, navy ink, and a coral accent.",
    colorScheme: "light",
    swatches: ["#eadfcf", "#fff9ef", "#b7443e"],
  },
];

export function isThemeId(value: unknown): value is ThemeId {
  return THEME_OPTIONS.some((theme) => theme.id === value);
}

export function colorSchemeForTheme(themeId: ThemeId) {
  return THEME_OPTIONS.find((theme) => theme.id === themeId)?.colorScheme ?? "dark";
}
