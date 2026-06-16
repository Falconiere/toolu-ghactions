# Product

## Register

product

## Users

Developers integrating AI code review into their CI/CD pipeline. They discover this repo on GitHub Marketplace or via toolu's ecosystem. Their context: evaluating whether to trust an automated reviewer with their PRs, reading the README to understand capabilities, inputs, and integration cost (one YAML block). Power users also read source to contribute or extend.

## Product Purpose

Publishable GitHub Actions that bring the toolu review methodology to any repository. The code-review action replaces the private `Falconiere/workflows` reusable workflow with a first-class, marketplace-discoverable Docker action. The monorepo structure allows future actions (claude-mention, etc.) to share conventions and utilities.

Success: a developer pastes 10 lines of YAML, adds their OpenRouter key, and gets structured AI code review on every PR — complete with a review plan, targeted findings per dimension, and a machine-readable verdict that `pr-babysit` / `parse-verdict.sh` can act on.

## Brand Personality

**Utilitarian, sharp, confident.**

- Utilitarian: every word in the README earns its place. No marketing prose, no buzzwords. Show the YAML, show the output, explain the inputs.
- Sharp: precise technical communication. Correct shell syntax in examples. Exact environment variable names. No hand-waving about "AI-powered insights."
- Confident: the tool knows what it does and doesn't do. Clear about limitations (diff truncation, file limits, OpenRouter dependency). No hedging.

## Anti-references

- **Over-designed READMEs** with gradient banners, emoji bullet-points-as-decorations, and "✨ Features ✨" sections that restate the obvious. The code is the product; the README is documentation.
- **AI buzzword bingo**: "supercharge your workflow," "next-generation review," "AI-powered insights." This tool reviews code against a checklist; say that.
- **The "friendly startup" voice**: excessive exclamation points, "we're excited to announce," emoji-signoffs. Developers evaluating CI tooling want capability, not enthusiasm.

## Design Principles

1. **Show, don't tell.** Every claim about capability has a concrete example — the YAML block, the comment output, the input table.
2. **Precision over persuasion.** Correctness of technical details matters more than rhetorical flourish. A wrong env var name in the README is worse than a boring README.
3. **Self-documenting structure.** The README is scannable: badge → one-liner → quickstart YAML → inputs table → output example → development. A developer in a hurry gets from discovery to integration in under 60 seconds.

## Accessibility & Inclusion

- README is plain Markdown, readable on GitHub, npm, and terminal (curl). No images that require alt text.
- Code blocks use correct language identifiers for syntax highlighting.
- Tables are simple, no nested structures.
- Link text is descriptive ("View all inputs" not "click here").
