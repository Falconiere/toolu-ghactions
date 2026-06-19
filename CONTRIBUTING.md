# Contributing

Thanks for improving the AI Code Review action.

## Commit convention

This repo releases automatically via [release-please](https://github.com/googleapis/release-please), so commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` → minor bump
- `fix: ...` → patch bump
- `feat!: ...` / `fix!: ...` (breaking change) → major bump
- `docs:`, `chore:`, `test:`, `ci:` → no bump (still in the changelog)

Use the same convention in PR titles — the squash-merge commit drives the release.

## Development

`code-review/` is a TypeScript [node24 JS action](https://docs.github.com/actions). The dev loop runs on [bun](https://bun.sh) (≥ 1.3.14); the shipped `dist/index.cjs` is bundled with esbuild and the tests run on vitest.

```bash
cd code-review
bun install            # installs deps + wires git hooks (lefthook) via the prepare script

bun run check          # the full local gate: typecheck + lint + fmt:check + test
# or run them individually:
bun run typecheck      # tsc --noEmit (@/ path alias resolves via tsconfig)
bun run lint           # oxlint --type-aware --deny-warnings (zero warnings; bans `as`, allows `as const`)
bun run lint:fix       # oxlint --fix (autofixable issues)
bun run fmt            # oxfmt — format the tree
bun run fmt:check      # oxfmt --check — verify formatting
bun run test           # vitest run
bun run build          # esbuild → dist/index.cjs (commit the result; CI fails if it drifts from src)
```

[lefthook](https://lefthook.dev) git hooks (installed by `bun install`): **pre-commit** runs `oxlint --fix` + `oxfmt` on staged `.ts`; **pre-push** runs the full type-aware lint, typecheck, and a dist-sync build check.

The bash actions (`cloudflare-tunnel/`, `scripts/`) keep their shell toolchain:

```bash
bats cloudflare-tunnel/__tests__/*.bats scripts/__tests__/*.bats
shellcheck --severity=warning cloudflare-tunnel/src/*.sh scripts/*.sh
```

## Tests

`code-review/` tests are [vitest](https://vitest.dev) specs colocated in `src/**/__tests__/`, run over **real recorded fixtures** — recorded OpenRouter responses and real git repos built in temp dirs. Do NOT add fabricated/mock finding data: the network is stubbed only at the `fetch` boundary by replaying real recorded responses; the data under test stays real. Imports use the `@/` alias (e.g. `@/llm/openrouter.js`).

## Code-quality rules (enforced by `bun run lint`)

- **Zero errors/warnings** (`oxlint --deny-warnings`).
- **No type assertions** — `x as Foo` is banned (`consistent-type-assertions`); use type annotations, `satisfies`, type guards, or zod validation instead. `as const` is allowed.
- **Type-aware linting** is on (`oxlint-tsgolint`), so rules like `no-base-to-string` apply.
- One responsibility per file, named after its export; every module/public symbol gets a concise doc line; keep files ≤ 300 lines.
- Handle every fallible call; never silence with a disable comment.

## Recording OpenRouter fixtures

Fixture files live under `code-review/src/llm/__tests__/fixtures/` and must be **real recorded API responses** (the action runs a single OpenRouter model via the Vercel AI SDK). To record:

1. Get a real OpenRouter API key.
2. Make a request matching the wire format the action sends (see `src/llm/openrouter.ts` for the endpoint, headers, and `response_format`).
3. Save the raw JSON response to `src/llm/__tests__/fixtures/success.json`. For error fixtures, use a deliberately bad key to trigger a 401.
4. Sanitize — remove any token/secret from the response body before committing.
