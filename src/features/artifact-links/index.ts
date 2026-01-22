// Re-export schemas and types
export * from './schemas';
export * from './types';

// Re-export features
export * from './link-commit-to-work-item';
export * from './link-branch-to-work-item';

// Export tool definitions
export * from './tool-definitions';

// New exports for request handling
import { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { WebApi } from 'azure-devops-node-api';
import {
  RequestIdentifier,
  RequestHandler,
} from '../../shared/types/request-handler';
import { defaultProject } from '../../utils/environment';
import {
  LinkCommitToWorkItemSchema,
  LinkBranchToWorkItemSchema,
  linkCommitToWorkItem,
  linkBranchToWorkItem,
} from './';

// Define the response type based on observed usage
interface CallToolResponse {
  content: Array<{ type: string; text: string }>;
}

/**
 * Checks if the request is for the artifact links feature
 */
export const isArtifactLinksRequest: RequestIdentifier = (
  request: CallToolRequest,
): boolean => {
  const toolName = request.params.name;
  return ['link_commit_to_work_item', 'link_branch_to_work_item'].includes(
    toolName,
  );
};

/**
 * Handles artifact links feature requests
 */
export const handleArtifactLinksRequest: RequestHandler = async (
  connection: WebApi,
  request: CallToolRequest,
): Promise<CallToolResponse> => {
  switch (request.params.name) {
    case 'link_commit_to_work_item': {
      const args = LinkCommitToWorkItemSchema.parse(request.params.arguments);
      const result = await linkCommitToWorkItem(connection, {
        workItemId: args.workItemId,
        projectId: args.projectId ?? defaultProject,
        repositoryId: args.repositoryId,
        commitSha: args.commitSha,
        operation: args.operation,
        comment: args.comment,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    case 'link_branch_to_work_item': {
      const args = LinkBranchToWorkItemSchema.parse(request.params.arguments);
      const result = await linkBranchToWorkItem(connection, {
        workItemId: args.workItemId,
        projectId: args.projectId ?? defaultProject,
        repositoryId: args.repositoryId,
        branchName: args.branchName,
        operation: args.operation,
        comment: args.comment,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    default:
      throw new Error(`Unknown artifact links tool: ${request.params.name}`);
  }
};
