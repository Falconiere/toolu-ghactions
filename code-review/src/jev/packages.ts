// Capture exactly what completed baseline package calls saw, preserving dispatch order.
import type { DiffData } from "@/git/diff.js";
import type { Envelope } from "@/prompt.js";
import type { RepositoryContext } from "@/review/repositoryContext.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { EvidencePackage } from "./enhance.js";

/** Evidence capture is dormant when disabled; failed parent packages are excluded. */
export function capturePackages(enabled: boolean) {
  const pending = new WeakMap<Envelope, EvidencePackage>();
  const dispatched: { pkg: EvidencePackage; result?: ProviderResult }[] = [];
  return {
    capture(
      envelope: Envelope,
      diff: DiffData,
      context: RepositoryContext,
      rules: string,
    ): Envelope {
      if (enabled)
        pending.set(envelope, {
          paths: diff.changed_files,
          envelope,
          evidence: {
            diff: diff.diff,
            files: [...context.files, ...(diff.context_files ?? [])],
            rules,
            inventory: context.inventory,
            omitted: context.omitted,
          },
        });
      return envelope;
    },
    async review(
      envelope: Envelope,
      run: (e: Envelope) => Promise<ProviderResult>,
    ): Promise<ProviderResult> {
      const pkg = pending.get(envelope);
      const entry: { pkg: EvidencePackage; result?: ProviderResult } | undefined = pkg
        ? { pkg }
        : undefined;
      if (entry) dispatched.push(entry);
      const result = await run(envelope);
      if (entry) entry.result = result;
      return result;
    },
    completed(): EvidencePackage[] {
      const seen = new Set<string>();
      return dispatched.flatMap(({ pkg, result }) => {
        if (!result || result.verdict === "error" || result.partial) return [];
        const key = JSON.stringify(pkg.paths);
        if (seen.has(key)) return [];
        seen.add(key);
        return [pkg];
      });
    },
  };
}
