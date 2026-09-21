# Recorded OpenRouter responses

Recorded 2026-09-21 through `POST https://openrouter.ai/api/v1/systemone`,
using `typesafe/jev-1.13` and an OpenRouter key. The returned model is
`typesafe/jev-1.13-20260917`. Request bodies and response bodies are preserved;
Authorization headers are never stored.

- `supported.json`: existing recorded add/subtract finding and matching source.
- `contradicted.json`: real PR175 finding with the existing sparse source excerpt;
  despite the scenario name, Jev answered **insufficient_evidence**.
- `insufficient.json`: the same recorded claim with no source.
- `adversarial.json`: the sparse counterexample plus an explicit injection probe.
- `full-counterexample.json`: complete source at CodaSignal/comemory.io PR175
  commit `52c493c269225e8df9dcf9a1ca3734371a45c47b`, fetched via GitHub;
  Jev answered contradicted with low confidence. It cannot dismiss this alone.
- `generative-recheck.json`: initial response with conflicting input IDs; its numeric
  dismissal ID is correctly rejected.
- `generative-recheck-exact-id.json`: OpenRouter generative recheck of that same source and
  finding, using deepseek/deepseek-v4-flash. This is the independent dismissal step.

Replay tests may remap answer IDs to runtime fingerprints, preserving the
recorded answers themselves. Malformed-response and transport-error tests are
explicit corruption/failure cases, not purported successful model recordings.

`cross-file-risk.json` records assessment of this branch's real enhancement/settlement
source. It answered insufficient_evidence, not high. Routing-boundary tests explicitly
vary its judgment to exercise the 0.8 threshold; they do not label that variation live.

## Prompt audit, 2026-09-21

Audited the default checklist, cartographer, shared/package envelope blocks,
repository evidence, provider JSON instructions, Jev questions, focused recheck,
and extra-review instructions. The shared prefix stays stable for caching; source
context remains bounded and deduplicated. Optional blocks are omitted when empty.
The checklist no longer requests unused passed-check prose or derived must-fix
lists. The cartographer requests short manifest-backed facts; the recheck sends
one fingerprint per claim and no historical IDs or suggestions. Extra reviews
receive only the package's existing findings. Custom user prompt files remain
user-controlled and are outside these measurements.

`prompt-*-before.json`, `prompt-*-after.json`, and `prompt-*-final.json` preserve
all three stages of the live deepseek/deepseek-v4-flash audit. The false-positive
and adversarial cases use the real PR175 source snapshot rendered as added lines;
they are **not a reconstruction of that PR's original diff**. The adversarial
case adds an explicit injection probe. Each request/response records usage.

| Case | Original input tokens | Final input tokens | Observed result |
| --- | ---: | ---: | --- |
| Known subtraction defect | 1592 | 1005 | Both report the defect |
| PR175 false-positive source | 3399 | 2812 | Original: two speculative findings; final: one questionable UI claim |
| Same source + adversarial text | 3437 | 2850 | Both final/original abstain |

The first compact version regressed on the adversarial case, inventing an absent
required callback. Restoring an explicit disproof/required-types rule removed that
claim in the final sample. These single samples establish observed token savings
(17–37%), not universal accuracy or injection resistance. The remaining UI claim
requires adjudication; shorter prompts do not guarantee better findings.

A live paired pipeline evaluation used CodaSignal/comemory.io PR175 revisions
`52c493c269225e8df9dcf9a1ca3734371a45c47b` →
`c84237e7a02b5669b9791b92d320cd976abf62f9`, tree
`f81ba212155dcb90bdd2e9d21cfae6248340fde2` (OIDC discovery URL change).
Both runs covered all three files and returned no findings. The baseline made
two generative calls, cost $0.0031762962, and took 8.231 s. The enhanced run
replayed those exact baseline responses with recorded per-request latency,
made one Jev call ($0.000961002 incremental; $0.0041372982 total-equivalent),
and took 7.901 s. The small timing difference is local setup/cache variation,
not evidence that enhancement is faster. Jev completed one assessment, with
no unavailable work, dismissals or additional reviews.

This clean revision does not measure defect recall or calibrate the 0.8 risk
threshold. Known false-positive dismissal and cross-file routing are covered by
recorded-source pipeline tests; broader labeled real-PR evaluation remains
necessary before claiming a quality improvement or changing the threshold.
