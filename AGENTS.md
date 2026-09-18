# Project instructions

- This is a Cantelop SDK app. Use `@cantelop/sdk/api` for Edge routes and `@cantelop/sdk/session` for Session behaviours and managed activities. Let Cantelop manage Workspaces, Sandbox lifecycle, and event transport.
- Run `npm run check`, `npm test`, and `npm run build` for code changes. Use `cantelop build` when changing the runtime image or manifest.
- Commit completed code changes. The user explicitly requested that code always be committed.
- Keep Claude Code unmodified and use its native authentication flow. Do not add Claude credential collection or custom OAuth endpoints.
