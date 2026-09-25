# Cantelop Claude Code API

A **Cantelop SDK application** with an Edge API and a native Session behaviour. Uses `@cantelop/sdk@0.12.0`: Cantelop allocates Sandboxes, mounts durable per-user Workspaces, serializes actor messages, supervises activities, and transports output through SSE/WebSockets. Claude Code runs as Anthropic's unmodified native executable inside the Sandbox.

## Architectural overview

This repository is a reference implementation for self-managed Claude Code hosting on Cantelop. It does not modify the Claude Code binary, harness, or built-in authentication methods. Each end user signs in through Claude Code's native Anthropic flow with their own Claude subscription or provider credentials; the application does not collect, proxy, or resell those credentials or the resulting model usage.

That boundary follows Anthropic's conditions for [hosting Claude Code in a product](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products): run the published binary unchanged, preserve every built-in authentication method, and have each user authenticate and pay under their own Anthropic or inference-provider agreement. It also preserves native subscription authentication instead of injecting an `ANTHROPIC_API_KEY`. Billing still follows the user's plan and Anthropic's current rules: included limits, Agent SDK or `claude -p` credits, and any separately enabled usage credits may apply. This project does not guarantee that a run will never consume usage credits.

The central design separates durable user state from disposable compute:

![Cantelop Claude Code architecture](docs/architecture.png)

- **One durable Workspace per user.** The API derives its Workspace slug from the verified application identity, so callers cannot select another user's Workspace. Claude Code writes its native authentication state beneath `/workspace/.claude`; application session state lives beneath `/workspace/.cantelop`.
- **One ephemeral Sandbox per active Session.** Cantelop creates or reactivates the execution environment, mounts the user's Workspace at `/workspace`, and releases the Sandbox after work becomes idle or is explicitly stopped. Releasing a Sandbox does not remove the Workspace.
- **Native authentication survives Sandbox replacement.** A later Session mounts the same Workspace and Claude Code reads the authentication state it previously wrote. The application points `CLAUDE_CONFIG_DIR` at the mounted Workspace but never reads or exports Claude's credentials.
- **Concurrency is supported.** Multiple Session Sandboxes can mount the same user's Workspace at once. They share authentication and files but retain separate Claude conversation IDs, queues, and configuration. Because concurrent Sessions can edit the same files, callers must coordinate conflicting work.

In short, the Workspace is the durable identity and state boundary; Sandboxes are replaceable compute attached only while a login or agent Session is active.

## Get started

### 1. Install the CLI and clone the repository

The only Cantelop-specific local setup is installing its CLI. With Homebrew:

```sh
brew install stepandel/tap/cantelop
```

On macOS or Linux without Homebrew, use the official installer:

```sh
curl -fsSL https://console.cantelop.dev/install.sh | sh
```

Then clone the application and install its dependencies:

```sh
git clone https://github.com/stepandel/claude-code-api.git
cd claude-code-api
npm ci
```

The application also requires Node.js 22+, Bun, and Docker with `linux/amd64` support. No Cantelop service runs locally: the CLI builds and deploys the App, while Cantelop manages the hosted Edge API, Workspaces, and Sandboxes. CLI account authentication happens later with `cantelop login`.

Use the [Cantelop platform deployment guide](https://console.cantelop.dev/docs) for account management, complete CLI documentation, release operations, logs, traces, rollback, and platform troubleshooting. The steps below cover the configuration and verification specific to this application.

### 2. Choose the App identity

The `app` field in `cantelop.json` is currently `cantelop-claude-api`. Change it before creating the App if the deployment needs a different or environment-specific slug. The App uses that manifest to build two artifacts:

- the Edge API from `src/api.ts`;
- the native Session runtime from `src/session.ts` and `docker/Dockerfile`.

The custom image installs the repository-pinned, unmodified Claude Code binary plus the Python PTY helper used by native login. Cantelop supplies the runtime user, process entrypoint, Sandbox lifecycle, and `/workspace` mount.

### 3. Configure application identity verification

Create a local configuration file and replace every placeholder:

```sh
cp .env.example .env
```

- `AUTH_PUBLIC_JWK`: the public P-256 JWK used to verify application JWTs. Do not provide its private key.
- `AUTH_ISSUER`: the exact JWT `iss` value issued by your identity system.
- `AUTH_AUDIENCE`: the exact JWT `aud` value accepted by this API; it defaults to `cantelop-claude-api`.

These values authenticate callers to this application. They are separate from Claude authentication, which each user completes later through Claude Code's native login. Do not add an Anthropic API key, Claude token, JWT signing key, or shared provider credential to this App.

### 4. Verify the release locally

Run the application checks and qualify both release artifacts locally:

```sh
npm run check
npm test
npm run build
```

`npm run build` delegates to `cantelop build` and qualifies both release artifacts without publishing them.

### 5. Create, configure, and deploy the App

Authenticate the CLI, create the manifest's App once, and sync the declared environment values:

```sh
cantelop login
cantelop app create -slug cantelop-claude-api
cantelop env sync --env-file .env --dry-run
cantelop env sync --env-file .env
```

If you changed the `app` field, use the same slug with `app create`. For an App that already exists, skip the create command. Then run the platform preflight, build without publishing, and create the release:

```sh
cantelop doctor
cantelop deploy --dry-run
cantelop deploy
cantelop releases --json
```

Wait until the new release is active before sending traffic. The platform guide documents how to inspect build or activation failures, stream logs, examine traces and Sandboxes, and roll back a release.

### 6. Smoke-test the deployment

Use the deployed App origin as `BASE_URL`. Check the public health route, issue an ES256 application JWT whose `iss` and `aud` match the configured values, and visit `$BASE_URL/login` in a browser to start native Claude login:

```sh
curl "$BASE_URL/health"
```

After the user signs in with their own Claude account, use the [core workflow](#core-workflow) to create a Session, subscribe to its events, and send a message. A production rollout should also verify tenant isolation with at least two application identities and confirm that a new Sandbox can reuse each user's native authentication from the durable Workspace.

## API interface

Set `BASE_URL` to the deployed App origin and send the application JWT as a bearer token on every `/v1/*` request:

```sh
Authorization: Bearer $USER_TOKEN
Content-Type: application/json
```

The JWT must be ES256-signed and contain `sub`, `iss`, `aud`, and `exp` claims matching the App configuration. The API derives the caller's Workspace and Session ownership from that identity; clients cannot select another user's Workspace.

| Method | Route | Request | Response |
| --- | --- | --- | --- |
| GET | `/health` | — | `200 {"ok":true}`; public |
| GET | `/login` | — | Native Claude subscription login page; public page, authenticated API calls |
| POST | `/v1/auth` | `{}` to check status, or an encrypted-login handshake | `200` auth status or `202` receipt |
| POST | `/v1/auth/input` | Encrypted terminal frame | `202` receipt |
| POST | `/v1/auth/cancel` | `{"attemptId":"<uuid>"}` | `202` receipt |
| POST | `/v1/auth/complete` | `{}` | `200` auth status |
| POST | `/v1/auth/logout` | `{}` | `200` signed-out status |
| POST | `/v1/sessions` | Session configuration | `202 {sessionId,receiptId}` |
| POST | `/v1/messages` | `{sessionId,text,mode?,messageId?}` | `202 {sessionId,receiptId,messageId}` |
| POST | `/v1/cancel` | `{sessionId,messageId}` | `202 {sessionId,receiptId,messageId}` |
| POST | `/v1/snapshot` | `{sessionId}` | `200` persisted Session summary |
| GET | `/v1/events?sessionId=...` | — | Authenticated SSE or WebSocket event stream |

### Core workflow

First connect the user's native Claude subscription at `/login`, or use the encrypted programmatic login protocol described under [Authentication boundary](#authentication-boundary). Then create an immutable agent Session:

```sh
curl "$BASE_URL/v1/sessions" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"sonnet",
    "systemPrompt":"Use the available project tools.",
    "maxTurns":24,
    "tools":["Read","Glob","Grep"],
    "allowedTools":["Read","Glob","Grep","mcp__project__search"],
    "mcps":{
      "project":{
        "type":"http",
        "url":"https://tools.example.com/mcp",
        "headers":{"Authorization":"Bearer SESSION_SCOPED_TOKEN"}
      }
    }
  }'
```

Save the returned `sessionId`, subscribe to output, and send work:

```sh
curl -N "$BASE_URL/v1/events?sessionId=$SESSION_ID" \
  -H "Authorization: Bearer $USER_TOKEN"

curl "$BASE_URL/v1/messages" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"text\":\"Inspect this project\",\"mode\":\"queue\"}"
```

Session configuration fields:

- `tools`: built-in Claude Code tools exposed to the model. Defaults to none.
- `allowedTools`: exposed tools or native permission rules that may run unattended. Everything else is denied because the runner uses `dontAsk`.
- `mcps`: named `http`, `sse`, or `stdio` MCP server configurations. Discovered tools are named `mcp__<server>__<tool>` and must match `allowedTools` to execute.
- `model`: optional native Claude model alias or ID.
- `systemPrompt`: optional replacement system prompt, up to 32 KiB of UTF-8.
- `maxTurns`: optional per-message turn limit from 1 to 100.

Configuration is immutable after Session creation. Create a new Session to change models, prompts, tools, MCP servers, or run-scoped credentials. POST bodies are limited to 48 KiB; message text is limited to 32 KiB of UTF-8.

SDK reference: [upstream documentation](https://github.com/stepandel/cantelop-sdk/tree/sdk-v0.12.0). Version 0.12.0 was verified against GitHub and npm on September 23, 2026. Builds require a Cantelop CLI compatible with SDK build protocol 5 (verified with CLI 0.11.2). The API artifact publishes all 12 application routes for the Cantelop console.

## Implementation map

- `src/api.ts`: `defineApi`, JWT verification, `app.workspaces.open`, `app.sessions.open`, dispatch, and authenticated event streaming. No local server or Docker daemon management.
- `src/session.ts`: `defineSessionBehaviour`, managed activities for long-running turns, queue/steer/cancel handling, and recovery.
- `src/login.ts`, `src/login-process.ts`, and `runtime/login-pty.py`: native login lifecycle and PTY relay.
- `src/login-page.ts` and `src/terminal-crypto.ts`: login screen and encrypted terminal transport.
- `src/claude.ts`: native CLI subprocess, process-group cancellation, stream parsing, explicit tool/MCP settings, and native authentication status.
- `src/state.ts`: atomic snapshots of configuration, queue, message status, and Claude conversation identity under `/workspace/.cantelop`.
- `cantelop.json` and `docker/Dockerfile`: Edge/Session entrypoints and system dependencies. Cantelop supplies the runtime user, startup command, and `/workspace` mount.

Each application identity maps to a server-derived Workspace slug. Separate sessions for that user mount the same Workspace. Claude's own authentication state lives in `/workspace/.claude` via `CLAUDE_CONFIG_DIR`; the application never reads or exports those credentials. Each logical Session stores a distinct Claude conversation ID and configuration.

## Authentication boundary

Open **`/login`** on your App's origin. Enter an application access token from your identity system and select **Connect Claude**. The page opens the native Claude Code login in the user's auth Sandbox. Open the displayed Anthropic link, sign in with your subscription, and enter any completion code only when the native terminal asks for it. The page confirms success after checking `claude auth status`.

Application identity and Claude identity remain separate. Your backend issues an ES256 JWT with `sub`, `iss`, `aud`, and `exp` (optional `nbf`); Cantelop receives only its public verification key. The terminal runs the unmodified `claude auth login` command with `CLAUDE_CONFIG_DIR=/workspace/.claude`. Claude handles the OAuth exchange and persists its own credentials. The application does not implement an OAuth callback or extract Claude's tokens.

The page is a small line-oriented login console, not a general shell. It uses a Python standard-library PTY helper installed in the runtime image. Input echo is disabled; sending an empty response presses Enter. Native terminal output is rendered as inert text, and only Anthropic-domain HTTPS links are made clickable. No external frontend assets or build step are required.

Each login attempt has a ten-minute lifetime and a unique ID. Only one attempt can run in the user's deterministic auth Session. Cancellation terminates and reaps the native process group. Network reconnection uses Cantelop event replay while the page remains open. Closing or refreshing the page discards its temporary keys; cancel the old attempt or wait for expiry before starting another. Sandbox recovery emits `auth.reset`; unfinished login attempts are not resumed.

### Terminal transport

The SDK sends dispatch payloads through the platform and supports bounded event replay; it does not promise zero retention of platform payloads. Accordingly, the browser and auth Session negotiate a temporary P-256 ECDH key and use AES-256-GCM for **both input and output**. Cantelop dispatch and replay receive ciphertext. Private transport keys live only in browser/Session memory and are never saved in the Workspace. This protects stored transport payloads, not a compromised browser, runtime, or application server.

Application code never logs terminal input/output or persists a terminal transcript. The helper discards stderr diagnostics. Claude itself owns its native configuration and any native diagnostic files. Authentication status and attempt metadata remain visible to the platform. Keep TLS enabled and apply your deployment's access/logging policies.

Anthropic's [hosting conditions](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products) describe hosting the unmodified binary under Commercial Terms with end-user authentication and billing. Its [credential conditions](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) distinguish native sign-in from a third-party Claude login or credential intermediary. This scaffold is designed around that distinction; it is not legal approval. Review the full terms for your deployment. Checked September 18, 2026.

## Local setup

Requires Node.js 22+, Cantelop CLI 0.11.2+, Bun, and Docker with `linux/amd64` support. The dev script uses `cantelop dev --container` so Sessions run the service's Docker image with Claude Code, Python, and the PTY helper installed.

```sh
npm ci
cp .env.example .env
# Set AUTH_PUBLIC_JWK, AUTH_ISSUER, and AUTH_AUDIENCE for your identity provider.
npm run check
npm test
npm run build
npm run dev
```

Use an ES256 JWT issued by your application authentication system as `USER_TOKEN`, matching the public key, issuer, and audience configured in `.env`. Use the API base URL printed by `cantelop dev` as `BASE_URL`. The project does not issue application tokens.

`npm run build` runs `cantelop build`, which reads `cantelop.json` and builds both the Edge API and native Session image. The Dockerfile downloads Claude Code 2.1.267 directly and checks repository-pinned SHA-256 hashes for Linux amd64 and arm64 before installing it. Runtime auto-updates are disabled. To update Claude, change the version and both checksums together using Anthropic's release manifest, then run the service tests and image build.

## API usage

For interactive subscription login, use `/login`. Programmatic clients can implement the same terminal protocol:

1. `POST /v1/auth` with `{}` allocates the user's Workspace and returns HTTP 200 with the auth `sessionId`, Workspace identifiers, `/login` URL, `type: "auth.status"`, and `authenticated: boolean` from the native authentication check. No event subscription is needed for this check.
2. Subscribe to `/v1/events?sessionId=...` **before** starting the terminal.
3. Generate a temporary ECDH P-256 key pair. `POST /v1/auth` with `{ "attemptId": "<UUID>", "publicKey": <public JWK> }` starts login. Private JWK fields are rejected.
4. `auth.started` returns the Session's public JWK and `expiresAt`. Derive the AES-GCM key using `src/terminal-crypto.ts`. Encrypted `auth.output` events carry `terminalSequence`, `iv`, and `data`. Decrypt with additional authenticated data `<attemptId>:output:<terminalSequence>`.
5. Send encrypted terminal bytes to `POST /v1/auth/input` as `{attemptId, sequence, iv, data}`. Input sequence starts at 1; AAD is `<attemptId>:input:<sequence>`. IV is 12 random bytes; IV and ciphertext use standard base64. Input is limited to 4 KiB per frame and 32 KiB per attempt. Duplicate accepted sequences are ignored; gaps are rejected. No plaintext code field is accepted.
6. `POST /v1/auth/cancel` with `{attemptId}` stops an attempt. `auth.finished` reports the outcome and native authentication status. `POST /v1/auth/complete` with `{}` returns HTTP 200 with `{sessionId, type: "auth.status", authenticated}` directly.

After a successful `auth.finished` event, call `POST /v1/auth/complete`; the bundled login page does this automatically. Both this endpoint and the status-only `POST /v1/auth` stop the auth Session's Sandbox once native authentication is confirmed, using SDK 0.12's `session.stop()`. Cleanup completes before the API returns success; platform stop failures are returned for retry. Stopping closes event streams, preserves credentials in the persistent Workspace, and allows later requests to reactivate the same Session. Unauthenticated checks leave the Sandbox available for login.

The server derives the auth Session from the caller's JWT; clients cannot select a different user's terminal. The browser implementation in `src/login-page.ts` demonstrates the complete flow, including subscribing before dispatch and handling encrypted event replay.

Create a configured agent Session:

```sh
curl "$BASE_URL/v1/sessions" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tools":["Read","Glob","Grep"],"allowedTools":["Read","Glob","Grep"],"mcps":{}}'
```

Optional session execution settings can be supplied alongside MCP configuration:

```json
{
  "model": "sonnet",
  "systemPrompt": "Use only the supplied project tools.",
  "maxTurns": 24,
  "tools": [],
  "allowedTools": ["mcp__project__*"],
  "mcps": {
    "project": {
      "type": "http",
      "url": "https://tools.example.com/mcp",
      "headers": {"Authorization": "Bearer SESSION_SCOPED_TOKEN"}
    }
  }
}
```

- `model`: optional native model alias or ID, 1–128 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit. Omit it or use `default` for Claude's native default. Availability is determined by the user's account and installed Claude version.
- `systemPrompt`: optional nonblank replacement for Claude's default system prompt, at most 32 KiB in UTF-8. Passed using a private temporary file, removed after the turn, and persisted as part of the Session configuration. It is not appended to the user's message.
- `maxTurns`: optional integer from 1 to 100, applied to each message, including resumed turns. Omission retains Claude's native default. A turn-limit failure is reported as a failed message, not successful completion.

All configuration is immutable and survives reactivation. Create a fresh Session when changing models, prompts, or run-scoped MCP tokens. Model usage still requires the user's native Claude authentication; these fields do not accept provider credentials.

Message `text` accepts up to 32 KiB of UTF-8. Every POST body remains limited to 48 KiB of encoded JSON, including configuration, MCP headers, and JSON escaping. Larger context must be fetched through MCP or split into separate tasks.

Session creation is asynchronous: observe `session.ready` and `auth.status`. A Session can be configured before native sign-in; each turn rechecks authentication and fails without starting a model call if unauthenticated. Store the returned `sessionId` as `SESSION_ID`.

`tools` selects available built-in tools; it defaults to none. `allowedTools` grants unattended execution for the listed tool names or native rules. Other permissions are denied (`dontAsk`); there is no blanket permission bypass. Custom tools are MCP tools, not JSON function declarations.

`mcps` is a name-to-server map. For example:

```json
{
  "docs": {"type":"http","url":"https://your-mcp.example/mcp"},
  "local": {"type":"stdio","command":"node","args":["/workspace/tools/server.js"]}
}
```

HTTP/SSE servers may include `headers`; their tool implementations run remotely and only need to be reachable from the Sandbox. Stdio servers may include `env`; their command, tool code, and dependencies must exist inside the Sandbox. MCP settings may contain secrets and are persisted within the user's Workspace. Grant matching permissions explicitly, such as `mcp__docs__search`. Session configuration is immutable; create a new Session to change it.

Send queued or steering messages:

```sh
curl "$BASE_URL/v1/messages" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"text\":\"Inspect this project\",\"mode\":\"queue\"}"

curl "$BASE_URL/v1/messages" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"text\":\"Focus on authentication\",\"mode\":\"steer\"}"
```

Each response has a platform `receiptId` and an application `messageId`. Supply an optional UUID `messageId` to retry a message idempotently; reusing it with different text emits `message_id_conflict`.

Cancel an active or queued application message:

```sh
curl "$BASE_URL/v1/cancel" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"messageId\":\"$MESSAGE_ID\"}"
```

Watch output:

```sh
curl -N "$BASE_URL/v1/events?sessionId=$SESSION_ID" \
  -H "Authorization: Bearer $USER_TOKEN"
```

This returns SDK-native SSE. WebSocket clients use the `cantelop.events.v1` subprotocol and must supply the bearer header through a compatible client. Browser `EventSource` and browser WebSocket constructors cannot set arbitrary Authorization headers; a browser integration needs a same-origin backend/cookie adapter. Tokens are deliberately not accepted in query strings.

The SDK handles bounded replay using `Last-Event-ID` or `stream_id`/`after` query parameters. Large Claude frames are emitted as `claude.fragment`: concatenate `json` by `eventId` and `index`, then parse when `total` fragments arrive. Other frames use `claude`. Events are private model output and may contain user data.

Request a durable state snapshot after a stream reset:

```sh
curl "$BASE_URL/v1/snapshot" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SESSION_ID\"}"
```

The HTTP 200 response contains `{sessionId, type: "session.state", configured, messages, truncated}` directly, with the latest 50 messages and prompt previews capped at 256 characters. It is a summary, not a full transcript API. Sandbox recovery still emits a `session.state` event.

All API routes except health require an application JWT; the static login page is public. Workspace selection is derived from verified identity; clients cannot select another user's Workspace. Session ownership is checked before dispatch, requests, and event subscription.

Auth checks and snapshots use `session.request()` and return HTTP 200 with the result instead of a 202 receipt. Clients must read these response bodies instead of waiting for status/snapshot events. Requests wait up to 30 seconds; timeout returns HTTP 504 with `code: "request_wait_timeout"`. A timeout or disconnect stops waiting, not execution; these read-only checks can be repeated. Interactive login start/input/cancel, Session configuration, and model queue/steer/cancel remain asynchronous (202), with outcomes delivered as events.

## Queue, cancellation, and durability

Cantelop serializes command handlers in the Session mailbox. A managed activity runs a turn while the mailbox stays responsive. The application persists its pending prompt queue separately from the platform mailbox. Only one turn runs per Session.

- `queue`: FIFO after pending work.
- `steer`: interrupt the active native process group, wait for termination, then run the steering prompt before pending work. Repeated steering is newest-first. This is interrupt-and-resume, not mid-generation injection.
- `cancel`: remove a queued message or terminate the active turn. Finished messages are unchanged. Completed tool effects cannot be undone.

The runner uses SIGTERM, then SIGKILL for stubborn process groups, and waits before starting the next turn. Tools that deliberately detach into their own process group may outlive a turn; Sandbox termination is the broader cleanup boundary.

Configuration, message IDs/statuses, pending queue, and conversation identity survive Sandbox loss. On reactivation, previously running work becomes `interrupted` and is **not replayed** because tools may already have produced effects. The recovery hook resumes only queued work. Output events use Cantelop's bounded in-memory stream; full event history is not durable. Claude manages its own native transcript. An interruption before the transcript is written can make a later resume fail and may require a new Session.

Sessions share files within the same user's Workspace; concurrent sessions can edit the same files. Data persists when Cantelop releases a Sandbox. A Session retains at most 1,000 application messages; create a new Session after that. Queue snapshots are atomically replaced; this is not a general transactional database or an exactly-once tool-execution guarantee.

## Production checklist

Choose an application name, issuer, and audience for your own deployment. Configure only the public ES256 verification JWK in Cantelop; keep signing keys and bearer tokens outside the repository and runtime environment. A bootstrap token can provide initial operator access, but production deployments should use their own multi-user identity provider, expiration policy, and key-rotation process. Application authentication remains separate from each user's native Claude subscription authentication.

Before production: integrate your identity issuer and key rotation/revocation strategy, add user quotas and admission/rate limits, and define Workspace retention/backup/deletion policies. Review network access for your MCP services under Cantelop's sandbox policy. Do not place shared provider credentials or application signing keys in App environment variables visible to native Sessions.

## Verification

Tests exercise actual SDK route definitions, JWT/tenant checks, Workspace/Session dispatch, managed activity queue/steer/cancel behaviour, durable reactivation, output fragmentation, and native subprocess parsing/cancellation using a fake Claude executable. They do not call a model or use subscription credentials. The login tests use a fake interactive Claude executable, verify PTY input/cancellation, and execute the compiled browser page against the real API handlers with simulated native login. A real subscription authorization and model turn require the user’s own account; automated tests do not sign in as the user.

### Re-authentication

The native CLI owns credential refresh in the durable workspace. Terminal native
`authentication_failed` errors and an explicit signed-out status emit
`auth.required` with the affected message ID. Status command failures are not
classified as sign-out. A successful CLI turn after an internal auth retry does
not emit `auth.required`; billing, rate-limit, and network failures retain normal
failure handling.

Clients should pause new work for the affected user and offer native sign-in.
Pass `force: true` with the public-key handshake to `POST /v1/auth` to open a new
login even when stale saved credentials still report signed in. Verify the
matching `auth.finished` event reports `authenticated: true` and
`outcome: succeeded` before clearing the pause. Interrupted work must not be
replayed automatically because earlier tool actions may already have completed.

### Signing out

`POST /v1/auth/logout` with `{}` runs native `claude auth logout` in the caller’s auth Session and verifies `claude auth status` reports signed out. It cancels and awaits any interactive login first, clears cached login completion, and returns HTTP 200 with `{sessionId, type: "auth.status", authenticated: false}` only after confirmation. Logout opens the auth Session with zero keep-alive, so Cantelop releases its Sandbox as soon as the mailbox and managed activity are idle; unlike interactive login, logout has no user-driven idle period to preserve. Stop the caller’s agent tasks before signing out. No workspace files or conversations are deleted. The request waits up to 45 seconds; a timeout does not confirm sign-out and can be retried.
