/**
 * Pure fuzzy-matching and sectioning logic for the command palette.
 * No React, no DOM, no side effects — searchable test surface.
 */

export type PaletteSectionId = "recent" | "commands" | "notes";

export type PaletteCommand = {
  id: string;
  label: string;
  description?: string;
  hotkey?: string;
  run: () => void;
};

export type PaletteSection = {
  id: PaletteSectionId;
  heading: string;
  commands: PaletteCommand[];
};

export type PaletteRow = {
  section: PaletteSectionId;
  command: PaletteCommand;
};

const SECTION_HEADINGS: Record<PaletteSectionId, string> = {
  recent: "Recent",
  commands: "Commands",
  notes: "Notes",
};

const WORD_BOUNDARY_BEFORE = new Set([
  " ",
  "-",
  "_",
  "/",
  ".",
  ":",
  "+",
  "(",
  ")",
]);

const MATCH_SCORE_BASE = 14;
const WORD_START_BONUS = 10;
const CONSECUTIVE_BONUS = 9;
const GAP_PENALTY = 1;

export function score(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let total = 0;
  let searchFrom = 0;
  let previousIndex = -1;
  for (const character of needle) {
    const index = haystack.indexOf(character, searchFrom);
    if (index === -1) return null;
    if (previousIndex !== -1 && previousIndex === index - 1)
      total += CONSECUTIVE_BONUS;
    if (index === 0 || WORD_BOUNDARY_BEFORE.has(haystack[index - 1]))
      total += WORD_START_BONUS;
    total += MATCH_SCORE_BASE;
    if (previousIndex !== -1)
      total -= GAP_PENALTY * (index - previousIndex - 1);
    else total -= index;
    previousIndex = index;
    searchFrom = index + 1;
  }
  return total;
}

export function filterCommands(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  if (!query.trim()) return [];
  return commands
    .map((command, order) => ({
      command,
      order,
      match: score(query, command.label) ?? score(query, command.id),
    }))
    .filter(
      (entry): entry is { command: PaletteCommand; order: number; match: number } =>
        entry.match !== null,
    )
    .sort((first, second) => second.match - first.match || first.order - second.order)
    .map((entry) => entry.command);
}

export function buildPaletteSections(options: {
  commands: PaletteCommand[];
  recentIds: string[];
  query: string;
  notes: PaletteCommand[];
}): PaletteSection[] {
  const { commands, recentIds, query, notes } = options;
  const sections: PaletteSection[] = [];
  if (!query.trim()) {
    const recent = recentIds
      .map((id) => commands.find((command) => command.id === id))
      .filter((command): command is PaletteCommand => Boolean(command));
    if (recent.length)
      sections.push({
        id: "recent",
        heading: SECTION_HEADINGS.recent,
        commands: recent,
      });
    sections.push({
      id: "commands",
      heading: SECTION_HEADINGS.commands,
      commands,
    });
    return sections;
  }
  const filtered = filterCommands(commands, query);
  if (filtered.length)
    sections.push({
      id: "commands",
      heading: SECTION_HEADINGS.commands,
      commands: filtered,
    });
  if (notes.length)
    sections.push({ id: "notes", heading: SECTION_HEADINGS.notes, commands: notes });
  return sections;
}

export function flattenSections(sections: PaletteSection[]): PaletteRow[] {
  return sections.flatMap((section) =>
    section.commands.map((command) => ({ section: section.id, command })),
  );
}

export function paletteSectionHeading(id: PaletteSectionId): string {
  return SECTION_HEADINGS[id];
}
