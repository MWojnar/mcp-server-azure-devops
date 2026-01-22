import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolDefinition } from '../../shared/types/tool-definition';
import {
  LinkCommitToWorkItemSchema,
  LinkBranchToWorkItemSchema,
} from './schemas';

/**
 * List of artifact link tools
 */
export const artifactLinkTools: ToolDefinition[] = [
  {
    name: 'link_commit_to_work_item',
    description:
      'Link a Git commit to a work item. Use this after committing code that addresses a work item to track development progress.',
    inputSchema: zodToJsonSchema(LinkCommitToWorkItemSchema),
  },
  {
    name: 'link_branch_to_work_item',
    description:
      'Link a Git branch to a work item. Use this when starting work on a feature branch to associate it with the relevant ticket.',
    inputSchema: zodToJsonSchema(LinkBranchToWorkItemSchema),
  },
];
