import { CantelopClient } from '@cantelop/sdk';
import { claudeDockerfile } from '@cantelop/sdk/harnesses/claude';
import { receive, onRecover } from './session.js';
import type { Command, Event, Reply } from './contracts.js';

const cantelop = new CantelopClient();
export const app = cantelop.app<Command, Event, Reply>({
  name: 'cantelop-claude-api',
  runtime: { receive, onRecover },
  dockerfile: claudeDockerfile,
});
