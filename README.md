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

An embedded integration has three parts: your backend mints application tokens, a same-origin backend adapter forwards API calls and the event stream, and your UI runs the encrypted login protocol inline.

### Application tokens

Tokens must be signed on your server. A token signed in the browser lets anyone forge any identity, because the signing key would ship to every visitor. The API stores only the public JWK (`AUTH_PUBLIC_JWK`).

- Algorithm `ES256` (P-256). Claims `sub`, `iss`, `aud`, and `exp` are required, and `nbf` is optional.
- `sub` selects the user's Workspace. Use a stable, non-reusable user ID. For anonymous demos, mint a random ID on the server and bind it to the visitor's session.
- **Lifetime: at least 15 minutes for interactive login.** A login attempt can last 10 minutes, and the same token is used for terminal input, completion, and every stream reconnect. Alternatively, refresh the token and use the new one for later calls.
- `npm run keys` generates a suitable key pair.
- Keep the private key in your backend's secret store. Never put it in this App's environment, because Sessions can read App environment variables.

### Backend adapter

Browser `EventSource` and `WebSocket` cannot set an `Authorization` header, and the bearer token should not be exposed to page scripts that do not need it. Put a thin same-origin adapter in your backend:

- **Requests:** accept an allow-listed action from the browser, validate its body, attach the user's token, and `POST` to the matching `/v1/*` route. Do not forward arbitrary paths.
- **Events:** proxy `GET /v1/events?sessionId=…` with the token attached. Stream the body through without buffering: set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, and forward the browser's `Last-Event-ID` header so reconnects resume.
- Check the request origin on the adapter, and validate `sessionId` before forwarding. The API also checks Session ownership on every call.

### Subscribe, then start, without deadlocking

Subscribe to events before dispatching login or messages so no events are missed. Behind a proxy, however, the stream's `fetch` may not resolve until the first bytes arrive, and those bytes may only exist after you dispatch. Open the stream and dispatch concurrently, then read the stream:

```ts
const [stream] = await Promise.all([
  fetch(`/api/claude/events?sessionId=${sessionId}`, {cache: 'no-store', signal}),
  post('authStart', {attemptId, publicKey}),
]);
```

This is safe because a subscription without a cursor replays the Session's retained events from the beginning, so events emitted just before it attaches are still delivered. Replay is bounded, so open the stream promptly.

### Inline login

Run the [programmatic login](#programmatic-login) protocol. `src/terminal-crypto.ts` is the reference for the key exchange and frame encryption.

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
| POST | `/v1/auth` | `{}` for status, or a login handshake | `200` status, or `202` receipt |
| POST | `/v1/auth/input` | Encrypted terminal frame | `202` receipt |
| POST | `/v1/auth/cancel` | `{attemptId}` | `202` receipt |
| POST | `/v1/auth/complete` | `{}` | `200` auth status |
| POST | `/v1/auth/logout` | `{}` | `200` signed-out status |
| POST | `/v1/sessions` | Session configuration | `202 {sessionId, receiptId}` |
| POST | `/v1/messages` | `{sessionId, text, mode?, messageId?}` | `202 {sessionId, receiptId, messageId}` |
| POST | `/v1/cancel` | `{sessionId, messageId}` | `202 {sessionId, receiptId, messageId}` |
| POST | `/v1/snapshot` | `{sessionId}` | `200` Session summary |
| GET | `/v1/events?sessionId=…` | — | SSE or WebSocket event stream |

**Synchronous vs. asynchronous.** Auth status, auth completion, logout, and snapshots return their result directly with HTTP 200. They wait up to 30 seconds (45 for logout), then return `504` with `code: "request_wait_timeout"`. A timeout stops the wait, not the work, and these calls are safe to repeat. Everything else returns `202` and reports outcomes as events.

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

`/v1/events` returns SDK-native SSE. WebSocket clients use the `cantelop.events.v1` subprotocol. Browser `EventSource` and `WebSocket` cannot set an `Authorization` header, so browser integrations need a [backend adapter](#backend-adapter).

Each application event arrives inside a Cantelop delivery envelope. **Read the event from `data`:**

```
id: <stream_id>:<sequence>
data: {"stream_id":"…","sequence":7,"session_id":"…","message_id":"…","created_at":"…","data":{"type":"auth.started",…}}
```

Stream errors are not wrapped. They arrive as `event: error` frames with a bare code, after which the server closes the stream:

```
event: error
data: {"code":"event_stream_reset"}
```

`event_stream_reset` and `event_cursor_expired` mean replay cannot continue: fetch a snapshot, and restart any login attempt. `event_broker_unavailable` is transient, so reconnect with `Last-Event-ID`.

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

The API runs the unmodified `claude auth login` in the user's auth Sandbox and relays its terminal. The user opens the Anthropic link it prints, signs in, and enters a completion code if the terminal asks for one. Success is confirmed with `claude auth status`.

Claude runs the OAuth exchange itself and stores its own credentials. The application implements no OAuth callback and never reads Claude's tokens. The terminal is driven by a Python standard-library PTY helper in the runtime image, with input echo off. Render its output as inert text, and only link to Anthropic-domain HTTPS URLs.

### Programmatic login

1. `POST /v1/auth` with `{}` returns `{sessionId, …, type: "auth.status", authenticated}` along with Workspace identifiers.
2. Subscribe to `/v1/events?sessionId=…` **before** starting login. Behind a proxy, open the stream and send step 3 [concurrently](#subscribe-then-start-without-deadlocking).
3. Generate an ephemeral ECDH P-256 key pair. `POST /v1/auth` with `{attemptId: "<uuid>", publicKey: <public JWK>}`. Private JWK fields are rejected. Add `force: true` to start a fresh login even if stale credentials still report signed in.
4. `auth.started` returns the Session's public JWK and `expiresAt`. Derive the AES-GCM key as `src/terminal-crypto.ts` does. `auth.output` events carry `terminalSequence`, `iv`, and `data`. Their AAD is `<attemptId>:output:<terminalSequence>`.
5. Send input to `POST /v1/auth/input` as `{attemptId, sequence, iv, data}`. `sequence` starts at 1, and the AAD is `<attemptId>:input:<sequence>`. Use a random 12-byte IV and standard base64. Frames are limited to 4 KiB each and 32 KiB per attempt. Duplicate sequences are ignored and gaps are rejected.
6. `auth.finished` reports the outcome. On success, call `POST /v1/auth/complete` with `{}`. To abort, call `POST /v1/auth/cancel` with `{attemptId}`.

Each attempt has a unique ID and a 10-minute lifetime, and a user can run only one attempt at a time. Cancelling terminates and reaps the login process group. Event replay covers reconnects while the page stays open. Refreshing the page discards its keys, so cancel the old attempt or let it expire first. Sandbox recovery emits `auth.reset` and does not resume unfinished attempts.

Once authentication is confirmed, both `/v1/auth/complete` and the status check stop the auth Sandbox before returning. A failed stop is returned as an error so the caller can retry. Credentials remain in the Workspace. If the user is not authenticated, the Sandbox stays up for login.

### Terminal encryption

Cantelop dispatch and event replay may retain payloads, so login input **and** output are encrypted end to end with AES-256-GCM over an ephemeral P-256 ECDH key. The platform only sees ciphertext. Private keys live only in browser and Session memory and are never written to the Workspace. This protects stored transport payloads. It does not protect against a compromised browser, runtime, or server.

The application never logs terminal I/O or keeps a transcript, and the PTY helper discards stderr. Auth status and attempt metadata remain visible to the platform. Keep TLS on and apply your own logging policies.

### Re-authentication

Claude Code refreshes its own credentials in the Workspace. A native `authentication_failed` error or an explicit signed-out status emits `auth.required` with the affected message ID. Status-command failures, billing errors, rate limits, and network errors are not treated as sign-outs. An internal retry that succeeds emits nothing.

When a client receives `auth.required`, it should pause new work for that user and offer sign-in (use `force: true`). Resume only after `auth.finished` reports `authenticated: true` and `outcome: "succeeded"`. Interrupted work is never replayed automatically.

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

Session commands are asynchronous, so their failures arrive as events:

| Event | Code | Meaning |
| --- | --- | --- |
| `error` | `session_not_configured`, `already_configured` | Session used before `configure`, or configured twice |
| `error` | `message_not_found`, `message_id_conflict`, `session_full` | Bad cancel target, reused `messageId` with different text, or 1,000-message limit |
| `error` | `agent_session_required`, `auth_session_required` | Command sent to the wrong Session kind |
| `auth.error` | `login_busy` | Another attempt is active. `activeAttemptId` identifies it when known; cancel it and start again |
| `auth.error` | `login_not_active`, `input_not_ready`, `input_rejected`, `invalid_public_key` | Input for a stale attempt, before `auth.started`, undecryptable, or an invalid key |
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
| `src/login.ts`, `src/login-process.ts`, `runtime/login-pty.py` | Native login lifecycle and PTY relay |
| `src/terminal-crypto.ts` | Encrypted terminal transport |
| `cantelop.json`, `docker/Dockerfile` | App manifest and Session image |
| `scripts/generate-auth-keys.mjs` | ES256 key pair for application tokens (`npm run keys`) |

### Updating Claude Code

The Dockerfile installs Claude Code **2.1.267** and verifies pinned SHA-256 checksums for Linux amd64 and arm64. Runtime auto-updates are off. To upgrade, update the version and both checksums from Anthropic's release manifest, then run `npm test` and `npm run build`.

### Tests

Tests exercise the real SDK route definitions, JWT and tenant checks, Session dispatch, queue/steer/cancel, durable reactivation, output fragmentation, and subprocess handling. They use fake Claude executables. The login tests drive a fake interactive CLI through the PTY. No test calls a model or uses real credentials. A real sign-in and model turn require a user's own account.

## Production checklist

- [ ] Mint application tokens on your server with a lifetime of at least 15 minutes for interactive login (see [Application tokens](#application-tokens)).
- [ ] Serve the event stream through an unbuffered same-origin adapter that forwards `Last-Event-ID`.
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
