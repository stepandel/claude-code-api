# Cantelop Claude Code API

A **Cantelop SDK application** with an Edge API and a native Session behaviour. Uses `@cantelop/sdk@0.9.1`: Cantelop allocates Sandboxes, mounts durable per-user Workspaces, serializes actor messages, supervises activities, and transports output through SSE/WebSockets. Claude Code runs as Anthropic's unmodified native executable inside the Sandbox.

SDK reference: [upstream documentation](https://github.com/stepandel/cantelop-sdk/tree/sdk-v0.9.1). Version 0.9.1 was verified against GitHub and npm on September 18, 2026.

## Architecture

- `src/api.ts`: `defineApi`, JWT verification, `app.workspaces.open`, `app.sessions.open`, dispatch, and authenticated event streaming. No local server or Docker daemon management.
- `src/session.ts`: `defineSessionBehaviour`, managed activities for long-running turns, queue/steer/cancel handling, and recovery.
- `src/claude.ts`: native CLI subprocess, process-group cancellation, stream parsing, explicit tool/MCP settings, and native authentication status.
- `src/state.ts`: atomic snapshots of configuration, queue, message status, and Claude conversation identity under `/workspace/.cantelop`.
- `cantelop.json` and `docker/Dockerfile`: Edge/Session entrypoints and system dependencies. Cantelop supplies the runtime user, startup command, and `/workspace` mount.

Each application identity maps to a server-derived Workspace slug. Separate sessions for that user mount the same Workspace. Claude's own authentication state lives in `/workspace/.claude` via `CLAUDE_CONFIG_DIR`; the application never reads or exports those credentials. Each logical Session stores a distinct Claude conversation ID and configuration.

## Authentication boundary

Application identity and Claude identity are separate:

1. Your trusted backend issues an ES256 application JWT with `sub`, `iss`, `aud`, and `exp` (optional `nbf`). Cantelop receives **only the public verification key**, never the signing private key. Use the token as `Authorization: Bearer ...`.
2. `POST /v1/auth` opens the user's durable Workspace and dispatches preparation to a native auth Session. Repeated calls use the same Workspace and auth Session.
3. The user signs into the unmodified CLI through Anthropic's own flow in a trusted terminal attached to that Workspace.
4. `POST /v1/auth/complete` dispatches an authentication check. Watch the auth Session's events for `auth.status`; HTTP 202 is dispatch acceptance, not authentication success.

**Interactive terminal access is not implemented here.** The SDK version used here does not provide a terminal attachment method. The handoff returns the native command, not an invented OAuth URL or unsupported Cantelop terminal command. A hosted product needs a properly user-scoped terminal/SSH integration before subscription onboarding is end-to-end. Do not send Claude passwords, OAuth codes, or tokens to this API.

The native command in a terminal attached to the user's Workspace is:

```sh
CLAUDE_CONFIG_DIR=/workspace/.claude claude auth login
```

All native authentication methods remain available in that terminal. For native Console login, use `claude auth login --console` with the same config directory. Authentication checks accept any authenticated native method; they do not force subscription billing. Provider configuration belongs to the end user's native environment. The scaffold does not implement provider-key intake or inject shared provider credentials from App secrets into Claude subprocesses.

Anthropic's [hosting conditions](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products) describe hosting the unmodified binary under Commercial Terms with end-user authentication and billing. Its [credential conditions](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) distinguish native sign-in from a third-party Claude login or credential intermediary. This scaffold is designed around that distinction; it is not legal approval. Review the full terms for your deployment. Checked September 18, 2026.

## Local setup

Requires Node.js 22+, the Cantelop CLI, Bun, and Docker with `linux/amd64` support.

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

`npm run build` runs `cantelop build`, which reads `cantelop.json` and builds both the Edge API and native Session image. For a reproducible production image, pin the Dockerfile's `CLAUDE_VERSION` to an audited version; the scaffold defaults to Anthropic's stable channel.

## API usage

Allocate and prepare native authentication:

```sh
curl "$BASE_URL/v1/auth" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

The response includes `sessionId` for authentication events, `workspaceId`, `workspaceSlug`, and `nativeLogin`. Complete native terminal sign-in, then:

```sh
curl "$BASE_URL/v1/auth/complete" -H "Authorization: Bearer $USER_TOKEN" -d '{}'
curl -N "$BASE_URL/v1/events?sessionId=$AUTH_SESSION_ID" \
  -H "Authorization: Bearer $USER_TOKEN"
```

Create a configured agent Session:

```sh
curl "$BASE_URL/v1/sessions" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tools":["Read","Glob","Grep"],"allowedTools":["Read","Glob","Grep"],"mcps":{}}'
```

Session creation is asynchronous: observe `session.ready` and `auth.status`. A Session can be configured before native sign-in; each turn rechecks authentication and fails without starting a model call if unauthenticated. Store the returned `sessionId` as `SESSION_ID`.

`tools` selects available built-in tools; it defaults to none. `allowedTools` grants unattended execution for the listed tool names or native rules. Other permissions are denied (`dontAsk`); there is no blanket permission bypass. Custom tools are MCP tools, not JSON function declarations.

`mcps` is a name-to-server map. For example:

```json
{
  "docs": {"type":"http","url":"https://your-mcp.example/mcp"},
  "local": {"type":"stdio","command":"node","args":["/workspace/tools/server.js"]}
}
```

HTTP/SSE servers may include `headers`; stdio servers may include `env`. Tool code and dependencies must exist in the Sandbox. MCP settings may contain secrets and are persisted within the user's Workspace. Grant matching permissions explicitly, such as `mcp__docs__search`. Session configuration is immutable; create a new Session to change it.

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

The `session.state` event contains the latest 50 messages with prompt previews capped at 256 characters, plus a `truncated` flag. It is a summary, not a full transcript API.

| Method | Route | Behaviour |
| --- | --- | --- |
| GET | `/health` | Public liveness |
| POST | `/v1/auth` | Allocate user Workspace and prepare native authentication |
| POST | `/v1/auth/complete` | Dispatch native authentication check |
| POST | `/v1/sessions` | Create and configure a Session |
| POST | `/v1/messages` | Queue or steer a message |
| POST | `/v1/cancel` | Cancel a queued or active message |
| POST | `/v1/snapshot` | Publish persisted Session summary |
| GET | `/v1/events?sessionId=...` | SDK SSE/WebSocket stream |

All routes except health require an application JWT. Workspace selection is derived from verified identity; clients cannot select another user's Workspace. Session ownership is checked before dispatch and event subscription. POST responses report acceptance (202); outcomes arrive as events.

## Queue, cancellation, and durability

Cantelop serializes command handlers in the Session mailbox. A managed activity runs a turn while the mailbox stays responsive. The application persists its pending prompt queue separately from the platform mailbox. Only one turn runs per Session.

- `queue`: FIFO after pending work.
- `steer`: interrupt the active native process group, wait for termination, then run the steering prompt before pending work. Repeated steering is newest-first. This is interrupt-and-resume, not mid-generation injection.
- `cancel`: remove a queued message or terminate the active turn. Finished messages are unchanged. Completed tool effects cannot be undone.

The runner uses SIGTERM, then SIGKILL for stubborn process groups, and waits before starting the next turn. Tools that deliberately detach into their own process group may outlive a turn; Sandbox termination is the broader cleanup boundary.

Configuration, message IDs/statuses, pending queue, and conversation identity survive Sandbox loss. On reactivation, previously running work becomes `interrupted` and is **not replayed** because tools may already have produced effects. The recovery hook resumes only queued work. Output events use Cantelop's bounded in-memory stream; full event history is not durable. Claude manages its own native transcript. An interruption before the transcript is written can make a later resume fail and may require a new Session.

Sessions share files within the same user's Workspace; concurrent sessions can edit the same files. Data persists when Cantelop releases a Sandbox. A Session retains at most 1,000 application messages; create a new Session after that. Queue snapshots are atomically replaced; this is not a general transactional database or an exactly-once tool-execution guarantee.

## Deployment and remaining work

Configure the public identity settings in `cantelop.json` through Cantelop App configuration, then use the standard `cantelop doctor` / `cantelop deploy --dry-run` / `cantelop deploy` workflow. A dry run builds without publishing. No deployment is performed by the scaffold.

Before production: implement the scoped native terminal handoff, integrate your identity issuer and key rotation/revocation strategy, add user quotas and admission/rate limits, and define Workspace retention/backup/deletion policies. Review network access for your MCP services under Cantelop's sandbox policy. Do not place shared provider credentials or application signing keys in App environment variables visible to native Sessions.

## Verification

Tests exercise actual SDK route definitions, JWT/tenant checks, Workspace/Session dispatch, managed activity queue/steer/cancel behaviour, durable reactivation, output fragmentation, and native subprocess parsing/cancellation using a fake Claude executable. They do not call a model or use subscription credentials. Real Anthropic login and model turns still require the user's own account and the terminal integration described above.
