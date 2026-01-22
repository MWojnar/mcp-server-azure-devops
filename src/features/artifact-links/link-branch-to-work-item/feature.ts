import { WebApi } from 'azure-devops-node-api';
import {
  WorkItemExpand,
  WorkItemRelation,
} from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import {
  AzureDevOpsResourceNotFoundError,
  AzureDevOpsError,
} from '../../../shared/errors';
import { LinkBranchToWorkItemOptions, ArtifactLinkResult } from '../types';

/**
 * Constructs the artifact URL for a Git branch ref
 *
 * @param projectId The project ID or name
 * @param repositoryId The repository ID or name
 * @param branchName The branch name (without refs/heads/ prefix)
 * @returns The vstfs:/// artifact URL
 */
function buildBranchArtifactUrl(
  projectId: string,
  repositoryId: string,
  branchName: string,
): string {
  // Encode the branch name with refs/heads/ prefix for the artifact URL
  // The format is: vstfs:///Git/Ref/{projectId}/{repositoryId}/{encodedRefName}
  const refName = `refs/heads/${branchName}`;
  const encodedRefName = encodeURIComponent(refName).replace(/%2F/g, '%252F');
  return `vstfs:///Git/Ref/${projectId}/${repositoryId}/${encodedRefName}`;
}

/**
 * Link or unlink a Git branch to/from a work item
 *
 * @param connection The Azure DevOps WebApi connection
 * @param options Options for the link operation
 * @returns The result of the link operation
 */
export async function linkBranchToWorkItem(
  connection: WebApi,
  options: LinkBranchToWorkItemOptions,
): Promise<ArtifactLinkResult> {
  const {
    workItemId,
    projectId,
    repositoryId,
    branchName,
    operation,
    comment,
  } = options;

  // Input validation
  if (!workItemId) {
    throw new Error('Work item ID is required');
  }

  if (!repositoryId) {
    throw new Error('Repository ID is required');
  }

  if (!branchName) {
    throw new Error('Branch name is required');
  }

  try {
    const witApi = await connection.getWorkItemTrackingApi();
    const artifactUrl = buildBranchArtifactUrl(
      projectId,
      repositoryId,
      branchName,
    );

    if (operation === 'add') {
      // Add the artifact link
      const document = [
        {
          op: 'add',
          path: '/relations/-',
          value: {
            rel: 'ArtifactLink',
            url: artifactUrl,
            attributes: {
              name: 'Branch',
              ...(comment ? { comment } : {}),
            },
          },
        },
      ];

      const updatedWorkItem = await witApi.updateWorkItem(
        {}, // customHeaders
        document,
        workItemId,
        projectId,
      );

      if (!updatedWorkItem) {
        throw new AzureDevOpsResourceNotFoundError(
          `Work item '${workItemId}' not found`,
        );
      }

      return {
        success: true,
        workItemId,
        artifactUrl,
        operation: 'add',
        workItem: updatedWorkItem,
      };
    } else {
      // Remove the artifact link - need to find the relation index first
      const workItem = await witApi.getWorkItem(
        workItemId,
        undefined, // fields
        undefined, // asOf
        WorkItemExpand.Relations,
      );

      if (!workItem) {
        throw new AzureDevOpsResourceNotFoundError(
          `Work item '${workItemId}' not found`,
        );
      }

      if (!workItem.relations) {
        throw new AzureDevOpsError(
          `Work item '${workItemId}' has no relations to remove`,
        );
      }

      // Find the relation to the branch
      const relationIndex = workItem.relations.findIndex(
        (rel: WorkItemRelation) =>
          rel.rel === 'ArtifactLink' && rel.url === artifactUrl,
      );

      if (relationIndex === -1) {
        throw new AzureDevOpsError(
          `Branch link not found on work item '${workItemId}'`,
        );
      }

      // Remove the relation by index
      const document = [
        {
          op: 'remove',
          path: `/relations/${relationIndex}`,
        },
      ];

      const updatedWorkItem = await witApi.updateWorkItem(
        {}, // customHeaders
        document,
        workItemId,
        projectId,
      );

      return {
        success: true,
        workItemId,
        artifactUrl,
        operation: 'remove',
        workItem: updatedWorkItem ?? undefined,
      };
    }
  } catch (error) {
    if (error instanceof AzureDevOpsError) {
      throw error;
    }
    throw new AzureDevOpsError(
      `Failed to ${operation} branch link: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
