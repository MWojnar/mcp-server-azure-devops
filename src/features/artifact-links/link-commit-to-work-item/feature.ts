import { WebApi } from 'azure-devops-node-api';
import {
  WorkItemExpand,
  WorkItemRelation,
} from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import {
  AzureDevOpsResourceNotFoundError,
  AzureDevOpsError,
} from '../../../shared/errors';
import { LinkCommitToWorkItemOptions, ArtifactLinkResult } from '../types';

/**
 * Constructs the artifact URL for a Git commit
 *
 * @param projectId The project ID or name
 * @param repositoryId The repository ID or name
 * @param commitSha The full commit SHA
 * @returns The vstfs:/// artifact URL
 */
function buildCommitArtifactUrl(
  projectId: string,
  repositoryId: string,
  commitSha: string,
): string {
  return `vstfs:///Git/Commit/${projectId}/${repositoryId}/${commitSha}`;
}

/**
 * Link or unlink a Git commit to/from a work item
 *
 * @param connection The Azure DevOps WebApi connection
 * @param options Options for the link operation
 * @returns The result of the link operation
 */
export async function linkCommitToWorkItem(
  connection: WebApi,
  options: LinkCommitToWorkItemOptions,
): Promise<ArtifactLinkResult> {
  const { workItemId, projectId, repositoryId, commitSha, operation, comment } =
    options;

  // Input validation
  if (!workItemId) {
    throw new Error('Work item ID is required');
  }

  if (!repositoryId) {
    throw new Error('Repository ID is required');
  }

  if (!commitSha) {
    throw new Error('Commit SHA is required');
  }

  try {
    const witApi = await connection.getWorkItemTrackingApi();
    const artifactUrl = buildCommitArtifactUrl(
      projectId,
      repositoryId,
      commitSha,
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
              name: 'Fixed in Commit',
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

      // Find the relation to the commit
      const relationIndex = workItem.relations.findIndex(
        (rel: WorkItemRelation) =>
          rel.rel === 'ArtifactLink' && rel.url === artifactUrl,
      );

      if (relationIndex === -1) {
        throw new AzureDevOpsError(
          `Commit link not found on work item '${workItemId}'`,
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
      `Failed to ${operation} commit link: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
