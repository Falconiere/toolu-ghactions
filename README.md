# toolu-ghactions

Monorepo of GitHub Actions for the toolu ecosystem.

## Actions

| Action | Path | Description |
|--------|------|-------------|
| **AI Code Review** | [`actions/code-review`](actions/code-review/) | AI-powered PR code review via OpenRouter. Plans a targeted review then executes against a 7-dimension checklist. Posts structured verdict comments compatible with `parse-verdict.sh`. |

## Usage

```yaml
# In your workflow:
- uses: falconiere/toolu-ghactions/actions/code-review@v1
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

## Development

```bash
# Run tests for all actions
bats actions/*/__tests__/*.bats

# Build a specific action's Docker image
docker build -f actions/code-review/Dockerfile -t code-review-action:test .

# Run shellcheck
shellcheck actions/*/src/*.sh
```

## License

MIT
