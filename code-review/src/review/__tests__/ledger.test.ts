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

  it("never lets a wide excluded set crowd every unreviewed path out of the cap", () => {
    // 60 `assets/*` binaries dropped as large-file, plus 3 unreviewed and 2 pending
    // `src/*` paths. `assets/` sorts before `src/`, so under one shared alphabetical
    // order the first 50 slots all went to the excluded binaries and EVERY exception
    // vanished into the overflow line — under `VERBOSITY=full`, i.e. exactly when the
    // reader asked for more detail and `degradeOnCoverage` says "see Coverage below".
    const entries: Array<[string, CoverageEntry]> = [];
    for (let i = 0; i < 60; i++) {
      entries.push([
        `assets/img${String(i).padStart(3, "0")}.png`,
        { status: "excluded", reason: "large-file" },
      ]);
    }
    const unreviewed = ["src/mod0.ts", "src/mod1.ts", "src/mod2.ts"];
    const pending = ["src/wait0.ts", "src/wait1.ts"];
    for (const path of unreviewed) {
      entries.push([path, { status: "unreviewed", reason: "not-attempted" }]);
    }
    for (const path of pending) entries.push([path, { status: "pending" }]);
    const ledger = buildLedger(entries);

    const full = renderLedger(ledger, "full");
    const rowLines = full.split("\n").filter((l) => l.startsWith("- `"));
    expect(rowLines.length).toBe(LEDGER_MAX_ROWS);

    // Every exception survives the cap; the counts are unaffected by the ordering.
    for (const path of unreviewed) {
      expect(full).toContain(`\`${path}\`: unreviewed (not-attempted)`);
    }
    for (const path of pending) expect(full).toContain(`\`${path}\`: pending`);
    expect(full).toContain("excluded: 60");
    expect(full).toContain("unreviewed: 3");
    expect(full).toContain("pending: 2");

    // The cap still bites — it is the excluded rows that give way, alphabetically.
    const total = 60 + unreviewed.length + pending.length;
    expect(full).toContain(`… ${total - LEDGER_MAX_ROWS} more`);
    expect(full).toContain("`assets/img000.png`: excluded (large-file)");
    expect(full).not.toContain("`assets/img059.png`");
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
