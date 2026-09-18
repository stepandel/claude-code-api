# Cantelop

A dependency-free Node.js API scaffold that runs Anthropic's unmodified Claude Code CLI in a separate Docker container per user. Includes native authentication handoff, `/workspace`, per-session tools and MCP servers, FIFO messages, interrupt-and-resume steering, cancellation, and cursor-based event polling.

## Authentication and terms

Cantelop authentication and Claude authentication are separate. An operator provisions a user using the admin-protected auth endpoint and delivers that user's Cantelop bearer token securely. The user then signs into the native Claude Code binary in their own container. Cantelop checks `claude auth status`; it does not accept Claude passwords, OAuth codes, session tokens, or a custom OAuth callback. Credentials remain managed by Claude Code inside the user's environment. No host Claude credentials or operator API keys are forwarded.

Anthropic's [current hosting conditions](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products) permit hosting the unmodified binary subject to Commercial Terms and end-user billing. The [authentication conditions](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) distinguish native sign-in from third-party Claude login or credential intermediation. This architecture is intended to follow that distinction; it is not a legal determination or Anthropic approval. Review the full terms for your deployment. Checked September 18, 2026.

All native authentication choices remain accessible through the container terminal, including subscription, Console/API and supported provider configurations. The service checks authenticated status, not subscription entitlement, and never forces subscription billing. Hosting fees must not resell Claude usage.

## Run

Requires Node.js 22+ and Docker. No npm dependencies.

```sh
docker build -t cantelop-runner:local -f docker/Dockerfile .
cp .env.example .env
# Replace CANTELOP_ADMIN_TOKEN in .env with a randomly generated secret.
npm start
```

The image installs the official binary without modification. For reproducibility pass `--build-arg CLAUDE_VERSION=<audited-version>`. Default binding is `127.0.0.1:3000`.

Provision a user (the admin token belongs to your trusted backend, never a public client):

```sh
curl http://127.0.0.1:3000/v1/auth \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{}'
```

Save the returned `token` as `USER_TOKEN`. Run the returned `login.command` in a trusted terminal on the Docker host. The command invokes `docker exec -it cantelop-<user-id> claude auth login`. Complete Anthropic's own flow directly. The returned `login.terminal` provides the full native CLI and its other auth methods.

**This scaffold does not include a browser terminal.** In a hosted product, provide a terminal/SSH connection scoped to the user's container; do not give end users access to the Docker daemon. The auth endpoint provisions and hands off, and the completion endpoint verifies authentication:

```sh
curl http://127.0.0.1:3000/v1/auth/complete \
  -H "Authorization: Bearer $USER_TOKEN" -d '{}'
```

Create a session:

```sh
curl http://127.0.0.1:3000/v1/sessions \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tools":["Read","Glob","Grep"],"allowedTools":["Read","Glob","Grep"],"mcps":{}}'
```

`tools` selects built-in Claude Code tools (default: none). `allowedTools` grants permission for the specified tools/rules; omitted permissions are denied in unattended mode. There is no blanket permission bypass. Custom tools are supplied through MCP, not arbitrary JSON function definitions.

`mcps` is a name-to-server map supporting:

```json
{
  "docs": {"type":"http","url":"https://your-mcp.example/mcp"},
  "local": {"type":"stdio","command":"node","args":["/workspace/tools/server.js"]}
}
```

HTTP/SSE servers may include `headers`; stdio servers may include `env`. These values are sensitive. Stdio commands run inside the user's container. Dependencies and tool code must already exist there. Session settings are fixed at creation; native auth settings remain available, while automatic session settings and unrelated MCP configurations are excluded. MCP calls needing approval require matching `allowedTools` rules, such as `mcp__docs__search`.

Queue or steer:

```sh
curl "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"Inspect the project","mode":"queue"}'

curl "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"Focus on authentication first","mode":"steer"}'
```

`queue` runs after existing messages in FIFO order. `steer` interrupts the active process group, then resumes the same CLI conversation with the new message before queued messages. This is interrupt-and-resume, not mid-generation instruction injection. Repeated steering messages get newest-first priority. Cancellation cannot undo completed tool effects. An interrupted turn before Claude creates its transcript starts fresh on the next message.

```sh
curl "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/messages/$MESSAGE_ID/cancel" \
  -H "Authorization: Bearer $USER_TOKEN" -d '{}'
curl "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/events?after=0" \
  -H "Authorization: Bearer $USER_TOKEN"
```

Poll using the returned `cursor`; events include message transitions and Claude stream JSON. The latest 1,000 events are retained. An expired cursor returns 410; fetch session state to recover. API responses contain prompts and model output and should be treated as private. Raw stderr is not returned.

## Endpoints

| Method | Path | Authorization | Result |
| --- | --- | --- | --- |
| GET | `/health` | None | Liveness |
| POST | `/v1/auth` | Admin | Allocate user, container, native login handoff, Cantelop token |
| POST | `/v1/auth/complete` | User | Check native authentication |
| POST | `/v1/sessions` | User | Create configured session |
| GET | `/v1/sessions/:id` | Owner | Session and message state |
| POST | `/v1/sessions/:id/messages` | Owner | Queue or steer (`202`) |
| POST | `/v1/sessions/:id/messages/:messageId/cancel` | Owner | Request cancellation (`202`) |
| GET | `/v1/sessions/:id/events?after=N` | Owner | Events and next cursor |

Messages transition from `queued` to `running` to `completed`, `failed`, `cancelled`, or `steered`. Cancelling a finished message is a no-op; active cancellation is asynchronous. Watch events for completion or `cancel.failed`. Turn failure does not block subsequent messages. Sessions for the same user share `/workspace`, so concurrent sessions may edit the same files.

## Scope and deployment gaps

This is a local development scaffold. API tokens (hashed), session metadata, queues, and events are in memory. Container files survive while the container exists, but graceful shutdown removes containers and their data. A crash may leave orphan containers; restarting does not recover their API state. Inspect `docker ps -a --filter label=app=cantelop` and explicitly remove unused containers. Do not store valuable work here yet.

Before hosting untrusted users, add durable metadata/queues and workspace volumes, crash reconciliation, scoped terminal access, real application identity and token expiry/revocation, TLS, quotas/rate limiting, idle reclamation, and backups/deletion controls. Docker resource limits and capability restrictions are included, but Docker alone is not a complete hostile-code isolation boundary. Use dedicated workers or a stronger sandbox and enforce network egress rules blocking metadata services, private control-plane networks, and other tenants. MCP servers and Bash can make network requests; URLs are validated for syntax, not network destination policy. Do not expose this development server publicly.

## Verification

```sh
npm test
npm run check
```

Tests use a fake runtime, so they incur no Claude usage. They exercise HTTP authorization, tenant ownership, native-auth gating, input rejection, queue ordering, steering, cancellation, cancellation failure, and CLI argument construction. Real subscription sign-in and live model turns require manual verification with the user's own account. CLI flags are documented in [Anthropic's CLI reference](https://code.claude.com/docs/en/cli-reference).
