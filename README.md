# Cantelop Claude Code App

Run Anthropic's unmodified Claude Code binary for your users with `@cantelop/sdk@1.0.0-alpha.4`. Each user signs in with their own Claude subscription. Claude's credentials remain in their durable Workspace at `/workspace/.claude`; the App never reads or exports them.

The App imports its native runner, auth provider, and Dockerfile from `@cantelop/sdk/harnesses/claude`. It defines its application-owned durable mailbox in `src/cantelop.ts`. Your application backend uses the generated SDK client for Workspaces, native login commands, agent messages, and event subscriptions. There are **no custom HTTP routes or webhooks** in this App.

## Deploy

Install Node.js 22+, Bun, Docker with `linux/amd64` support, and Cantelop CLI 0.15.0+.

```sh
git clone https://github.com/stepandel/claude-code-api.git
cd claude-code-api
npm ci
npm run check
npm test
npm run build
cantelop deploy
```

Change `name` in `src/cantelop.ts` to deploy a different App. No App JWT keys or environment variables are required. The CLI generates `.cantelop/client/client.mjs` and stores App integration credentials in your local profile. For a hosted backend, supply an App-scoped `CANTELOP_APP_CONFIG` integration profile through its secret environment; never expose that token to the browser.

## Use from your backend

Import the generated client and derive one Workspace slug per verified user on your server. Never accept a caller-selected Workspace or another user's Session ID.

```js
import { app } from './.cantelop/client/client.mjs';

const workspace = app.workspace({ slug: workspaceSlugForVerifiedUser });
const auth = workspace.session({ id: `${userID}:auth`, keepAliveSeconds: 900 });
const status = await auth.request({ type: 'auth.check' }, { timeoutMs: 30_000 });
```

### Native sign-in

The dedicated auth Session runs stock `claude auth status`, `claude auth login`, and `claude auth logout`. Claude's native login process prints its sign-in URL and accepts the code the user receives from Claude. The SDK's packaged PTY helper relays that input directly to the unmodified CLI; it never persists terminal output or input.

```js
const login = await auth.request({ type: 'auth.login' }, { timeoutMs: 45_000 });
// Return login.url and login.attemptId to this verified user's browser.
// Validate the submitted attemptId and printable code in your backend.
const result = await auth.request({
  type: 'auth.code', attemptId: login.attemptId, code,
}, { timeoutMs: 45_000 });
if (result.type === 'auth.status' && result.authenticated) await auth.stop();
```

Use `{ type: 'auth.cancel', attemptId }` to end an unfinished login, or `{ type: 'auth.logout' }` to sign out. Login failures return `login_not_active`, `code_rejected`, `login_failed`, or `login_timeout`; handle them in your backend. Stop the auth Sandbox after confirmed sign-in. Its persistent Workspace retains Claude's native auth state for agent Sessions.

This App retains its existing native login protocol. SDK `workspace.auth()` terminal providers require additional platform transport support and are not used here.

### Agent Sessions

```js
const session = workspace.session({ id: `${userID}:${crypto.randomUUID()}`, keepAliveSeconds: 300 });
await session.dispatch({ type: 'configure', config: {
  model: 'claude-sonnet-5', maxTurns: 8,
  tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'], mcps: {},
}});
await session.dispatch({ type: 'queue', id: crypto.randomUUID(), text: 'Create hello.md' });
for await (const delivery of session.stream({ signal })) {
  // Forward delivery.data to this user's browser through your own backend.
}
```

Configuration also supports `systemPrompt` and per-Session MCP servers. Validate tools, configuration, and request limits at your backend boundary. The website demo allows file tools only, limits turns to eight, and derives the Workspace and Session ownership from its signed visitor cookie.

- `queue` runs ordinary messages FIFO. `steer` interrupts the current turn and prioritizes the new message. Tool effects already performed are not undone.
- `{ type: 'cancel', id }` cancels a queued or active application message. `session.stop()` releases the Sandbox while retaining its Workspace.
- `{ type: 'snapshot' }` via `session.request()` returns the latest 50 message states. Interrupted turns are never replayed automatically; queued work resumes through the managed activity.
- Events include `session.ready`, `message.status`, `claude`, `claude.fragment`, and `auth.required`. Read the application payload from `delivery.data`; concatenate large Claude fragments before parsing.
- Resume subscriptions with `session.stream({ after: delivery.cursor, signal })`. Aborting the subscription does not cancel work. Replay is bounded; fetch a snapshot if it cannot continue.

Sessions share a user's files and login but have separate conversations. Coordinate conflicting file edits. A Session retains up to 1,000 messages. Tool execution is not exactly-once.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/cantelop.ts` | SDK App definition and Dockerfile |
| `src/session.ts` | Durable queue, managed turns, steering, cancellation, recovery |
| `src/claude.ts` | Thin adapter to the SDK-maintained runner and auth provider |
| `src/state.ts` | Session state under `/workspace/.cantelop` |
| `src/login.ts`, `src/login-process.ts` | Demo login UI protocol around the SDK auth process |
| `@cantelop/sdk/harnesses/claude` | Shared native process handling, authentication, conversation state, and Dockerfile |

## Hosting terms

Review Anthropic's [conditions for offering Claude Code in a product](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products) and [credential rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). Every user authenticates and pays under their own agreement. Usage credits and plan limits may apply; this example does not guarantee a run avoids usage credits or provide legal approval.
