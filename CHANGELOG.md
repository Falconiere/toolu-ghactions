# Changelog

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
