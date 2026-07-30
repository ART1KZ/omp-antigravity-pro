# omp-antigravity-pro

[![CI](https://github.com/ART1KZ/omp-antigravity-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/ART1KZ/omp-antigravity-pro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Oh My Pi](https://img.shields.io/badge/Oh%20My%20Pi-17.x-5b5bd6)](https://github.com/can1357/oh-my-pi)

[English guide](docs/GUIDE.en.md) | [Руководство на русском](docs/GUIDE.ru.md)

A focused [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that fixes Google Antigravity Gemini 3.6 Flash wire routing while retaining OMP's native OAuth, account rotation, quota tracking, SSE parser, usage reporting, and session behavior.

## Why

Antigravity's production Cloud Code Assist endpoint expects Gemini 3.6 Flash effort tiers as wire-model IDs with numeric `thinkingBudget` values. Older OMP catalogs can instead describe the model with Google's `thinkingLevel` protocol, which may produce empty responses.

This extension replaces the `google-antigravity` provider in place and delegates requests to OMP's public `streamGoogleGeminiCli` transport. It changes only the Antigravity-specific model projection and thinking options.

## Installation

```bash
omp plugin install github:ART1KZ/omp-antigravity-pro
```

Use your existing Antigravity login, or run OMP and select Google Antigravity from `/login`.

Verify the model is available:

```bash
omp models google-antigravity
```

Run Gemini 3.6 Flash:

```bash
omp --model google-antigravity/gemini-3.6-flash --thinking medium
```

## Gemini 3.6 Flash mapping

| Effort | Wire model | Thinking budget |
| --- | --- | ---: |
| `minimal` | `gemini-3.6-flash-low` | 1,000 |
| `low` | `gemini-3.6-flash-low` | 1,000 |
| `medium` | `gemini-3.6-flash-medium` | 4,000 |
| `high` | `gemini-3.6-flash-high` | 10,000 |

Requests are pinned to `https://daily-cloudcode-pa.googleapis.com`; the sandbox endpoint is never used.

## What remains native to OMP

- OAuth login and token refresh
- encrypted/managed credential storage
- multiple-account selection and session stickiness
- replay-safe `401` refresh and sibling failover
- quota cooldown and `/usage` integration
- request envelope, tools, context, SSE parsing, `thoughtSignature`, usage, aborts, and retries

The extension does not create a second credential pool, rewrite prompts, sort tools, or implement another HTTP/SSE stack.

## Caching: no false promises

This is a transport-correctness extension, not an explicit prompt-cache implementation. It preserves prompts, history, and tools unchanged so it does not make a cache-eligible prefix unstable. OMP reports a server cache hit only when Antigravity returns `cachedContentTokenCount`; that value appears as `usage.cacheRead`.

A repeated request with `cacheRead: 0` is not a cache hit. No fixed hit rate or quota saving is claimed.

See the [English guide](docs/GUIDE.en.md#caching) or [Russian guide](docs/GUIDE.ru.md#кэширование) for verification instructions.

## Compatibility

- OMP CLI: tested with `omp/17.2.0`
- OMP peer packages: tested with `17.0.1`
- Node.js: 20 or newer
- Bun: used for the test suite

## Development

```bash
npm install
npm run check
npm run pack:check
omp plugin link . --scope user
```

The contract suite covers model projection, production endpoint routing, numeric budgets, structured OAuth credentials, stock SSE/usage/signature forwarding, replay-safe `401` refresh, and `429` sibling failover.

## Documentation

- [Complete English guide](docs/GUIDE.en.md)
- [Полное руководство на русском](docs/GUIDE.ru.md)

## License

[MIT](LICENSE) © 2026 ART1KZ
