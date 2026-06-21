import { describe, it, expect } from "vitest";
import { noiseReason, type ReadBlob, type BlobSize } from "@/git/noise.js";

// REAL injected blobs — no mocks of git, just the (readBlob, blobSize) the
// production caller routes through `git show` / `git cat-file -s`. Each case
// mirrors a scenario in __tests__/fetch-diff.bats.

/** Build readBlob/blobSize from an in-memory path→content map (size = utf8 byte length). */
function fromMap(map: Record<string, string>): { readBlob: ReadBlob; blobSize: BlobSize } {
  return {
    readBlob: (p) => map[p] ?? null,
    blobSize: (p) => (p in map ? Buffer.byteLength(map[p] ?? "", "utf8") : 0),
  };
}

describe("noiseReason", () => {
  it("drops lockfiles by name (path-only, no blob read)", () => {
    const { readBlob, blobSize } = fromMap({});
    expect(noiseReason("package-lock.json", readBlob, blobSize)).toBe("lockfile");
    expect(noiseReason("bun.lock", readBlob, blobSize)).toBe("lockfile");
    expect(noiseReason("pnpm-lock.yaml", readBlob, blobSize)).toBe("lockfile");
    expect(noiseReason("web/pnpm-lock.yaml", readBlob, blobSize)).toBe("lockfile");
    expect(noiseReason("bun.lockb", readBlob, blobSize)).toBe("lockfile");
  });

  it("drops minified and sourcemap files by extension", () => {
    const { readBlob, blobSize } = fromMap({});
    expect(noiseReason("vendor.min.js", readBlob, blobSize)).toBe("minified");
    expect(noiseReason("styles.min.css", readBlob, blobSize)).toBe("minified");
    expect(noiseReason("app.js.map", readBlob, blobSize)).toBe("sourcemap");
  });

  it("drops dist/ and build/ output (root and mid-path) as build-output", () => {
    const { readBlob, blobSize } = fromMap({});
    expect(noiseReason("dist/index.js", readBlob, blobSize)).toBe("build-output");
    expect(noiseReason("web/dist/assets/index-AbC123.js", readBlob, blobSize)).toBe("build-output");
    expect(noiseReason("build/out.js", readBlob, blobSize)).toBe("build-output");
    expect(noiseReason("src/build/out.js", readBlob, blobSize)).toBe("build-output");
  });

  it("drops extended lockfiles whose names don't end in .lock", () => {
    const { readBlob, blobSize } = fromMap({});
    for (const p of [
      "go.sum",
      "api/go.sum",
      "npm-shrinkwrap.json",
      "packages.lock.json",
      "Package.resolved",
      ".terraform.lock.hcl",
      "gradle/foo.gradle.lockfile",
    ]) {
      expect(noiseReason(p, readBlob, blobSize)).toBe("lockfile");
    }
  });

  it("drops vendored dependency directories", () => {
    const { readBlob, blobSize } = fromMap({});
    for (const p of [
      "node_modules/x/y.js",
      "vendor/lib.go",
      "third_party/a.c",
      "Pods/X/Y.m",
      "Carthage/Build/z.swift",
      "bower_components/q.js",
      ".yarn/releases/yarn.cjs",
    ]) {
      expect(noiseReason(p, readBlob, blobSize)).toBe("vendored");
    }
  });

  it("drops more build/output dirs and .pyc as build-output", () => {
    const { readBlob, blobSize } = fromMap({});
    for (const p of [
      ".next/server/page.js",
      "app/.nuxt/x.js",
      "out/index.html",
      "target/debug/bin",
      "coverage/lcov.info",
      "pkg/__pycache__/m.cpython-311.pyc",
      "obj/Debug/a.dll",
      "x.pyc",
    ]) {
      expect(noiseReason(p, readBlob, blobSize)).toBe("build-output");
    }
  });

  it("drops codegen output (protobuf, graphql-codegen, .NET, Dart, Go)", () => {
    const { readBlob, blobSize } = fromMap({});
    for (const p of [
      "api/foo.pb.go",
      "api/foo_grpc.pb.go",
      "gen/foo_pb2.py",
      "gen/foo_pb2.pyi",
      "svc/FooGrpc.java",
      "types/schema.generated.ts",
      "ui/X.designer.cs",
      "m/model.g.dart",
      "m/model.freezed.dart",
      "gql/__generated__/ops.ts",
      "web/app.bundle.js",
      "k8s/zz_generated_deepcopy.go",
    ]) {
      expect(noiseReason(p, readBlob, blobSize)).toBe("generated");
    }
  });

  it("does not over-match normal source files that merely end in g.cs / similar", () => {
    const { readBlob, blobSize } = fromMap({});
    for (const p of ["src/config.cs", "Debug.cs", "util/log.cs"]) {
      expect(noiseReason(p, readBlob, blobSize)).toBeNull();
    }
    // …but a real generated .g.cs / .designer.cs IS dropped.
    expect(noiseReason("Form1.g.cs", readBlob, blobSize)).toBe("generated");
    expect(noiseReason("View.designer.cs", readBlob, blobSize)).toBe("generated");
  });

  it("KEEPS opinionated paths (migrations, snapshots) for review by default", () => {
    const { readBlob, blobSize } = fromMap({});
    expect(noiseReason("migrations/001_init.sql", readBlob, blobSize)).toBeNull();
    expect(noiseReason("db/migrate/20260101_x.rb", readBlob, blobSize)).toBeNull();
    expect(noiseReason("src/__snapshots__/App.test.tsx.snap", readBlob, blobSize)).toBeNull();
    expect(noiseReason("comp/Button.snap", readBlob, blobSize)).toBeNull();
  });

  it("drops files carrying an @generated / DO NOT EDIT marker in the first 20 lines", () => {
    const generated = "// @generated by codegen\nexport const x = 1\n";
    const doNotEdit = "/* DO NOT EDIT */\nconst y = 2\n";
    const { readBlob, blobSize } = fromMap({ "gen.ts": generated, "edit.ts": doNotEdit });
    expect(noiseReason("gen.ts", readBlob, blobSize)).toBe("generated");
    expect(noiseReason("edit.ts", readBlob, blobSize)).toBe("generated");
  });

  it("does not treat a marker past the first 20 lines as generated", () => {
    const late = `${Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n")}\n@generated\n`;
    const { readBlob, blobSize } = fromMap({ "late.ts": late });
    expect(noiseReason("late.ts", readBlob, blobSize)).toBeNull();
  });

  it("drops a hash-named file with a >5000-char line as minified (content)", () => {
    const longLine = "a".repeat(6000);
    const { readBlob, blobSize } = fromMap({ "bundle-Qcc39.js": `${longLine}\n` });
    expect(noiseReason("bundle-Qcc39.js", readBlob, blobSize)).toBe("minified");
  });

  it("detects a long line position-independently (not at file start)", () => {
    const blob = `const a = 1\nconst b = 2\nconst c = 3\n${"z".repeat(6000)}\n`;
    const { readBlob, blobSize } = fromMap({ "late-Qcc39.js": blob });
    expect(noiseReason("late-Qcc39.js", readBlob, blobSize)).toBe("minified");
  });

  it("measures the long-line threshold in UTF-8 BYTES, not code units (FIX 12)", () => {
    // 2000 emoji = 2000 UTF-16 code-unit *pairs* (line.length 4000, under 5000) but
    // 8000 UTF-8 bytes (over 5000). The deployed awk uses byte length, so this must
    // be flagged minified — a code-unit `.length` check would have wrongly kept it.
    const multibyteLine = "😀".repeat(2000);
    expect(multibyteLine.length).toBeLessThan(5000); // UTF-16 code units
    expect(Buffer.byteLength(multibyteLine, "utf8")).toBeGreaterThan(5000); // UTF-8 bytes
    const { readBlob, blobSize } = fromMap({ "emoji-Qcc39.js": `${multibyteLine}\n` });
    expect(noiseReason("emoji-Qcc39.js", readBlob, blobSize)).toBe("minified");
  });

  it("keeps a file whose longest line is exactly 5000 bytes (boundary, > not >=)", () => {
    // Exactly 5000 bytes is NOT over the threshold (strict >), matching the awk.
    const line = "a".repeat(5000);
    expect(Buffer.byteLength(line, "utf8")).toBe(5000);
    const { readBlob, blobSize } = fromMap({ "src/boundary.ts": `${line}\n` });
    expect(noiseReason("src/boundary.ts", readBlob, blobSize)).toBeNull();
  });

  it("drops a >1MB short-line blob as large-file (size rule, no long line)", () => {
    // 1.2MB of short lines: no single line is long, only the size rule catches it.
    const big = Array.from({ length: 120_000 }, (_, i) => `const x${i} = ${i}`).join("\n");
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(1_000_000);
    const { readBlob, blobSize } = fromMap({ "generated-data.ts": big });
    expect(noiseReason("generated-data.ts", readBlob, blobSize)).toBe("large-file");
  });

  it("keeps real source (returns null)", () => {
    const src = "export function add(a: number, b: number) {\n  return a + b\n}\n";
    const { readBlob, blobSize } = fromMap({ "src/app.ts": src });
    expect(noiseReason("src/app.ts", readBlob, blobSize)).toBeNull();
  });

  it("keeps a real file whose blob is missing at head (readBlob → null)", () => {
    const { readBlob, blobSize } = fromMap({});
    expect(noiseReason("src/new.ts", readBlob, blobSize)).toBeNull();
  });
});
