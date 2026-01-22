import { z } from 'zod';
import { defaultProject } from '../../utils/environment';

/**
 * Schema for linking a commit to a work item
 */
export const LinkCommitToWorkItemSchema = z.object({
  workItemId: z.number().describe('The ID of the work item to link'),
  projectId: z
    .string()
    .optional()
    .describe(`The ID or name of the project (Default: ${defaultProject})`),
  repositoryId: z
    .string()
    .describe('The ID or name of the repository containing the commit'),
  commitSha: z
    .string()
    .describe('The full SHA of the commit to link (40 characters)'),
  operation: z
    .enum(['add', 'remove'])
    .describe('The operation to perform: add or remove the link'),
  comment: z
    .string()
    .optional()
    .describe('Optional comment explaining the link'),
});

/**
 * Schema for linking a branch to a work item
 */
export const LinkBranchToWorkItemSchema = z.object({
  workItemId: z.number().describe('The ID of the work item to link'),
  projectId: z
    .string()
    .optional()
    .describe(`The ID or name of the project (Default: ${defaultProject})`),
  repositoryId: z
    .string()
    .describe('The ID or name of the repository containing the branch'),
  branchName: z
    .string()
    .describe(
      'The name of the branch to link (without refs/heads/ prefix, e.g., "feature/my-branch")',
    ),
  operation: z
    .enum(['add', 'remove'])
    .describe('The operation to perform: add or remove the link'),
  comment: z
    .string()
    .optional()
    .describe('Optional comment explaining the link'),
});
