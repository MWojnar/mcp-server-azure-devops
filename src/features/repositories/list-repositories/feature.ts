import { WebApi } from 'azure-devops-node-api';
import { AzureDevOpsError } from '../../../shared/errors';
import { ListRepositoriesOptions, GitRepository } from '../types';

/**
 * List repositories in a project
 *
 * @param connection The Azure DevOps WebApi connection
 * @param options Parameters for listing repositories
 * @returns Array of repositories
 */
export async function listRepositories(
  connection: WebApi,
  options: ListRepositoriesOptions,
): Promise<Omit<GitRepository, 'isDisabled'>[]> {
  try {
    const gitApi = await connection.getGitApi();
    const repositories = await gitApi.getRepositories(
      options.projectId,
      options.includeLinks,
    );

    // Filter out disabled repositories and remove the isDisabled field
    return repositories
      .filter((repo) => !repo.isDisabled)
      .map(({ isDisabled: _isDisabled, ...rest }) => rest);
  } catch (error) {
    if (error instanceof AzureDevOpsError) {
      throw error;
    }
    throw new Error(
      `Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
