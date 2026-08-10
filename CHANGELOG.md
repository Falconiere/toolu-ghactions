# Changelog

## [7.1.0](https://github.com/Falconiere/toolu-ghactions/compare/v7.0.0...v7.1.0) (2026-08-10)


### Features

* **code-review:** stream reviews, gate junk findings, honest budget, SARIF sanitizer, nested node24 actions ([3a45ab3](https://github.com/Falconiere/toolu-ghactions/commit/3a45ab3e110dfe9cd2b1d523a52ef76ba7e3e308))


### Bug Fixes

* **code-review:** address dogfood-review round 1 — filter pattern, finishReason, evergreen proof ref, direct salvage tests ([e1b173d](https://github.com/Falconiere/toolu-ghactions/commit/e1b173d14b0fabca7abfad985f7258c9a9913b7c))
* **code-review:** close pre-push review findings — CI contract, mirror rewrite guard, prompt-resolution trust order, consumer scan excludes ([1ba5ad8](https://github.com/Falconiere/toolu-ghactions/commit/1ba5ad820bc6347da635da873602410a9e222c47))
* **code-review:** keep the mirror guard broader than its sed, correct the proof-gate claim ([1962df5](https://github.com/Falconiere/toolu-ghactions/commit/1962df5f57de50d358508946f6c662dd2b7eb9e9))
* **code-review:** scope the mirror hoist guard to uses: lines, finish dist doc re-targeting, tighten the no-finish assertion ([008fb8b](https://github.com/Falconiere/toolu-ghactions/commit/008fb8bb502aad562b5c611525344ca55bb893ae))

## [7.0.0](https://github.com/Falconiere/toolu-ghactions/compare/v6.6.0...v7.0.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* **code-review:** MAX_CHUNKS now defaults to 0 (unlimited) with capped files recorded per-file as unreviewed; file-level fallback comments are removed (unanchorable findings appear in the sticky comment); sticky-comment layout and prompt bytes changed. Ships as code-review v7.

### Features

* **code-review:** size-proof review pipeline with distillation, clustering, and coverage ledger ([f4123f0](https://github.com/Falconiere/toolu-ghactions/commit/f4123f054964e662cc9f31bae25ea58e9fa5e3c8))


### Bug Fixes

* **code-review:** close all pre-push review findings ([7c9d1b7](https://github.com/Falconiere/toolu-ghactions/commit/7c9d1b70960792aceacf61f89d28dc729732b4be))
* **code-review:** document lastBody's create-vs-update precedence ([f3f19fc](https://github.com/Falconiere/toolu-ghactions/commit/f3f19fc9ed29ee200a0853c7a09ab73aef2135b0))
* **code-review:** note the warm-up path also covers single-package runs ([a873283](https://github.com/Falconiere/toolu-ghactions/commit/a8732832e5bc6ba74946f002c81efed71a521285))
* **code-review:** tighten isRecord, single-source the settled verdict, note the MAX_CHUNKS default change ([d2e377b](https://github.com/Falconiere/toolu-ghactions/commit/d2e377b052820b3d2af69693fcc6a1af928da479))
* **code-review:** write FETCH_HEAD via a real fetch in resume tests ([1d6caf7](https://github.com/Falconiere/toolu-ghactions/commit/1d6caf7a76e7464267cbf00d00b7b82d9311d4bd))

## [Unreleased]

### ⚠ BREAKING CHANGES

* **code-review:** `@v7` — size-proof review pipeline. `MAX_CHUNKS` default changes `20` → `0` (unlimited); the sticky comment gains new sections (coverage ledger, repeated-finding clusters, unanchored findings) and prompt byte counts change; the `subject_type: "file"` inline-comment fallback is removed (unanchorable findings now render in the sticky comment instead). No input is removed. See `code-review/README.md` → "v7 migration" for the full list.
* **code-review:** packaging refactor — the composite now invokes two nested node24 actions (`run/` for the LLM reviewer, `sanitize-sarif/` for the SARIF sanitizer) via the `$/` self-repository syntax, replacing the single `dist/` bundle. **Requires Actions runner ≥ 2.336.0** (GitHub-hosted and auto-updating self-hosted runners qualify; a version-pinned older runner must upgrade or stay on the previous tag). In exchange, node on the runner's PATH is no longer required. Workflow YAML is unchanged.

### Features

* **code-review:** layered review pipeline (deterministic diff distillation → intent-brief cartographer → bounded, schema-bisecting package reviewers → deterministic reducer) so review cost scales with substantive change instead of diff bytes, with provable per-file coverage on any PR size.
* **code-review:** coverage ledger — every changed path is accounted for exactly once in the sticky comment (`reviewed`/`pattern`/`rename`/`formatting`/`vendored`/`generated`/`excluded`/`carried`/`unreviewed`/`pending`); a would-be `approved` verdict degrades to `error` when any file is `unreviewed`/`pending`.
* **code-review:** finding clustering — a defect repeated identically across 3+ files collapses to one inline comment (exemplar + enumerated members) instead of one per file; dismissing the exemplar's thread dismisses the whole cluster.
* **code-review:** `MAX_WALL_MS` input — soft wall-clock budget for the review loop; a run that runs out of time persists a resumable state and completes via `@toolu resume`, a plain re-run, or the PR's next push.
* **code-review:** batched inline-comment publishing with 422 bisection, so one comment GitHub's Reviews API rejects can no longer zero out the whole review.
* **code-review:** SARIF sanitizer — automatic step between the scanners and the Code Scanning upload that copies `*.sarif` into an upload-only directory, clamping the sub-1 `region` values gitleaks emits for path-anchored findings (previously the whole file was rejected at upload); originals are untouched.
* **code-review:** streaming salvage — findings completed before output-token truncation are kept (partial review) instead of lost; truncation triggers budget escalation (8192 → 16384 → 32768 → 65536 → 131072 tokens), with honest partial-review verdicts when the ceiling is still exceeded.
* **code-review:** honest budget banner — when truncation occurs, the comment says exactly which lever to pull (raise `MAX_TOKENS` while below the ceiling; lower `MAX_CHUNK_LINES` at it).
* **code-review:** self-negating-finding filter — drops findings whose own text concludes there is no problem ("No issue.", "No violation."), so placeholder findings can no longer inflate the verdict or block the merge; the drop count feeds the verdict settle.
* **code-review:** node-less self-hosted runners — the review and sanitizer run as nested node24 actions using the runner's bundled Node (bash and git remain required, as before).

## [6.6.0](https://github.com/Falconiere/toolu-ghactions/compare/v6.5.4...v6.6.0) (2026-08-05)


### Features

* **code-review:** report review runs to the toolu.sh platform ([1d522e8](https://github.com/Falconiere/toolu-ghactions/commit/1d522e859f2b097ddccc7a3fadfe4b446465f9a7))


### Bug Fixes

* **code-review:** address PR review feedback ([9ac59f2](https://github.com/Falconiere/toolu-ghactions/commit/9ac59f20cbfc6fa4303b7f607531bdae15b58bf0))
* **code-review:** bind enrichFromPrior's fields before guarding them ([466321b](https://github.com/Falconiere/toolu-ghactions/commit/466321b1af4938239673897e0ad7ad65267df976))

## [6.5.4](https://github.com/Falconiere/toolu-ghactions/compare/v6.5.3...v6.5.4) (2026-08-05)


### Bug Fixes

* **code-review:** don't claim 'LLM judgment unavailable' on a recovered review ([53299d1](https://github.com/Falconiere/toolu-ghactions/commit/53299d10dc791d830fbd5568662c408c293b2d84))

## [6.5.3](https://github.com/Falconiere/toolu-ghactions/compare/v6.5.2...v6.5.3) (2026-08-01)


### Bug Fixes

* **code-review:** address PR review feedback ([fdf69a8](https://github.com/Falconiere/toolu-ghactions/commit/fdf69a8d511d8619bf2d03275bed66cbddd8a14d))
* **code-review:** disable DeepSeek thinking so reviews aren't empty ([3f152bc](https://github.com/Falconiere/toolu-ghactions/commit/3f152bcca667d9cb49ebe105cf149918900a6639))
* **code-review:** don't recover a truncated pass with zero findings ([4a2c83a](https://github.com/Falconiere/toolu-ghactions/commit/4a2c83a02752f9ab668f897b14b2da85b3c47b4a))
* **code-review:** keep a complete response's approved verdict through recovery ([0061fcc](https://github.com/Falconiere/toolu-ghactions/commit/0061fcc7b427ea5f5cae5bde240be4388042256f))
* **code-review:** recover a review whose decorative fields came back null ([e53853d](https://github.com/Falconiere/toolu-ghactions/commit/e53853d6aaaf4433c579310690bb04098a20bafa))
* **code-review:** recover an off-schema review instead of discarding it ([204b997](https://github.com/Falconiere/toolu-ghactions/commit/204b997826d3ba2e0ecb6dfb60aaa80228eb59cc))

## [6.5.2](https://github.com/Falconiere/toolu-ghactions/compare/v6.5.1...v6.5.2) (2026-07-30)


### Bug Fixes

* **code-review:** keep a nearby-matched blocker off the retried resolve ([bd7dcc4](https://github.com/Falconiere/toolu-ghactions/commit/bd7dcc494883d0acfe36566a6e721a6b31cce446))
* **code-review:** retry the resolve mutation when only the accepted-note reply landed ([888ccd5](https://github.com/Falconiere/toolu-ghactions/commit/888ccd5b8c6975351ebf3b0143000edad3de65eb))

## [6.5.1](https://github.com/Falconiere/toolu-ghactions/compare/v6.5.0...v6.5.1) (2026-07-30)


### Bug Fixes

* **code-review:** harden dismissal detection — address round-1 review ([1501ad7](https://github.com/Falconiere/toolu-ghactions/commit/1501ad78db3e133c44e9e4474c221ebdd7390a75))
* **code-review:** make quoted-region stripping linear, not quadratic ([c089c15](https://github.com/Falconiere/toolu-ghactions/commit/c089c15d0a03cfafc065b620aa5df1b189df15b5))
* **code-review:** show the author's reasoning on ARGUED OUT prompt entries ([956a3f8](https://github.com/Falconiere/toolu-ghactions/commit/956a3f8d684237da487cbc6da9de31784ba1b854))
* **code-review:** stop re-raising findings the author refused in a reply ([f0cd99d](https://github.com/Falconiere/toolu-ghactions/commit/f0cd99d3baf8fc5fc790709950434a709cf55e0b))

## [6.5.0](https://github.com/Falconiere/toolu-ghactions/compare/v6.4.0...v6.5.0) (2026-07-17)


### Features

* **code-review:** incremental re-review scope — converge without a surrender cap ([c02e660](https://github.com/Falconiere/toolu-ghactions/commit/c02e66069d45af47cb32406a2ff4b5cfc994c2b9))


### Bug Fixes

* **code-review:** address round-2 review — silent git probes, @/ test imports ([d4399df](https://github.com/Falconiere/toolu-ghactions/commit/d4399df5df8c6b7cc72089c9ed49a47272d1c1e5))
* **code-review:** converge incremental series on the PR head sha ([8d3671e](https://github.com/Falconiere/toolu-ghactions/commit/8d3671e5cd76683c9c9cdbc69083b11fed8531f5))
* **code-review:** converge reviews — marker survives cancelled runs, loose open-thread matching ([d52a7d6](https://github.com/Falconiere/toolu-ghactions/commit/d52a7d6e1a5c3509f649a90019521e7caa1b0cf1))
* **release:** prefer a GitHub App token over the expiring PAT ([192d89e](https://github.com/Falconiere/toolu-ghactions/commit/192d89e7132405088408dfc922549009eafa710f))
* **release:** warn loudly when the app token mint fails ([7e27c9f](https://github.com/Falconiere/toolu-ghactions/commit/7e27c9ff7879398ca94d71b367fcbb4f2887bada))

## [6.4.0](https://github.com/Falconiere/toolu-ghactions/compare/v6.3.0...v6.4.0) (2026-07-15)


### Features

* **code-review:** converge reviews — wider resolved-thread suppression + MAX_ROUNDS surrender ([2b20c9f](https://github.com/Falconiere/toolu-ghactions/commit/2b20c9f0782a1f6e6188c2c4240f81b9d71b3704))

## [6.3.0](https://github.com/Falconiere/toolu-ghactions/compare/v6.2.1...v6.3.0) (2026-07-13)


### Features

* **code-review:** RULES_REF input — opt-in merge-ref convention reading ([1396b2e](https://github.com/Falconiere/toolu-ghactions/commit/1396b2e6904a9a525131ab370f244fd595c7b042))


### Bug Fixes

* **code-review:** fail-safe skip when RULES_REF=merge lacks a merge ref ([32f3014](https://github.com/Falconiere/toolu-ghactions/commit/32f3014f8f012b16e9b908e4a249a0bcc4085a20))

## [6.2.1](https://github.com/Falconiere/toolu-ghactions/compare/v6.2.0...v6.2.1) (2026-07-12)


### Bug Fixes

* **code-review:** feed resolved threads to the model as dismissed findings ([8e268b6](https://github.com/Falconiere/toolu-ghactions/commit/8e268b6ba56cde12c6441c4b4d81b63977dab963))

## [6.2.0](https://github.com/Falconiere/toolu-ghactions/compare/v6.1.0...v6.2.0) (2026-07-12)


### Features

* **expo-builder:** deploy-google-play — native Play API AAB deploy ([#78](https://github.com/Falconiere/toolu-ghactions/issues/78)) ([6ddc504](https://github.com/Falconiere/toolu-ghactions/commit/6ddc5044f90655e3d8a24022ee4a9cef2538238c))


### Bug Fixes

* **tests:** env.RUN on code-review checkout, scope .github force-all ([8331f30](https://github.com/Falconiere/toolu-ghactions/commit/8331f30622b39ba105646fd9efe35041a1380a16))
* **tests:** here-string in changes filter, avoid SIGPIPE flip ([0d8c1d8](https://github.com/Falconiere/toolu-ghactions/commit/0d8c1d8fe29eb96c9ea09349dd9b20a47d0d5bd2))

## [6.1.0](https://github.com/Falconiere/toolu-ghactions/compare/v6.0.2...v6.1.0) (2026-07-11)


### Features

* **expo-builder:** add no-EAS Android build + GitHub Releases deploy suite ([bb2be9e](https://github.com/Falconiere/toolu-ghactions/commit/bb2be9e7a494b04976894fbfff758a944819901a))


### Bug Fixes

* **expo-builder:** address CI review findings ([147722b](https://github.com/Falconiere/toolu-ghactions/commit/147722baedd4a234fd247531cfe5436f49b79063))
* **expo-builder:** AGP finalizeDsl signing hook + bash-3.2 empty-array guards ([efa44fc](https://github.com/Falconiere/toolu-ghactions/commit/efa44fc7b91938a74d15c188eb4a6df7f7ef1b57))
* **expo-builder:** second review round — mask keystore b64, harden assertions ([4b676c5](https://github.com/Falconiere/toolu-ghactions/commit/4b676c508f05726531b3ff4d771abe2313e9f6a4))
* **expo-builder:** unique heredoc delimiter for uploaded-assets output ([99f8fa9](https://github.com/Falconiere/toolu-ghactions/commit/99f8fa9df2293b5f12e50e7b2acfd545bcebd60c))

## [6.0.2](https://github.com/Falconiere/toolu-ghactions/compare/v6.0.1...v6.0.2) (2026-07-11)


### Bug Fixes

* **release:** serialize release runs repo-wide to stop mirror tag races ([f532288](https://github.com/Falconiere/toolu-ghactions/commit/f53228832f1feb8c64af3aca1208a24b959493bf))

## [6.0.1](https://github.com/Falconiere/toolu-ghactions/compare/v6.0.0...v6.0.1) (2026-07-10)


### Bug Fixes

* **code-review:** resolved threads dismiss findings from verdict and comment ([5d6e357](https://github.com/Falconiere/toolu-ghactions/commit/5d6e35726d40dfdc1cdbd4780b65555f4e55daf7))

## [6.0.0](https://github.com/Falconiere/toolu-ghactions/compare/v5.1.1...v6.0.0) (2026-07-09)


### ⚠ BREAKING CHANGES

* **code-review:** cut verdict-comment verbosity, add VERBOSITY input

### Features

* **code-review:** cut verdict-comment verbosity, add VERBOSITY input ([38734ff](https://github.com/Falconiere/toolu-ghactions/commit/38734ff489b416e643952d4f6288b49980001ecc))


### Bug Fixes

* **code-review:** address PR [#70](https://github.com/Falconiere/toolu-ghactions/issues/70) review feedback ([6d12306](https://github.com/Falconiere/toolu-ghactions/commit/6d12306a5ad43fe3ff8cb0284031b039afb79a4c))

## [5.1.1](https://github.com/Falconiere/toolu-ghactions/compare/v5.1.0...v5.1.1) (2026-07-06)


### Bug Fixes

* **code-review:** keep module context whole in chunks, honest partial verdicts ([7cd2fcf](https://github.com/Falconiere/toolu-ghactions/commit/7cd2fcf5aa67b9061129e3b0af55029738ec6323))

## [5.1.0](https://github.com/Falconiere/toolu-ghactions/compare/v5.0.0...v5.1.0) (2026-06-21)


### Features

* **code-review:** exclude generated artifacts from review + rename manifest ([9aab335](https://github.com/Falconiere/toolu-ghactions/commit/9aab335d5ba9ae23b179955d0694263496cdf746))


### Bug Fixes

* **code-review:** address PR review feedback ([96ae194](https://github.com/Falconiere/toolu-ghactions/commit/96ae1941d3972fdfb767cf110007689a5d909f7b))
* **code-review:** clarify codegen regex intent + negative-coverage tests ([d1cb807](https://github.com/Falconiere/toolu-ghactions/commit/d1cb807880d5e476adedfdd1b834778119ecf03f))
* **code-review:** NUL-delimit check-attr for generated detection ([9fa7bcc](https://github.com/Falconiere/toolu-ghactions/commit/9fa7bcc65bc1f5ba5abe22107a905d1287fab0ab))

## [5.0.0](https://github.com/Falconiere/toolu-ghactions/compare/v4.0.0...v5.0.0) (2026-06-21)


### ⚠ BREAKING CHANGES

* **code-review:** FAIL_ON defaults to "changes", so the action now fails its own job when the bot requests changes. PRs previously green-with-changes are blocked once this check is Required in branch protection. Set FAIL_ON: none to restore advisory-only behavior.

### Features

* **code-review:** add FAIL_ON merge gate (on by default) ([1fbeb16](https://github.com/Falconiere/toolu-ghactions/commit/1fbeb1697e1812211160996a2dd3e5bc86eb63ea))

## [Unreleased]


### ⚠ BREAKING CHANGES

* **code-review:** the new `FAIL_ON` input defaults to `changes`, so the action now **fails its own job** (red check) when the bot's verdict is `changes`. PRs that were green-with-changes are blocked once this check is marked Required in branch protection. Set `FAIL_ON: none` to restore the previous advisory-only behavior.

### Features

* **code-review:** add `FAIL_ON` merge gate — fail the job on a blocking verdict (`changes` and/or `error`) so a required status check can block the PR. Defaults to `changes` (on by default); `changes,error` also blocks on a provider error; `none` keeps the review advisory.

## [4.0.0](https://github.com/Falconiere/toolu-ghactions/compare/v3.5.1...v4.0.0) (2026-06-21)


### ⚠ BREAKING CHANGES

* **code-review:** removes PROVIDERS, OPENROUTER_API_KEY, MODEL, MERGE_STRATEGY, FALLBACK_MODEL, REVIEW_MODE, ENFORCE_JSON_SCHEMA. Migrate to PROVIDER + MODEL_ID + API_KEY.

### Features

* **code-review:** native DeepSeek provider via flat PROVIDER/MODEL_ID/API_KEY contract ([1c5a430](https://github.com/Falconiere/toolu-ghactions/commit/1c5a430ecddb7c05f0a471647d9f50ba5c70eb80))


### Bug Fixes

* **code-review:** address PR review feedback ([4ddf612](https://github.com/Falconiere/toolu-ghactions/commit/4ddf612a7ce76f3d868567950ea7acf888b1c4e3))
* **code-review:** address review round 2 ([99be353](https://github.com/Falconiere/toolu-ghactions/commit/99be353b19757ad53772328bb0e658067c35e6f9))
* **code-review:** clean dist bundle + migrate dogfood workflow to v4 inputs ([63daa16](https://github.com/Falconiere/toolu-ghactions/commit/63daa16241cc5461afaf2753f9d0a155d13d0e8a))
* **code-review:** repair injection-probe import after openrouter.ts-&gt;review.ts rename ([f9bf584](https://github.com/Falconiere/toolu-ghactions/commit/f9bf584295bbbb8f89b11411c1307b0ded056665))

## [3.5.1](https://github.com/Falconiere/toolu-ghactions/compare/v3.5.0...v3.5.1) (2026-06-20)


### Bug Fixes

* **code-review:** raise per-attempt model timeout to 180s, make it configurable ([b7b4a53](https://github.com/Falconiere/toolu-ghactions/commit/b7b4a53e57caef7b88f4c84fe18e6ef84250bafd))
* **code-review:** reject non-positive REQUEST_TIMEOUT_MS ([b4c7cae](https://github.com/Falconiere/toolu-ghactions/commit/b4c7cae773c2aec31ccf70644fa6866578d788ec))

## [3.5.0](https://github.com/Falconiere/toolu-ghactions/compare/v3.4.1...v3.5.0) (2026-06-20)


### Features

* **code-review:** read prior thread replies and accept-or-argue instead of re-raising ([4a676c7](https://github.com/Falconiere/toolu-ghactions/commit/4a676c7fe3b4bf452cc6fc5789136804a66e53a9))


### Bug Fixes

* **code-review:** dedup duplicate threads and guard unattributable logins ([e8d26e7](https://github.com/Falconiere/toolu-ghactions/commit/e8d26e7ae106ec4ebd8567929b1f17f9c9eef48d))

## [3.4.1](https://github.com/Falconiere/toolu-ghactions/compare/v3.4.0...v3.4.1) (2026-06-20)


### Bug Fixes

* **code-review:** keep retry backoff timer ref'd so the action can't exit 0 mid-retry ([cda3ba7](https://github.com/Falconiere/toolu-ghactions/commit/cda3ba72e378274085c8876969754b709ca8e47a))

## [3.4.0](https://github.com/Falconiere/toolu-ghactions/compare/v3.3.1...v3.4.0) (2026-06-20)


### Features

* **code-review:** default MODEL to deepseek/deepseek-v4-pro (1M context) ([18f797c](https://github.com/Falconiere/toolu-ghactions/commit/18f797c5083670299381435b4b8c3c024f77495b))


### Bug Fixes

* **code-review:** bound review_plan so it can't starve findings of budget ([0e39e74](https://github.com/Falconiere/toolu-ghactions/commit/0e39e744120eb3ebe05915314c06c660cb9b9315))
* **code-review:** constrain `suggestion` to committable code, not prose ([82af6c9](https://github.com/Falconiere/toolu-ghactions/commit/82af6c9a370b253a8d5172e2d7338559f6060b68))
* **code-review:** drop quote on blank cited line; clarify quote-gate intent ([9c636a8](https://github.com/Falconiere/toolu-ghactions/commit/9c636a82d039a78b72a98130bb1ab28c6e962f4c))
* **code-review:** make review reliable against output-token truncation ([78f2354](https://github.com/Falconiere/toolu-ghactions/commit/78f235456dd483ebb0c21be9f7919b5021898a0c))
* **code-review:** rebuild dist with bun to match CI ([52e41c7](https://github.com/Falconiere/toolu-ghactions/commit/52e41c73d3796c891d5d49801d9ac1600421ba86))
* **code-review:** salvaged result is always "changes", never stale "approved" ([140195c](https://github.com/Falconiere/toolu-ghactions/commit/140195c361d34638517bf08588c8029714238264))
* **code-review:** silence no-op input warnings, dedupe loading gif, bump codeql v4 ([99357c3](https://github.com/Falconiere/toolu-ghactions/commit/99357c3083c08a6558d186f4a9541e42097b17ef))
* **code-review:** stop discarding good reviews on long plan / empty content ([02245bc](https://github.com/Falconiere/toolu-ghactions/commit/02245bcc672a9d4b0129d7954291d4ad2fa21468))
* **code-review:** stop false 'still present' findings on removed diff lines ([2170952](https://github.com/Falconiere/toolu-ghactions/commit/21709520d0eedcd688b799b7068be7fd590d3c9d))

## [3.3.1](https://github.com/Falconiere/toolu-ghactions/compare/v3.3.0...v3.3.1) (2026-06-19)


### Bug Fixes

* **code-review:** retry hung provider calls instead of one 180s abort ([b4206b1](https://github.com/Falconiere/toolu-ghactions/commit/b4206b1c7bf20c6f5d46000a360d6f37425436c6))

## [3.3.0](https://github.com/Falconiere/toolu-ghactions/compare/v3.2.0...v3.3.0) (2026-06-19)


### Features

* **code-review:** resize in-progress loading gif to 100px, bottom-left ([#50](https://github.com/Falconiere/toolu-ghactions/issues/50)) ([b137fa6](https://github.com/Falconiere/toolu-ghactions/commit/b137fa6e902da559b32a3322c7b312a58bb2b4bb))

## [3.2.0](https://github.com/Falconiere/toolu-ghactions/compare/v3.1.0...v3.2.0) (2026-06-19)


### Features

* **code-review:** show loading gif in in-progress comment ([746f461](https://github.com/Falconiere/toolu-ghactions/commit/746f46175cda030d4f68a4a2441dbc202b788d4b))

## [3.1.0](https://github.com/Falconiere/toolu-ghactions/compare/v3.0.0...v3.1.0) (2026-06-19)


### Features

* **code-review:** chunk large diffs so the LLM review survives big PRs ([91fe01b](https://github.com/Falconiere/toolu-ghactions/commit/91fe01b18e39c5eb3ffc400685fdc6c11239c7f1))

## [3.0.0](https://github.com/Falconiere/toolu-ghactions/compare/v2.3.3...v3.0.0) (2026-06-19)


### ⚠ BREAKING CHANGES

* **code-review:** hybrid review — deterministic SAST (gitleaks + opengrep) triaged by the LLM
* **code-review:** rename verdict labels to merge-approved / request-changes
* **code-review:** finalize node24 JS action — CI/release/docs + remove bash
* **code-review:** package as node24 JS action (drop Docker)

### Features

* **code-review:** finalize node24 JS action — CI/release/docs + remove bash ([483c78a](https://github.com/Falconiere/toolu-ghactions/commit/483c78a6d2004b9b91a2118cbe6c4bcbddc8ae0f))
* **code-review:** hybrid review — deterministic SAST (gitleaks + opengrep) triaged by the LLM ([1449dc3](https://github.com/Falconiere/toolu-ghactions/commit/1449dc36f5b054a8b47eb62c99915888c1431dea))
* **code-review:** package as node24 JS action (drop Docker) ([cb4c50f](https://github.com/Falconiere/toolu-ghactions/commit/cb4c50f8a52a24c2a195503488ecb814622e5843))
* **code-review:** port diff/shape/noise to TS (git workstream) ([456b660](https://github.com/Falconiere/toolu-ghactions/commit/456b6600d0cfb5ab4fba846bd6ebdcd374b55827))
* **code-review:** port GitHub layer (appToken/event/comment/review/label) ([ad26069](https://github.com/Falconiere/toolu-ghactions/commit/ad26069d23a08c8574cab563dc8209e1a9f1e103))
* **code-review:** port LLM layer via Vercel AI SDK (reasoning off) ([b272b95](https://github.com/Falconiere/toolu-ghactions/commit/b272b9551f398edbbcb9cae4601cc2325be3dae0))
* **code-review:** port review output (validate/recap/verdict) ([9372d9f](https://github.com/Falconiere/toolu-ghactions/commit/9372d9f08c184920894aa23bda4ce874bf9a5ad1))
* **code-review:** port rules + prompt to TS (injection-safe) ([315c9df](https://github.com/Falconiere/toolu-ghactions/commit/315c9df959312fced78b57c1e82636a4dc941b61))
* **code-review:** rename verdict labels to merge-approved / request-changes ([7cc923a](https://github.com/Falconiere/toolu-ghactions/commit/7cc923ac188caeea19ec3ddfe36d669cea4c4a01))
* **code-review:** scaffold TS rewrite + port review-state (byte-compat) ([0f946c0](https://github.com/Falconiere/toolu-ghactions/commit/0f946c068c6ba88177da12e37faf4e81962282f0))
* **code-review:** wire integration layer (inputs/pipeline/main) ([93b275b](https://github.com/Falconiere/toolu-ghactions/commit/93b275b74d1440a217c66a8161e64c7d0ca9a202))


### Bug Fixes

* **code-review:** apply max-effort review findings (15) ([4447288](https://github.com/Falconiere/toolu-ghactions/commit/44472889444ea86a01e2030a15a0a2f158b2d9b5))
* **code-review:** emit dist/index.cjs so the node24 action loads ([44db889](https://github.com/Falconiere/toolu-ghactions/commit/44db88959a401be469f83b5633a260ae23b03537))
* **code-review:** gpt-4o-mini default, gitleaks --no-git + allowlist, opengrep excludes, finish_reason ([17f3881](https://github.com/Falconiere/toolu-ghactions/commit/17f3881713299a59c3e55bd3d9972022fbbe78f2))
* **code-review:** revert default model to gemini-2.5-flash ([f6605fb](https://github.com/Falconiere/toolu-ghactions/commit/f6605fb87d20d637cd37948344a9b05bf59e3892))
* **code-review:** stabilize LLM review — temp 0, reliable model, surface errors ([75c8c87](https://github.com/Falconiere/toolu-ghactions/commit/75c8c872d94195d4a38b8df0349b038db77c0efd))

## [2.3.3](https://github.com/Falconiere/toolu-ghactions/compare/v2.3.2...v2.3.3) (2026-06-19)


### Bug Fixes

* **code-review:** disable reasoning on OpenRouter so reviews don't error ([86cc68a](https://github.com/Falconiere/toolu-ghactions/commit/86cc68a93d4f140be3b2016c40e71d1e386b0e91))

## [2.3.2](https://github.com/Falconiere/toolu-ghactions/compare/v2.3.1...v2.3.2) (2026-06-18)


### Bug Fixes

* **code-review:** drop build artifacts from diff to stop review timeouts ([2bd4b98](https://github.com/Falconiere/toolu-ghactions/commit/2bd4b9835ae863d3ca7341079d11bb5841561af8))

## [2.3.1](https://github.com/Falconiere/toolu-ghactions/compare/v2.3.0...v2.3.1) (2026-06-18)


### Bug Fixes

* **code-review:** errored provider abstains instead of forcing "changes" ([2924980](https://github.com/Falconiere/toolu-ghactions/commit/2924980ace83bba6ddad3eaeeb04a90455834009))
* **code-review:** pull :v2 image so consumers run current code ([bddcc38](https://github.com/Falconiere/toolu-ghactions/commit/bddcc38939ab8dd24a3c12420c2d35ce5d81c93e))

## [2.3.0](https://github.com/Falconiere/toolu-ghactions/compare/v2.2.1...v2.3.0) (2026-06-18)


### Features

* **code-review:** review the diff against the repo's own convention files ([f0d18a8](https://github.com/Falconiere/toolu-ghactions/commit/f0d18a8a96fd233bde5df4430ffb0dbeb0d0d03b))

## [2.2.1](https://github.com/Falconiere/toolu-ghactions/compare/v2.2.0...v2.2.1) (2026-06-18)


### Bug Fixes

* **code-review:** default to deepseek/deepseek-v4-flash ([1150500](https://github.com/Falconiere/toolu-ghactions/commit/1150500c077add2b5900bea205fcd512fe50bb7b))

## [2.2.0](https://github.com/Falconiere/toolu-ghactions/compare/v2.1.1...v2.2.0) (2026-06-18)


### Features

* **code-review:** accept base64-encoded APP_PRIVATE_KEY (auto-decode) ([0255f8e](https://github.com/Falconiere/toolu-ghactions/commit/0255f8e6c6851d36251de69a8ad07c5acc9caee7))
* **code-review:** custom App identity, review memory, and [@mention](https://github.com/mention) re-trigger ([b9dd205](https://github.com/Falconiere/toolu-ghactions/commit/b9dd205b4f54584329ece1ecc4513b59b3f9a6cb))

## [2.1.1](https://github.com/Falconiere/toolu-ghactions/compare/v2.1.0...v2.1.1) (2026-06-17)


### Bug Fixes

* **release:** lowercase GHCR owner in mirror image ref ([2dd845e](https://github.com/Falconiere/toolu-ghactions/commit/2dd845e19b787200a79850f2acab0624352f0504))

## [2.1.0](https://github.com/Falconiere/toolu-ghactions/compare/v2.0.0...v2.1.0) (2026-06-17)


### Features

* **release:** auto-mirror actions to standalone repos for Marketplace ([58f3d3c](https://github.com/Falconiere/toolu-ghactions/commit/58f3d3c16cbbf344cd62e12a28c8f940dfa2ea93))

## [2.0.0](https://github.com/Falconiere/toolu-ghactions/compare/v1.2.3...v2.0.0) (2026-06-17)


### ⚠ BREAKING CHANGES

* **cloudflare-tunnel:** cloudflare-tunnel is no longer published as a Docker image (ghcr.io/falconiere/toolu-ghactions/cloudflare-tunnel). start/stop/wait are composite actions that run on the runner host (Linux/macOS only; container/Windows runners unsupported). Start the app on the runner before `start`, and expose it via the new HOST:PORT inputs.

### Bug Fixes

* **cloudflare-tunnel:** drop live expression from wait input description ([b953699](https://github.com/Falconiere/toolu-ghactions/commit/b953699e432b0074d98bfd8d6dfcd2ceb0ae1a96))
* **cloudflare-tunnel:** gate quick-tunnel readiness on edge registration ([4c33bef](https://github.com/Falconiere/toolu-ghactions/commit/4c33bef2fca70a752901b17768c0819531395caf))
* default to 'approved' verdict when no findings are present ([f333e63](https://github.com/Falconiere/toolu-ghactions/commit/f333e6314c7f02ce6bf1039c541bde66e6142e3f))


### Reverts

* remove example workflows ([433143f](https://github.com/Falconiere/toolu-ghactions/commit/433143fa59b4d61a672358824f9af0e7ce0afa15))


### Code Refactoring

* **cloudflare-tunnel:** run cloudflared on the runner host via composite actions ([fcdeab0](https://github.com/Falconiere/toolu-ghactions/commit/fcdeab0f78a6b4fab623cff3d0ea54d4788d1724))

## [1.2.3](https://github.com/Falconiere/toolu-ghactions/compare/v1.2.2...v1.2.3) (2026-06-16)


### Bug Fixes

* **code-review:** route remaining large jq payloads off argv ([9355dcd](https://github.com/Falconiere/toolu-ghactions/commit/9355dcd8802e92c1ac5f4430d2221ac3cab89add))

## [1.2.2](https://github.com/Falconiere/toolu-ghactions/compare/v1.2.1...v1.2.2) (2026-06-16)


### Bug Fixes

* add root action.yml and rename to Toolu AI Code Review ([dc444bb](https://github.com/Falconiere/toolu-ghactions/commit/dc444bb0326d1e2e0701b6dadec7d9092b403caa))
* **code-review:** avoid jq ARG_MAX overflow on large diffs ([35d954b](https://github.com/Falconiere/toolu-ghactions/commit/35d954b559fdfaf87f3ef335fa96451e0f507d34))

## [1.2.1](https://github.com/Falconiere/toolu-ghactions/compare/v1.2.0...v1.2.1) (2026-06-16)


### Bug Fixes

* add setup-buildx-action for GHA cache backend support ([e4a6cae](https://github.com/Falconiere/toolu-ghactions/commit/e4a6caeee891b1feb874e63da1f2e20e5531d2ae))

## [1.2.0](https://github.com/Falconiere/toolu-ghactions/compare/v1.1.0...v1.2.0) (2026-06-16)


### Features

* publish Docker image to GHCR on release ([2805583](https://github.com/Falconiere/toolu-ghactions/commit/280558325a77ffda92f00d2fb4fc9af6d1b31117))

## [1.1.0](https://github.com/Falconiere/toolu-ghactions/compare/v1.0.2...v1.1.0) (2026-06-16)


### Features

* **code-review:** apply PR verdict label chips ([bb696d0](https://github.com/Falconiere/toolu-ghactions/commit/bb696d0c4104ff4a1205910911488e3a66a02eb3))


### Bug Fixes

* **code-review:** bound shallow fetches and encode label path ([52ed4ef](https://github.com/Falconiere/toolu-ghactions/commit/52ed4ef5af41dd36a9821a274520743ba5dbd3bf))
* **code-review:** resolve merge-base on shallow checkouts ([0ec9457](https://github.com/Falconiere/toolu-ghactions/commit/0ec945776c164ef7f77a051e9475d71e71bbcf99))

## [1.0.2](https://github.com/Falconiere/toolu-ghactions/compare/v1.0.1...v1.0.2) (2026-06-16)


### Features

* **code-review:** parallel multi-dimension review with inline suggestions ([#3](https://github.com/Falconiere/toolu-ghactions/issues/3)) ([8beac4d](https://github.com/Falconiere/toolu-ghactions/commit/8beac4d54f1fcb255689fbf4eb3f3d4a169f870e))

## [1.0.1](https://github.com/Falconiere/toolu-ghactions/compare/v1.0.0...v1.0.1) (2026-06-16)


### Bug Fixes

* **code-review:** support env: block for OPENROUTER_API_KEY ([6671fb0](https://github.com/Falconiere/toolu-ghactions/commit/6671fb0e540d32c55fabf93ab96638017f9d3d3e))

## 1.0.0 (2026-06-16)

### Features

* **code-review:** initial release — Docker-based GitHub Action
  * 7-dimension review checklist (correctness, security, performance, test coverage, doc accuracy, tight assertions, migration warnings)
  * OpenRouter API integration with structured JSON response format
  * In-progress → verdict comment lifecycle with edit-in-place
  * Diff truncation and file-count skip for large PRs
  * Binary file detection and exclusion
  * Regex fallback when LLM returns non-JSON
  * Machine-readable verdict labels: `` `agent-merge-approved` `` and `` `agent-request-changes` ``
  * Compatible with `parse-verdict.sh` / `pr-babysit` ecosystem

## Changelog

All notable changes to `Falconiere/toolu-ghactions` are documented here.

This file is managed by [release-please](https://github.com/googleapis/release-please).
Entries are generated automatically from [Conventional Commits](https://www.conventionalcommits.org/) — do not edit by hand.
