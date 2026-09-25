# Cantelop Claude Code API

An HTTP API for running Claude Code on behalf of your users, built on [Cantelop](https://console.cantelop.dev/docs) with `@cantelop/sdk@0.12.0`.

Each user signs in to Claude Code with **their own** Claude subscription through Claude Code's native login. Your application only verifies who the user is. It never sees, stores, or proxies Claude credentials. Claude Code runs as Anthropic's unmodified native binary inside a Cantelop Sandbox.

## How it works

![Cantelop Claude Code architecture](docs/architecture.png)

- **One durable Workspace per user.** The Workspace is derived from the verified JWT subject, so callers can never select another user's Workspace. Claude Code keeps its native auth state in `/workspace/.claude` (via `CLAUDE_CONFIG_DIR`). Application state lives in `/workspace/.cantelop`.
- **One disposable Sandbox per active Session.** Cantelop starts a Sandbox on demand, mounts the user's Workspace at `/workspace`, and releases it when idle. The Workspace survives, so a new Sandbox picks up the existing Claude login.
- **Concurrent Sessions share a Workspace.** They share login and files but keep separate Claude conversations, queues, and configuration. Sessions can edit the same files, so callers must coordinate conflicting work.

Cantelop handles Sandbox lifecycle, Workspace mounts, message serialization, activity supervision, and event transport over SSE/WebSocket.

### Claude Code hosting terms

This project follows Anthropic's conditions for [offering Claude Code in a product](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products) and its [credential rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). It runs the published binary unchanged, keeps every built-in auth method, and has each user authenticate and pay under their own Anthropic or provider agreement. It never injects an `ANTHROPIC_API_KEY`.

Usage is billed according to the user's plan and Anthropic's current rules. Included limits, Agent SDK or `claude -p` credits, and enabled usage credits may all apply. This project does not guarantee that a run avoids usage credits. It is not legal approval, so review the full terms for your deployment. Terms last checked September 18, 2026.

## Quick start

The quick start deploys the API. To connect it to your product, continue with [Embed in your application](#embed-in-your-application).

### Prerequisites

- Node.js 22+, Bun, and Docker with `linux/amd64` support
- Cantelop CLI 0.11.2+ (SDK build protocol 5):

  ```sh
  brew install stepandel/tap/cantelop
  # or, without Homebrew:
  curl -fsSL https://console.cantelop.dev/install.sh | sh
  ```

- A server that signs ES256 JWTs for your users, such as your identity provider or your own backend. This API only verifies tokens; it never issues them. See [Application tokens](#application-tokens).

### 1. Clone and configure

```sh
git clone https://github.com/stepandel/claude-code-api.git
cd claude-code-api
npm ci
cp .env.example .env
```

Set the values in `.env`:

| Variable | Value |
| --- | --- |
| `AUTH_PUBLIC_JWK` | Public P-256 JWK that verifies your application JWTs. Never the private key. |
| `AUTH_ISSUER` | Exact JWT `iss` value. |
| `AUTH_AUDIENCE` | Exact JWT `aud` value. Defaults to `cantelop-claude-api`. |

If you do not have a signing key yet, generate one:

```sh
npm run keys -- auth.private.jwk.json
```

This writes the private JWK to `auth.private.jwk.json` (mode 600, ignored by git) and prints the `AUTH_PUBLIC_JWK=…` line for `.env`. Move the private JWK into the secret store of the server that mints tokens, and delete the local copy.

These values authenticate callers to *your application* only. Claude authentication happens later, per user. Never add an Anthropic API key, Claude token, JWT signing key, or shared provider credential to this App.

The App slug is the `app` field in `cantelop.json` (default `cantelop-claude-api`). Change it now if you need a different or environment-specific slug.

### 2. Check and build

```sh
npm run check
npm test
npm run build
```

`npm run build` runs `cantelop build`. It builds the Edge API (`src/api.ts`) and the Session image (`src/session.ts` + `docker/Dockerfile`) without publishing them.

### 3. Run locally (optional)

```sh
npm run dev
```

This runs `cantelop dev --container`, so Sessions use the real Docker image with Claude Code and the login helper installed. Use the printed base URL as `BASE_URL`.

### 4. Deploy

```sh
cantelop login
cantelop app create -slug cantelop-claude-api   # first deploy only; use your slug
cantelop env sync --env-file .env --dry-run
cantelop env sync --env-file .env
cantelop doctor
cantelop deploy --dry-run
cantelop deploy
cantelop releases --json
```

Wait for the new release to become active before sending traffic. See the [Cantelop docs](https://console.cantelop.dev/docs) for logs, traces, rollback, and troubleshooting.

### 5. Smoke test

```sh
curl "$BASE_URL/health"   # {"ok":true}
```

Then connect a Claude account with the [Claude authentication](#claude-authentication) protocol and follow the [example workflow](#example-workflow).

Before production, also verify tenant isolation with at least two identities. Confirm that a fresh Sandbox reuses each user's Claude login from their Workspace.

## Embed in your application

Your backend calls this API directly with a token for the signed-in user. Your UI only needs two things for Claude sign-in: a link to open, and a field for the code Claude shows.

### Application tokens

Tokens must be signed on your server. A token signed in the browser lets anyone forge any identity, because the signing key would ship to every visitor. The API stores only the public JWK (`AUTH_PUBLIC_JWK`).

- Algorithm `ES256` (P-256). Claims `sub`, `iss`, `aud`, and `exp` are required, and `nbf` is optional.
- `sub` selects the user's Workspace. Use a stable, non-reusable user ID. For anonymous demos, mint a random ID on the server and bind it to the visitor's session.
- A token only has to outlive the call it is used for, or the event stream it opens. Minting a short-lived token per call is fine.
- `npm run keys` generates a suitable key pair.
- Keep the private key in your backend's secret store. Never put it in this App's environment, because Sessions can read App environment variables.

### Connecting Claude

1. `POST /v1/auth` with `{}`. If `authenticated` is `true`, skip ahead.
2. `POST /v1/auth/login` with `{}`. Show the returned `url` to the user and keep the `attemptId`.
3. The user signs in at Anthropic and pastes the code Claude displays into your UI.
4. `POST /v1/auth/login/code` with `{attemptId, code}`. It returns `authenticated: true` once Claude has stored its credentials.

See [Claude authentication](#claude-authentication) for errors, cancellation, and re-authentication.

### Streaming agent output

Agent Sessions report progress as [events](#events). Your backend can consume `/v1/events` directly. To stream events on to a browser, add a same-origin endpoint, because `EventSource` cannot set an `Authorization` header:

- Attach the user's token on the server and validate `sessionId` before forwarding. The API also checks Session ownership.
- Stream the body through unbuffered: set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.
- Forward the browser's `Last-Event-ID` header so reconnects resume.

Subscribe before sending messages so no events are missed. A subscription without a cursor replays the Session's retained events from the beginning, so it is also safe to open the stream and send the first message concurrently. Replay is bounded, so open the stream promptly.

## API

Every `/v1/*` request needs your application JWT:

```
Authorization: Bearer $USER_TOKEN
Content-Type: application/json
```

The token must be ES256-signed with `sub`, `iss`, `aud`, and `exp` claims matching the App configuration. `nbf` is optional. Tokens are never accepted in query strings. Session ownership is checked before every dispatch, request, and event subscription.

| Method | Route | Body | Response |
| --- | --- | --- | --- |
| GET | `/health` | — | `200 {"ok":true}` (public) |
| POST | `/v1/auth` | `{}` | `200` Claude auth status |
| POST | `/v1/auth/login` | `{force?}` | `200 {attemptId, url, expiresAt}`, or status if already signed in |
| POST | `/v1/auth/login/code` | `{attemptId, code}` | `200` Claude auth status |
| POST | `/v1/auth/cancel` | `{attemptId}` | `200 {type: "auth.cancelled", attemptId}` |
| POST | `/v1/auth/logout` | `{}` | `200` signed-out status |
| POST | `/v1/sessions` | Session configuration | `202 {sessionId, receiptId}` |
| POST | `/v1/messages` | `{sessionId, text, mode?, messageId?}` | `202 {sessionId, receiptId, messageId}` |
| POST | `/v1/cancel` | `{sessionId, messageId}` | `202 {sessionId, receiptId, messageId}` |
| POST | `/v1/snapshot` | `{sessionId}` | `200` Session summary |
| GET | `/v1/events?sessionId=…` | — | SSE or WebSocket event stream |

**Synchronous vs. asynchronous.** Auth calls and snapshots return their result directly with HTTP 200. They wait up to 30 seconds (45 for login and logout), then return `504` with `code: "request_wait_timeout"`. A timeout stops the wait, not the work. Session and message calls return `202` and report outcomes as events.

**Errors.** Failures return a JSON body with `error` and, for platform failures, a machine-readable `code`. See [Error reference](#error-reference).

**Limits.** POST bodies are capped at 48 KiB of encoded JSON. Message text and system prompts are capped at 32 KiB of UTF-8. Fetch larger context through MCP, or split the work across messages.

### Example workflow

Create a Session:

```sh
curl "$BASE_URL/v1/sessions" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "sonnet",
    "systemPrompt": "Use the available project tools.",
    "maxTurns": 24,
    "tools": ["Read", "Glob", "Grep"],
    "allowedTools": ["Read", "Glob", "Grep", "mcp__project__search"],
    "mcps": {
      "project": {
        "type": "http",
        "url": "https://tools.example.com/mcp",
        "headers": {"Authorization": "Bearer SESSION_SCOPED_TOKEN"}
      }
    }
  }'
```

Creation is asynchronous. Watch for `session.ready` and `auth.status` events. Save the returned `sessionId` as `SESSION_ID`, then subscribe and send work:

```sh
curl -N "$BASE_URL/v1/events?sessionId=$SESSION_ID" \
  -H "Authorization: Bearer $USER_TOKEN"

curl "$BASE_URL/v1/messages" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"text\":\"Inspect this project\",\"mode\":\"queue\"}"
```

A Session can be created before the user signs in to Claude. Each turn rechecks authentication and fails without calling the model if the user is signed out.

### Session configuration

Configuration is immutable and survives Sandbox reactivation. To change the model, prompt, tools, MCP servers, or run-scoped tokens, create a new Session.

| Field | Description |
| --- | --- |
| `tools` | Built-in Claude Code tools exposed to the model. Defaults to none. |
| `allowedTools` | Tool names or native permission rules that may run unattended, such as `mcp__docs__search` or `mcp__project__*`. Everything else is denied (`dontAsk`), and there is no blanket bypass. |
| `mcps` | Map of server name to `http`, `sse`, or `stdio` MCP config. Tools appear as `mcp__<server>__<tool>`. |
| `model` | Optional model alias or ID made of 1–128 characters from `[A-Za-z0-9._-]`, starting with a letter or digit. Omit it or use `default` for Claude's default. Availability depends on the user's account. |
| `systemPrompt` | Optional non-blank replacement for Claude's default system prompt (not appended). |
| `maxTurns` | Optional per-message turn limit from 1 to 100. Hitting the limit marks the message failed. |

MCP servers:

```json
{
  "docs":  {"type": "http",  "url": "https://your-mcp.example/mcp", "headers": {"Authorization": "Bearer …"}},
  "local": {"type": "stdio", "command": "node", "args": ["/workspace/tools/server.js"], "env": {}}
}
```

HTTP/SSE servers run remotely and only need to be reachable from the Sandbox. Stdio servers and their dependencies must exist inside the Sandbox. MCP settings, including headers and secrets, are persisted in the user's Workspace. Custom tools are MCP tools, not JSON function declarations.

### Messages

- `mode: "queue"` (default) runs the message FIFO after pending work.
- `mode: "steer"` interrupts the active turn, waits for it to stop, then runs this message before pending work. Repeated steers run newest-first. This is interrupt-and-resume, not mid-generation injection.

Each response includes a platform `receiptId` and an application `messageId`. To retry idempotently, pass your own UUID `messageId`. Reusing it with different text emits `message_id_conflict`.

Cancel a queued or running message:

```sh
curl "$BASE_URL/v1/cancel" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"messageId\":\"$MESSAGE_ID\"}"
```

Finished messages are unaffected. Tool effects that already completed cannot be undone.

### Events

`/v1/events` returns SDK-native SSE. WebSocket clients use the `cantelop.events.v1` subprotocol. Browser `EventSource` and `WebSocket` cannot set an `Authorization` header, so browsers need a [same-origin endpoint](#streaming-agent-output).

Each application event arrives inside a Cantelop delivery envelope. **Read the event from `data`:**

```
id: <stream_id>:<sequence>
data: {"stream_id":"…","sequence":7,"session_id":"…","message_id":"…","created_at":"…","data":{"type":"message.status",…}}
```

Stream errors are not wrapped. They arrive as `event: error` frames with a bare code, after which the server closes the stream:

```
event: error
data: {"code":"event_stream_reset"}
```

`event_stream_reset` and `event_cursor_expired` mean replay cannot continue: fetch a snapshot. `event_broker_unavailable` is transient, so reconnect with `Last-Event-ID`.

- Replay is bounded. Resume with `Last-Event-ID`, or with the `stream_id`/`after` query parameters.
- Claude output arrives as `claude` events. Large frames are split into `claude.fragment` events: concatenate `json` by `eventId` and `index`, then parse once all `total` fragments arrive.
- Events contain private model output and may include user data.

After a stream reset, fetch a snapshot:

```sh
curl "$BASE_URL/v1/snapshot" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\"}"
```

This returns `{sessionId, type: "session.state", configured, messages, truncated}` with the latest 50 messages. Prompt previews are capped at 256 characters. It is a summary, not a transcript API.

## Claude authentication

Each user signs in to their own Claude account. The API runs the unmodified `claude auth login` in the user's auth Sandbox, returns the Anthropic sign-in link it prints, and types the user's code into it. Claude runs the OAuth exchange itself and stores its own credentials in the Workspace. The application implements no OAuth callback and never reads Claude's tokens.

### Login

```sh
curl "$BASE_URL/v1/auth/login" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
# {"sessionId":"…:auth","type":"auth.login","attemptId":"…","url":"https://claude.com/cai/oauth/authorize?…","expiresAt":1790000000000}

curl "$BASE_URL/v1/auth/login/code" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"attemptId\":\"$ATTEMPT_ID\",\"code\":\"$CODE\"}"
# {"sessionId":"…:auth","type":"auth.status","authenticated":true}
```

- If the user is already signed in, `/v1/auth/login` returns `{type: "auth.status", authenticated: true}` and starts nothing. Pass `force: true` to sign in again anyway, for example after `auth.required`.
- A user has at most one attempt. Calling `/v1/auth/login` again while it is open returns the same `attemptId` and `url`, so the call is safe to retry.
- An attempt lasts 10 minutes (`expiresAt`, in epoch milliseconds). It ends when Claude exits, on cancel, on logout, or when the Sandbox is replaced.
- The code must be 1–2,048 printable ASCII characters without spaces. If Claude does not accept it, the call returns `code_rejected` and the attempt stays open for another try.
- Once authentication is confirmed, `/v1/auth/login/code` and `/v1/auth` stop the auth Sandbox before returning. A failed stop is returned as an error so the caller can retry. Credentials remain in the Workspace.
- `POST /v1/auth/cancel` with `{attemptId}` ends the attempt and reaps the login process. Cancelling an attempt that is not running is a no-op.

Only complete HTTPS links to Anthropic domains (`claude.ai`, `claude.com`, `anthropic.com`) are returned. The raw terminal output stays in Sandbox memory and is never logged, emitted, or persisted. The PTY helper runs with input echo off and discards stderr.

### Login code handling

The code the user pastes travels through Cantelop's message transport, which may retain payloads. It is not encrypted separately, because it cannot be used on its own. Claude's login uses PKCE (`S256`), so the code is single-use, short-lived, and redeemable only with the verifier held by the Claude process in the Sandbox. Keep TLS on and apply your own logging policies to the code on your side.

### Re-authentication

Claude Code refreshes its own credentials in the Workspace. A native `authentication_failed` error or an explicit signed-out status emits `auth.required` with the affected message ID. Status-command failures, billing errors, rate limits, and network errors are not treated as sign-outs. An internal retry that succeeds emits nothing.

When a client receives `auth.required`, it should pause new work for that user and offer sign-in with `force: true`. Resume only after `/v1/auth/login/code` returns `authenticated: true`. Interrupted work is never replayed automatically.

### Sign-out

`POST /v1/auth/logout` cancels any pending login, runs `claude auth logout`, and confirms signed-out status. Only then does it return `{sessionId, type: "auth.status", authenticated: false}`. The auth Sandbox is released as soon as it is idle. Workspace files and conversations are kept. Stop the user's agent tasks first. A timeout does not confirm sign-out, so retry it.

## Error reference

HTTP errors return `{"error": "<message>"}` for request validation, and `{"error": "Operation failed", "code": "<code>"}` for platform failures. The message is intentionally generic. Branch on the status and `code`.

| Status | Code or message | Meaning | Retry? |
| --- | --- | --- | --- |
| 400 | Validation message | Malformed body, unknown field, or invalid value | No, fix the request |
| 401 | `Valid application bearer token required` | Missing, expired, or invalid JWT | After minting a new token |
| 404 | `Session not found` | The Session ID does not belong to the caller | No |
| 404 | `resource_not_found` | Platform resource missing. Fresh-Workspace races are retried inside the API first | Yes, with backoff |
| 413 | `Request too large` | Body over 48 KiB | No |
| 503 | `Application identity is not configured` | `AUTH_*` variables are missing | After fixing configuration |
| 504 | `request_wait_timeout` | A synchronous call stopped waiting; the work may still finish | Yes, calls are idempotent |
| 502/503 | `stop_failed`, other platform codes | Transient platform failure | Yes, with backoff |
| 502 | `request_outcome_unknown` | The platform result could not be read | Yes, calls are idempotent |
| 409 | `login_not_active` | The attempt expired, was cancelled, or already finished | Start a new login, or check `/v1/auth` |
| 422 | `code_rejected` | Claude asked for the code again | Yes, with a corrected code |
| 502 | `login_failed` | Claude printed no sign-in link, or exited without credentials | Start a new login |
| 504 | `login_timeout` | Claude did not respond to the code within 20 seconds; the attempt stays open | Check `/v1/auth` before retrying |

Session commands are asynchronous, so their failures arrive as events:

| Event | Code | Meaning |
| --- | --- | --- |
| `error` | `session_not_configured`, `already_configured` | Session used before `configure`, or configured twice |
| `error` | `message_not_found`, `message_id_conflict`, `session_full` | Bad cancel target, reused `messageId` with different text, or 1,000-message limit |
| `error` | `agent_session_required`, `auth_session_required` | Command sent to the wrong Session kind |
| `auth.required` | — | Claude credentials are missing or expired; offer sign-in |

## Queueing and durability

Cantelop serializes command handlers in each Session's mailbox. Each turn runs as a managed activity, so the mailbox stays responsive and only one turn runs at a time. Cancellation and steering send SIGTERM, then SIGKILL, to the Claude process group and wait for it to exit. A tool that detaches into its own process group can outlive its turn. Terminating the Sandbox is the broader cleanup.

These survive Sandbox loss: configuration, message IDs and statuses, the pending queue, and the Claude conversation ID. They are stored as atomic snapshots under `/workspace/.cantelop`. On reactivation:

- A turn that was running becomes `interrupted` and is **not replayed**, because its tools may already have had effects.
- Queued work resumes.
- Event history is not durable, since Cantelop's stream is bounded and in-memory. Claude keeps its own native transcript. If a Sandbox is lost before that transcript is written, resuming may fail and require a new Session.

A Session holds at most 1,000 messages. This is not a transactional database, and tool execution is not exactly-once.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/api.ts` | Edge API (`defineApi`), JWT verification, Workspace/Session routing, event streaming |
| `src/session.ts` | Session behaviour (`defineSessionBehaviour`), managed turns, queue/steer/cancel, recovery |
| `src/claude.ts` | Claude CLI subprocess, cancellation, stream parsing, tool/MCP settings, auth status |
| `src/state.ts` | Durable Session state under `/workspace/.cantelop` |
| `src/login.ts`, `src/login-process.ts`, `runtime/login-pty.py` | Native login lifecycle, sign-in link extraction, and PTY helper |
| `cantelop.json`, `docker/Dockerfile` | App manifest and Session image |
| `scripts/generate-auth-keys.mjs` | ES256 key pair for application tokens (`npm run keys`) |

### Updating Claude Code

The Dockerfile installs Claude Code **2.1.267** and verifies pinned SHA-256 checksums for Linux amd64 and arm64. Runtime auto-updates are off. To upgrade, update the version and both checksums from Anthropic's release manifest, then run `npm test` and `npm run build`.

### Tests

Tests exercise the real SDK route definitions, JWT and tenant checks, Session dispatch, queue/steer/cancel, durable reactivation, output fragmentation, and subprocess handling. They use fake Claude executables. The login tests drive a fake interactive CLI through the PTY. No test calls a model or uses real credentials. A real sign-in and model turn require a user's own account.

## Production checklist

- [ ] Mint application tokens on your server (see [Application tokens](#application-tokens)).
- [ ] If browsers consume events, proxy them unbuffered and forward `Last-Event-ID` (see [Streaming agent output](#streaming-agent-output)).
- [ ] Use your own identity provider with expiry, key rotation, and revocation. Put only the public JWK in Cantelop. Keep signing keys and tokens out of the repo and runtime environment.
- [ ] Choose your own App slug, issuer, and audience.
- [ ] Add per-user quotas, admission control, and rate limits.
- [ ] Define Workspace retention, backup, and deletion policies.
- [ ] Review Sandbox network access for your MCP services.
- [ ] Never put shared provider credentials or signing keys in App environment variables, because native Sessions can see them.
- [ ] Verify tenant isolation and login reuse across Sandboxes (see [Smoke test](#5-smoke-test)).

## References

- [Cantelop SDK v0.12.0](https://github.com/stepandel/cantelop-sdk/tree/sdk-v0.12.0), verified against GitHub and npm on September 23, 2026
- [Cantelop platform docs](https://console.cantelop.dev/docs)

## License

[MIT](LICENSE)
