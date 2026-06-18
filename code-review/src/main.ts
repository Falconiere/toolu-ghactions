// main.ts — entry point for the Toolu AI Code Review action.
// Thin wrapper: read inputs, run the review pipeline, set outputs. The
// orchestration lives in pipeline.ts; this file stays small and side-effect-only.
// (Scaffold stub — fleshed out in step 18b once the pipeline modules land.)
async function main(): Promise<void> {
  // Pipeline wired up in later steps.
}

main().catch((err: unknown) => {
  // Top-level guard: never crash silently. Real verdict/abstain handling is
  // added with the pipeline in step 18b.
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
