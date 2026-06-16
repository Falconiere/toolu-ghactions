# Changelog

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
