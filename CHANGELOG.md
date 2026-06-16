# Changelog

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
