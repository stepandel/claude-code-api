import { CantelopClient } from '@cantelop/sdk';
import { receive, onRecover } from './session.js';
import api from './api.js';
import type { Command, Event, Reply } from './contracts.js';

const cantelop = new CantelopClient();
export const app = cantelop.app<Command, Event, Reply>({
  name: 'cantelop-claude-api',
  runtime: { receive, onRecover },
  dockerfile: 'docker/Dockerfile',
  environment: {
    AUTH_PUBLIC_JWK: {required:true},
    AUTH_ISSUER: {required:true},
    AUTH_AUDIENCE: {default:'cantelop-claude-api',required:true},
  },
  homepage: () => Response.json({ok:true}),
  webhooks: {
    '/webhooks/v1/auth': {method:'POST',handle:api},
    '/webhooks/v1/auth/login': {method:'POST',handle:api},
    '/webhooks/v1/auth/login/code': {method:'POST',handle:api},
    '/webhooks/v1/auth/cancel': {method:'POST',handle:api},
    '/webhooks/v1/auth/logout': {method:'POST',handle:api},
    '/webhooks/v1/sessions': {method:'POST',handle:api},
    '/webhooks/v1/messages': {method:'POST',handle:api},
    '/webhooks/v1/cancel': {method:'POST',handle:api},
    '/webhooks/v1/snapshot': {method:'POST',handle:api},
    '/webhooks/v1/events': {method:'GET',handle:api},
  },
});
