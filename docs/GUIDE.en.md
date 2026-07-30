# omp-antigravity-pro: complete guide

[Main README](../README.md) | [Русская версия](GUIDE.ru.md)

## 1. Purpose

`omp-antigravity-pro` is an Oh My Pi extension for the built-in `google-antigravity` provider. It corrects the Antigravity Gemini 3.6 Flash request contract without replacing OMP's authentication, account scheduler, request transport, or stream parser.

The extension exists because Antigravity's production Cloud Code Assist endpoint uses numeric thinking budgets and effort-specific wire-model IDs for Gemini 3.6 Flash. An older catalog may describe the same model with Google's `thinkingLevel` mode, which is not the captured Antigravity wire behavior and can lead to empty responses.

## 2. Design

```mermaid
flowchart LR
    A[OMP session] --> B[OMP AuthStorage]
    B --> C[google-antigravity provider]
    C --> D[antigravity-pro API adapter]
    D --> E[OMP streamGoogleGeminiCli]
    E --> F[daily-cloudcode-pa.googleapis.com]
    F --> E
    E --> G[OMP SSE events and usage]
```

The provider ID remains `google-antigravity`. This is deliberate: existing OAuth credential rows, `/usage`, account cooldowns, session stickiness, and failover all remain associated with the same provider.

The extension registers a separate custom API ID, `antigravity-pro`, because OMP reserves built-in API identifiers. Before delegation, the adapter restores the stock `google-gemini-cli` API and the production Antigravity endpoint on the wire model.

### Owned by this extension

- projecting the installed Antigravity catalog onto `antigravity-pro`;
- adding Gemini 3.6 Flash when an older installed catalog does not contain it;
- selecting Gemini 3.6 Flash wire-model IDs by effort;
- converting Gemini 3.6 Flash effort to a numeric thinking budget;
- forcing the production daily endpoint;
- adapting OMP's generic stream options to the stock Google transport.

### Still owned by OMP

- OAuth login and refresh;
- credential persistence and multiple accounts;
- session-scoped account selection;
- quota state and cooldowns;
- replay-safe credential retry;
- request envelopes and tool schemas;
- HTTP, SSE parsing, stream timeouts, empty-stream retries, and aborts;
- `thoughtSignature`, token usage, and cost calculation.

## 3. Requirements

- Oh My Pi 17.x;
- Node.js 20 or newer for dependency installation and type checking;
- a Google Antigravity OAuth account configured in OMP;
- Bun for development tests only.

The extension was runtime-tested with `omp/17.2.0` while the installed OMP peer packages reported `17.0.1`.

## 4. Installation

Install directly from GitHub:

```bash
omp plugin install github:ART1KZ/omp-antigravity-pro
```

Check plugin health:

```bash
omp plugin list
omp plugin doctor
```

Verify the provider catalog:

```bash
omp models google-antigravity
```

The list should include:

```text
google-antigravity/gemini-3.6-flash
```

### Local development link

```bash
git clone https://github.com/ART1KZ/omp-antigravity-pro.git
cd omp-antigravity-pro
npm install
omp plugin link . --scope user
```

A linked plugin reloads from the working directory and does not require reinstalling after every source edit.

## 5. Authentication and multiple accounts

The extension does not write credential files and does not maintain a plaintext account pool. It reuses the stock Google Antigravity login and refresh functions.

If you already use `google-antigravity`, your existing accounts remain under the same provider ID. Otherwise:

1. start `omp`;
2. run `/login`;
3. select Google Antigravity;
4. finish the browser OAuth flow;
5. repeat the login flow if you want to add another account.

The Cloud Code transport needs both an access token and `projectId`. The extension serializes the OMP OAuth record into the structured credential expected by the stock transport. If an old credential has no `projectId`, the extension fails with an explicit re-login message instead of sending a broken request.

### Retry and failover behavior

OMP, not this extension, drives credential recovery:

- ordinary `401`: refresh the same account first, then switch to a sibling if necessary;
- invalidated credential or account/quota limit: rotate directly to a sibling account;
- retry occurs only while replay is safe, before response content has escaped to the caller;
- attempted credentials are bounded and cannot loop indefinitely.

Inspect provider quota state with:

```bash
omp usage
```

## 6. Models and thinking

The extension starts with the complete bundled `google-antigravity` catalog from the installed OMP package. It preserves model names, capabilities, input types, costs, limits, headers, premium multipliers, and thinking metadata, then switches each projected model to the custom API.

For installed catalogs that predate Gemini 3.6 Flash, a compatibility model is derived from the installed Gemini 3.5 Flash runtime model. Derivation preserves resolved compatibility metadata rather than constructing an incomplete model from scratch.

### Gemini 3.6 Flash

| User effort | Wire model ID | `thinkingBudget` |
| --- | --- | ---: |
| `minimal` | `gemini-3.6-flash-low` | 1,000 |
| `low` | `gemini-3.6-flash-low` | 1,000 |
| `medium` | `gemini-3.6-flash-medium` | 4,000 |
| `high` | `gemini-3.6-flash-high` | 10,000 |

Gemini 3.6 Flash requires an effort. Run it with, for example:

```bash
omp --model google-antigravity/gemini-3.6-flash --thinking medium
```

Other Antigravity models keep their installed OMP thinking semantics. Models using Google's level protocol still receive `thinkingLevel`; budget-mode models receive `thinkingBudget`.

## 7. Request lifecycle

1. OMP selects the `google-antigravity` model and account.
2. OMP resolves the account to a structured credential.
3. The custom API adapter receives the model, context, and generic stream options.
4. The adapter resolves the wire-model ID and thinking configuration.
5. It forces `antigravityEndpointMode: "production"` and restores the stock `google-gemini-cli` API.
6. `streamGoogleGeminiCli` builds the Cloud Code Assist envelope and posts to:

   ```text
   https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
   ```

7. OMP parses SSE events and forwards text, thinking, tool calls, signatures, usage, errors, and completion.
8. If a retryable auth/quota failure occurs before replay-unsafe output, OMP asks its credential resolver for a refreshed or sibling account and repeats the request.

The extension never falls back to the sandbox endpoint.

## 8. Caching

Caching must be measured, not assumed.

The extension does not reorder tools, rewrite the system prompt, modify history, or normalize user content. Therefore it preserves a stable prefix exactly as OMP supplied it. This avoids destroying a server-side cache opportunity.

However, neither this extension nor the stock OMP Antigravity transport creates an explicit cached-content resource. The transport only reads Antigravity's response field:

```text
usageMetadata.cachedContentTokenCount
```

OMP exposes that value as:

```text
usage.cacheRead
```

Consequences:

- `cacheRead > 0`: the server reported cached input tokens;
- `cacheRead = 0`: no cache hit was reported;
- `cacheWrite` remains `0` because this transport has no explicit cache-write operation;
- identical prompts do not guarantee identical cache behavior;
- no fixed cache-hit percentage or quota saving is promised.

### How to measure

Run a request in JSON mode:

```bash
omp \
  --model google-antigravity/gemini-3.6-flash \
  --thinking medium \
  --mode json \
  --no-tools \
  --no-skills \
  --no-rules \
  --no-session \
  -p "Your repeated prompt"
```

Find the assistant `message_end` event and inspect:

```json
{
  "usage": {
    "input": 3491,
    "cacheRead": 0,
    "cacheWrite": 0
  }
}
```

Only a positive `cacheRead` is evidence of a hit. For meaningful experiments, use a sufficiently long identical prefix, the same model and effort, and unchanged system prompts/tools. Record multiple runs because implicit server caching is not deterministic or contractually guaranteed.

## 9. Troubleshooting

### Gemini 3.6 Flash is missing

```bash
omp plugin list
omp plugin doctor
omp models google-antigravity
```

Reinstall if the plugin is disabled or absent:

```bash
omp plugin uninstall omp-antigravity-pro
omp plugin install github:ART1KZ/omp-antigravity-pro
```

### `projectId` is missing

The stored OAuth record is incomplete. Start OMP, run `/login`, and authenticate Google Antigravity again. Do not manually edit credential storage.

### Another Antigravity extension is installed

Two extensions overriding `google-antigravity` can be load-order dependent. Disable or uninstall the other override, then run `omp plugin doctor` and check the catalog again.

### Empty response

Confirm that you selected `google-antigravity/gemini-3.6-flash` and a supported effort. Run with JSON output to inspect the terminal error. The extension already pins production routing and numeric Gemini 3.6 budgets; persistent empty responses can still originate from upstream availability, account eligibility, or model rollout state.

### Quota errors

Run `omp usage`. OMP rotates only among configured, eligible sibling credentials. If every account is limited, wait for reset or add another authorized account.

## 10. Security model

- no custom credential database;
- no plaintext account-pool JSON;
- no token logging;
- no custom OAuth client or callback server;
- no third-party runtime dependencies bundled by this package;
- external input remains validated by OMP's transport and OAuth parser.

Treat JSON-mode session logs as potentially sensitive because prompts and model output are included even though OAuth tokens are not.

## 11. Development and verification

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run pack:check
```

The tests verify:

- complete catalog preservation and Gemini 3.6 fallback;
- numeric budgets and wire routing;
- production-only endpoint selection;
- context, messages, tools, and diagnostics passthrough;
- structured OAuth credentials and missing-project validation;
- stock SSE parsing, usage, and `thoughtSignature` forwarding;
- replay-safe `401` refresh;
- direct sibling failover after a quota response.

A live smoke test can be run with:

```bash
omp \
  --model google-antigravity/gemini-3.6-flash \
  --thinking medium \
  --no-tools \
  --no-skills \
  --no-rules \
  --no-session \
  -p "Reply with exactly: OK"
```

## 12. Update and removal

Update:

```bash
omp plugin upgrade omp-antigravity-pro
```

Remove:

```bash
omp plugin uninstall omp-antigravity-pro
```

Removing the extension does not intentionally delete the stock `google-antigravity` OAuth accounts. OMP resumes using whichever provider implementation remains registered.
