import fixture from "../fixtures/note-variable-cases.json";
import { describe, expect, it } from "vitest";
import {
  findVariableReferences,
  parseNoteVariables,
  resolveNoteVariables,
} from "../../src/lib/note-variables.ts";

type Case = {
  name: string;
  input: string;
  definitions: Array<[string, string]>;
  resolved: string;
  display: string;
};

const cases: Case[] = fixture;

describe("note variables", () => {
  it.each(cases)("$name", (item) => {
    expect([...parseNoteVariables(item.input)]).toEqual(item.definitions);
    expect(resolveNoteVariables(item.input)).toBe(item.resolved);
    expect(resolveNoteVariables(item.input, { definitions: "display" })).toBe(
      item.display,
    );
  });

  it("reports reference ranges and resolved values", () => {
    const text = "a:: x\n{{a}} {{b}}";
    const [first, second] = findVariableReferences(text);
    expect(text.slice(first.from, first.to)).toBe("{{a}}");
    expect(first.value).toBe("x");
    expect(second.value).toBeUndefined();
  });
});
