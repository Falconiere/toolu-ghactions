import { describe, expect, it } from "vitest";
import { CATEGORY_ALIASES, normalizeCategory, type ReportCategory } from "@/report/categories.js";

describe("normalizeCategory", () => {
  it("maps each of the eight checklist headings verbatim onto its category", () => {
    expect(normalizeCategory("CORRECTNESS")).toBe("correctness");
    expect(normalizeCategory("SECURITY")).toBe("security");
    expect(normalizeCategory("PERFORMANCE")).toBe("performance");
    expect(normalizeCategory("TEST COVERAGE")).toBe("test-coverage");
    expect(normalizeCategory("DOC/COMMENT ACCURACY")).toBe("doc-accuracy");
    expect(normalizeCategory("TIGHT ASSERTIONS")).toBe("assertions");
    expect(normalizeCategory("MIGRATION WARNINGS")).toBe("migration");
    expect(normalizeCategory("CONVENTION ADHERENCE")).toBe("conventions");
  });

  it("maps lower-cased and punctuation-stripped variants of the headings the same way", () => {
    expect(normalizeCategory("correctness")).toBe("correctness");
    expect(normalizeCategory("security")).toBe("security");
    expect(normalizeCategory("performance")).toBe("performance");
    expect(normalizeCategory("test_coverage")).toBe("test-coverage");
    expect(normalizeCategory("test-coverage")).toBe("test-coverage");
    expect(normalizeCategory("doccommentaccuracy")).toBe("doc-accuracy");
    expect(normalizeCategory("tight-assertions")).toBe("assertions");
    expect(normalizeCategory("migration warnings")).toBe("migration");
    expect(normalizeCategory("convention-adherence")).toBe("conventions");
  });

  it("maps realistic model paraphrases onto the intended category", () => {
    expect(normalizeCategory("bug")).toBe("correctness");
    expect(normalizeCategory("correctness bug")).toBe("correctness");
    expect(normalizeCategory("sec")).toBe("security");
    expect(normalizeCategory("privacy")).toBe("security");
    expect(normalizeCategory("perf")).toBe("performance");
    expect(normalizeCategory("scalability")).toBe("performance");
    expect(normalizeCategory("tests")).toBe("test-coverage");
    expect(normalizeCategory("test")).toBe("test-coverage");
    expect(normalizeCategory("coverage")).toBe("test-coverage");
    expect(normalizeCategory("docs")).toBe("doc-accuracy");
    expect(normalizeCategory("documentation")).toBe("doc-accuracy");
    expect(normalizeCategory("comment")).toBe("doc-accuracy");
    expect(normalizeCategory("assertion")).toBe("assertions");
    expect(normalizeCategory("assertions")).toBe("assertions");
    expect(normalizeCategory("migration")).toBe("migration");
    expect(normalizeCategory("db migration")).toBe("migration");
    expect(normalizeCategory("convention")).toBe("conventions");
    expect(normalizeCategory("conventions")).toBe("conventions");
    expect(normalizeCategory("style guide")).toBe("conventions");
    expect(normalizeCategory("maintainability")).toBe("conventions");
  });

  it("returns 'other' for unrecognized input, unlike normalizeVerdict's null contract", () => {
    expect(normalizeCategory("astrology")).toBe("other");
    expect(normalizeCategory("!!!")).toBe("other");
  });

  it("returns 'other' for an empty string", () => {
    expect(normalizeCategory("")).toBe("other");
  });

  it("returns 'other' for undefined (an absent category)", () => {
    expect(normalizeCategory(undefined)).toBe("other");
    expect(normalizeCategory()).toBe("other");
  });

  it("every CATEGORY_ALIASES value is a valid ReportCategory member, and 'other' is not aliased", () => {
    const valid: ReportCategory[] = [
      "correctness",
      "security",
      "performance",
      "test-coverage",
      "doc-accuracy",
      "assertions",
      "migration",
      "conventions",
      "other",
    ];
    for (const category of Object.values(CATEGORY_ALIASES)) {
      expect(valid).toContain(category);
    }
    expect(Object.values(CATEGORY_ALIASES)).not.toContain("other");
  });
});
