# Changelog

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
