# Changelog

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
