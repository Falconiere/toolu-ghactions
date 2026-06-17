# Plan: Code Review v-next — Identity · Memory · @mention

**Spec:** `docs/toolu/specs/2026-06-17-code-review-vnext-identity-memory-mention-design.md` (Approved)
**Memory:** decision `b85f1e67`, spec `71cdedb0`

## Context

The `code-review` action posts as anonymous `github-actions[bot]`, forgets every prior pass (can't say what was fixed vs. still-open vs. new), and only runs on `pull_request`. This adds three additive features to the bash/Docker action: a custom GitHub App identity, comment-local review memory (diff recap + history), and an `@toolu review …` re-trigger — sharing one spine: mint an App token and re-export `GITHUB_TOKEN` (every curl inherits it), and find the sticky comment by a hidden marker (login-agnostic) that also carries the memory state.

## Approach

Chosen design (from the approved spec) — no architecture rewrite, all additive under `code-review/src/`:

- **Token spine:** `mint-app-token.sh` mints once in `main.sh`; `export GITHUB_TOKEN="$APP_TOKEN"` so `post-comment.sh` / `post-review.sh` / `post-label.sh` / reactions inherit identity unchanged. Graceful `github-actions[bot]` fallback via the `&&` list (no `set -e` kill).
- **Marker spine:** `find-sticky-comment.sh` locates the sticky comment by `<!-- toolu-review-state:v1 … -->` (factored out of `post-comment.sh:53-79`, login-agnostic, legacy-header fallback for the one transition run). `review-state.sh` encodes/decodes/diffs the state.
- **Reuse:** fingerprint normalization from `coordinate-findings.sh:38`; codebase-overview injection pattern from `build-prompt.sh:61-64` (steering text injects the same way, into the user prompt only); existing curl+jq+pagination idioms.
- **Resolved-scope correctness:** `review-state.sh diff` takes `scope{in_scope_paths, full_review}`; reports `resolved` only for in-scope paths on a full review; steered/truncated runs suppress it and label the recap "scoped review".

## Critical files

**New:** `code-review/src/mint-app-token.sh`, `find-sticky-comment.sh`, `review-state.sh`, `resolve-event.sh`; `code-review/assets/logo.png`; BATS: `code-review/__tests__/{mint-app-token,find-sticky-comment,review-state,resolve-event}.bats` + fixtures under `code-review/__tests__/fixtures/`.
**Modified:** `code-review/Dockerfile` (+openssl), `action.yml` (new inputs), `src/main.sh` (wiring), `src/fetch-diff.sh` (`REVIEW_HEAD`), `src/build-prompt.sh` (steering block), `src/format-verdict.sh` (branding+recap+history+marker+size-guard; split `render-recap.sh` if it crosses the ceiling), `src/post-comment.sh` (marker find). Docs: `code-review/README.md`, root `README.md`.

## Workstream notes

- **Layout:** one responsibility per file, named after its role. New scripts each ship with their `.bats` in the same step so the gate stays green.
- **Tests (real data, no mocks):** JWT via a locally generated RSA keypair verified with `openssl` (real crypto); HTTP responses via the **existing `stub_curl_with_fixture` helper** (`helpers.bash`) — a PATH `curl` shim returning *recorded real* GitHub payloads (`installation`, `access_tokens`, `collaborators/.../permission`, issue-comments page), the same pattern `post-comment.bats` already uses; `fetch-diff` `REVIEW_HEAD` and `resolve-event`'s `pull/N/head` fetch against a real temp git repo; `review-state diff` against real `coordinate-findings.sh` output. No new stub-server machinery.
- **Injection (crit 12 vs 12a):** sanitization + prompt structure is deterministic → `build-prompt.bats`. Live-model behavior (12a) → an opt-in e2e in `integration.yml` gated on a real provider key; **non-required check** (per `main-branch-protection` — never gate `main` on the flaky E2E).
- **Docs in sync:** release notes are release-please-driven from conventional commits (no manual changelog). README is the user-facing surface to update in the same change.
- **Known nits:** `BOT_LOGO_URL`→`main` raw 404s until the asset merges, so the logo chip is broken on the feature branch's own PR (resolves on merge — accepted). Base ref on `issue_comment` has empty `GITHUB_BASE_REF`, so it must flow `resolve-event`→`INPUT_BASE_BRANCH` (note `fetch-diff.sh:36` only overrides when it equals `"main"`).
- **Open (user-owned, non-blocking):** final `logo.png` art + whether `BOT_LOGO_URL` pins a tag vs `main`; App org ownership + secret provisioning. Plan ships a placeholder logo + `main`-raw default and flags both.

## Steps (machine-readable)

```json
[
  {"id": "1-dockerfile", "title": "Dockerfile: add openssl; confirm gzip/base64 (busybox) present", "check": "grep -qE '(^| )openssl' code-review/Dockerfile && docker build -q -t cr-vnext:test code-review/ >/dev/null"},
  {"id": "2-mint-token", "title": "mint-app-token.sh: build_jwt (RS256, iat backdated ~60s) + exchange_token; both-or-neither creds, [WARN]+empty on misconfig/failure; never log secrets. + mint-app-token.bats (real RSA key, recorded installation/access_tokens fixtures)", "check": "bats code-review/__tests__/mint-app-token.bats"},
  {"id": "3-find-sticky", "title": "find-sticky-comment.sh: paginate issue comments, select latest by created_at matching the marker (login-agnostic) with legacy '### Code Review' fallback; emit {id,body}. + find-sticky-comment.bats (recorded comments-page fixture, arbitrary bot login + legacy comment)", "check": "bats code-review/__tests__/find-sticky-comment.bats"},
  {"id": "4-review-state", "title": "review-state.sh {encode,decode,diff}: marker base64(gzip(json)); decode fail-safe to empty on corrupt/truncated; fp=sha1(path\\0category\\0normalize(text)[0:200]) line-excluded; diff honors scope{in_scope_paths,full_review} for resolved. + review-state.bats (real coordinate output; roundtrip, line-drift=open, out-of-scope/steered suppress resolved, history cap 10)", "check": "bats code-review/__tests__/review-state.bats"},
  {"id": "5-resolve-event", "title": "resolve-event.sh: classify pull_request vs issue_comment; bot-author + phrase short-circuit BEFORE permission API; permission gate (admin|write, floor MIN_TRIGGER_PERMISSION) FAIL-CLOSED (any non-2xx/unparseable permission response → not permitted, run=false); resolve base via /pulls/{n}; git fetch pull/{n}/head→review_head; full_review + sanitized instruction; 👀/👎 reactions. + resolve-event.bats (recorded event payloads + permission fixture via stub_curl_with_fixture; fail-closed case; pull/N/head fetch on a real temp git repo)", "check": "bats code-review/__tests__/resolve-event.bats"},
  {"id": "6-fetch-diff-head", "title": "fetch-diff.sh: add REVIEW_HEAD env (default HEAD) across diff, merge-base, AND deepen loop (lines 55-74). Extend fetch-diff.bats with a REVIEW_HEAD case on a real temp git repo", "check": "bats code-review/__tests__/fetch-diff.bats"},
  {"id": "7-build-prompt-steer", "title": "build-prompt.sh: INPUT_REVIEW_INSTRUCTION sanitized (strip <<<,>>>,REQUEST,fences; cap 500) into UNTRUSTED user-prompt block + post-diff schema reaffirmation; system checklist unchanged. Extend build-prompt.bats (malicious instruction → contained; system prompt identical)", "check": "bats code-review/__tests__/build-prompt.bats"},
  {"id": "8-format-verdict", "title": "format-verdict.sh: BOT_NAME+BOT_LOGO_URL header (both token paths); recap (resolved/open/new, 'scoped review' label when not full_review) when prior state exists, none on first run; collapsed history <details> (last 10); append encoded marker; body-size guard truncates findings but ALWAYS preserves marker. REVIEW_MEMORY=false skips recap/history/marker entirely. Split render-recap.sh if file crosses ceiling. Extend format-verdict.bats (incl. REVIEW_MEMORY=false → no recap/marker)", "check": "bats code-review/__tests__/format-verdict.bats"},
  {"id": "9-post-comment-marker", "title": "post-comment.sh: locate sticky via find-sticky-comment.sh (accept optional STICKY_COMMENT_ID to skip re-search), PATCH/POST unchanged. Update post-comment.bats for marker-based dedup + legacy fallback", "check": "bats code-review/__tests__/post-comment.bats"},
  {"id": "10-main-wiring", "title": "main.sh: mint token→export GITHUB_TOKEN; resolve-event — on run=false write verdict=skip + findings-count=0 to GITHUB_OUTPUT then exit 0 (no comment posted); else export INPUT_BASE_BRANCH/REVIEW_HEAD/INPUT_REVIEW_INSTRUCTION + full_review; after coordinate → find-sticky-comment → review-state decode+diff(scope) → format-verdict → post-comment(STICKY_COMMENT_ID). Extend main.bats end-to-end with state/recap path + the run=false early-exit-sets-outputs case (real fixtures + fake provider)", "check": "bats code-review/__tests__/main.bats"},
  {"id": "11-action-yml", "title": "action.yml: add inputs APP_ID, APP_PRIVATE_KEY, TRIGGER_PHRASE (@toolu), MIN_TRIGGER_PERMISSION (write), BOT_NAME (Toolu — Code Review), BOT_LOGO_URL (main raw), REVIEW_MEMORY (true)", "check": "npx --yes @action-validator/cli code-review/action.yml"},
  {"id": "12-logo-asset", "title": "Add placeholder code-review/assets/logo.png (flag: user replaces with final art)", "check": "test -f code-review/assets/logo.png"},
  {"id": "13-docs", "title": "code-review/README.md: new inputs table, issue_comment trigger + required workflow permissions: AND concurrency: blocks + example, App creation/least-priv perms/secrets, security gate, memory recap+history; update root README.md if it advertises the bot surface", "check": "grep -q 'APP_ID' code-review/README.md && grep -q 'issue_comment' code-review/README.md && grep -q 'TRIGGER_PHRASE' code-review/README.md && grep -q 'permissions:' code-review/README.md && grep -q 'concurrency:' code-review/README.md"},
  {"id": "14-full-gate", "title": "Green gate: shellcheck + action-validator + full bats + docker build", "check": "shellcheck --severity=warning code-review/src/*.sh && npx --yes @action-validator/cli code-review/action.yml && bats code-review/__tests__/*.bats && docker build -q -t cr-vnext:gate code-review/ >/dev/null"},
  {"id": "15-injection-e2e", "title": "integration.yml: opt-in e2e injection probe (one real provider, key secret) asserting a malicious instruction can't flip verdict/break schema — NON-required check (crit 12a)", "check": "grep -q 'injection' .github/workflows/integration.yml"}
]
```

## Verification

End-to-end proof:
1. **Gate** (step 14) green: `shellcheck` + `action-validator` + all BATS + `docker build`.
2. **Identity:** run the action with `APP_ID`/`APP_PRIVATE_KEY` on a real PR → verdict comment authored by the App (custom name + logo chip); unset → `github-actions[bot]` with branded body. Misconfig (one cred) → `[WARN]` in log + fallback.
3. **Memory:** push twice to a PR → second comment shows ✅ resolved / 🔁 open / ⚠️ new and a history table; decode the marker from the comment body → valid state JSON.
4. **Mention:** comment `@toolu review focus on auth` as a write+ user → 👀 reaction, scoped re-review (recap labeled "scoped", no false "resolved"); as a read-only user → 👎, no run; bot-authored or phrase-less comment → no permission API call, no run.
5. **Injection:** integration probe (step 15) confirms a crafted `instruction` neither flips the verdict nor breaks the JSON schema.

Hand off to `plan-review`.
