import { describe, it, expect } from "vitest";
import {
  buildLedger,
  renderLedger,
  droppedFileEntry,
  binaryFileEntry,
  LEDGER_MAX_ROWS,
  type CoverageEntry,
  type CoverageStatus,
} from "@/review/ledger.js";
import type { DroppedFile } from "@/git/diff.js";

describe("renderLedger — size safety (AC-8)", () => {
  it("a 1 000-path ledger with clean statuses renders under 2 KB in both verbosities", () => {
    const entries = new Map<string, CoverageEntry>();
    for (let i = 0; i < 1000; i++) {
      entries.set(`src/file-${i}.ts`, { status: i % 7 === 0 ? "pattern" : "reviewed" });
    }
    const ledger = buildLedger(entries);

    const compact = renderLedger(ledger, "compact");
    const full = renderLedger(ledger, "full");

    expect(Buffer.byteLength(compact, "utf8")).toBeLessThan(2048);
    expect(Buffer.byteLength(full, "utf8")).toBeLessThan(2048);
    // No exception statuses present -> no per-path rows in either verbosity.
    expect(compact).not.toContain("src/file-0.ts");
    expect(full).not.toContain("src/file-0.ts");
    expect(compact).toContain("reviewed: ");
    expect(compact).toContain("pattern: ");
  });
});

describe("renderLedger — row cap", () => {
  it("caps unreviewed rows at LEDGER_MAX_ROWS with an overflow line", () => {
    const entries: Array<[string, CoverageEntry]> = [];
    for (let i = 0; i < 120; i++) {
      entries.push([`src/u-${String(i).padStart(3, "0")}.ts`, { status: "unreviewed" }]);
    }
    const ledger = buildLedger(entries);

    const rendered = renderLedger(ledger, "compact");
    const rowLines = rendered.split("\n").filter((l) => l.startsWith("- `"));

    expect(rowLines.length).toBe(LEDGER_MAX_ROWS);
    expect(rendered).toContain(`… ${120 - LEDGER_MAX_ROWS} more`);
  });

  it("caps excluded rows too, but only under full verbosity", () => {
    const entries: Array<[string, CoverageEntry]> = [];
    for (let i = 0; i < 80; i++) {
      entries.push([
        `vendor/v-${String(i).padStart(3, "0")}.js`,
        { status: "excluded", reason: "vendored" },
      ]);
    }
    const ledger = buildLedger(entries);

    const compact = renderLedger(ledger, "compact");
    const full = renderLedger(ledger, "full");

    // Compact: excluded is not an "always visible" status -> summary only, no rows.
    expect(compact).not.toContain("vendor/v-000.js");
    expect(compact).toContain("excluded: 80");

    // Full: excluded rows render, capped at 50 with an overflow note.
    const fullRowLines = full.split("\n").filter((l) => l.startsWith("- `"));
    expect(fullRowLines.length).toBe(LEDGER_MAX_ROWS);
    expect(full).toContain(`… ${80 - LEDGER_MAX_ROWS} more`);
  });
});

describe("renderLedger — every status renders in the summary", () => {
  it("all ten CoverageStatus values contribute a nonzero count", () => {
    const statuses: CoverageStatus[] = [
      "reviewed",
      "pattern",
      "rename",
      "formatting",
      "vendored",
      "generated",
      "excluded",
      "carried",
      "unreviewed",
      "pending",
    ];
    const entries: Array<[string, CoverageEntry]> = statuses.map((status, i) => [
      `src/s-${i}-${status}.ts`,
      { status },
    ]);
    const ledger = buildLedger(entries);

    const rendered = renderLedger(ledger, "full");
    for (const status of statuses) {
      expect(rendered).toContain(`${status}: 1`);
    }
  });
});

describe("renderLedger — reason strings surface", () => {
  it("excluded rows show their DroppedFile reason under full verbosity", () => {
    const dropped: DroppedFile[] = [
      { path: "package-lock.json", reason: "lockfile" },
      { path: "dist/bundle.js", reason: "build-output" },
      { path: "assets/huge.bin", reason: "large-file" },
    ];
    const entries: Array<[string, CoverageEntry]> = [
      ...dropped.map((d): [string, CoverageEntry] => [d.path, droppedFileEntry(d)]),
      ["assets/logo.png", binaryFileEntry()],
    ];
    const ledger = buildLedger(entries);

    const rendered = renderLedger(ledger, "full");
    expect(rendered).toContain("`package-lock.json`: excluded (lockfile)");
    expect(rendered).toContain("`dist/bundle.js`: excluded (build-output)");
    expect(rendered).toContain("`assets/huge.bin`: excluded (large-file)");
    expect(rendered).toContain("`assets/logo.png`: excluded (binary)");
  });
});

describe("renderLedger — determinism", () => {
  it("two ledgers built from the same entries in different insertion order render identically", () => {
    const base: Array<[string, CoverageEntry]> = [
      ["src/z.ts", { status: "unreviewed" }],
      ["src/a.ts", { status: "pending" }],
      ["src/m.ts", { status: "excluded", reason: "generated" }],
      ["src/b.ts", { status: "reviewed" }],
      ["src/c.ts", { status: "carried" }],
    ];
    const reversed = [...base].reverse();

    const ledgerA = buildLedger(base);
    const ledgerB = buildLedger(reversed);

    const renderedA = renderLedger(ledgerA, "full");
    const renderedB = renderLedger(ledgerB, "full");

    expect(renderedA).toBe(renderedB);

    // Re-render the same ledger a second time: byte-identical output.
    expect(renderLedger(ledgerA, "full")).toBe(renderedA);
  });
});
