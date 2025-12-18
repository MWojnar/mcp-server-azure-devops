import { WebApi } from 'azure-devops-node-api';
import {
  GitPullRequestIterationChanges,
  GitChange,
  VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PolicyEvaluationRecord } from 'azure-devops-node-api/interfaces/PolicyInterfaces';
import { AzureDevOpsError } from '../../../shared/errors';
import { createTwoFilesPatch } from 'diff';

export interface PullRequestChangesOptions {
  projectId: string;
  repositoryId: string;
  pullRequestId: number;
  includeDiffs?: boolean;
}

export interface PullRequestFileChange {
  path: string;
  changeType?: string;
  patch?: string;
}

export interface PullRequestChangesResponse {
  changes: GitPullRequestIterationChanges;
  evaluations: PolicyEvaluationRecord[];
  files: PullRequestFileChange[];
  sourceRefName?: string;
  targetRefName?: string;
}

/**
 * Convert VersionControlChangeType enum to a human-readable string
 */
function getChangeTypeName(changeType?: VersionControlChangeType): string {
  if (changeType === undefined) return 'unknown';
  const changeTypeMap: Record<number, string> = {
    [VersionControlChangeType.None]: 'none',
    [VersionControlChangeType.Add]: 'add',
    [VersionControlChangeType.Edit]: 'edit',
    [VersionControlChangeType.Encoding]: 'encoding',
    [VersionControlChangeType.Rename]: 'rename',
    [VersionControlChangeType.Delete]: 'delete',
    [VersionControlChangeType.Undelete]: 'undelete',
    [VersionControlChangeType.Branch]: 'branch',
    [VersionControlChangeType.Merge]: 'merge',
    [VersionControlChangeType.Lock]: 'lock',
    [VersionControlChangeType.Rollback]: 'rollback',
    [VersionControlChangeType.SourceRename]: 'sourceRename',
    [VersionControlChangeType.TargetRename]: 'targetRename',
    [VersionControlChangeType.Property]: 'property',
    [VersionControlChangeType.All]: 'all',
  };
  return changeTypeMap[changeType] ?? 'unknown';
}

/**
 * Retrieve changes and policy evaluation status for a pull request
 */
export async function getPullRequestChanges(
  connection: WebApi,
  options: PullRequestChangesOptions,
): Promise<PullRequestChangesResponse> {
  try {
    const gitApi = await connection.getGitApi();
    const [pullRequest, iterations] = await Promise.all([
      gitApi.getPullRequest(
        options.repositoryId,
        options.pullRequestId,
        options.projectId,
      ),
      gitApi.getPullRequestIterations(
        options.repositoryId,
        options.pullRequestId,
        options.projectId,
      ),
    ]);
    if (!iterations || iterations.length === 0) {
      throw new AzureDevOpsError('No iterations found for pull request');
    }
    const latest = iterations[iterations.length - 1];
    const changes = await gitApi.getPullRequestIterationChanges(
      options.repositoryId,
      options.pullRequestId,
      latest.id!,
      options.projectId,
    );

    const policyApi = await connection.getPolicyApi();
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${options.projectId}/${options.pullRequestId}`;
    const evaluations = await policyApi.getPolicyEvaluations(
      options.projectId,
      artifactId,
    );

    const changeEntries = changes.changeEntries ?? [];

    let files: PullRequestFileChange[];

    if (options.includeDiffs) {
      // Fetch full diffs for each file
      const getBlobText = async (objId?: string): Promise<string> => {
        if (!objId) return '';
        const stream = await gitApi.getBlobContent(
          options.repositoryId,
          objId,
          options.projectId,
        );

        const chunks: Uint8Array[] = [];
        return await new Promise<string>((resolve, reject) => {
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on('end', () =>
            resolve(Buffer.concat(chunks).toString('utf8')),
          );
          stream.on('error', reject);
        });
      };

      files = await Promise.all(
        changeEntries.map(async (entry: GitChange) => {
          const path = entry.item?.path || entry.originalPath || '';
          const [oldContent, newContent] = await Promise.all([
            getBlobText(entry.item?.originalObjectId),
            getBlobText(entry.item?.objectId),
          ]);
          const patch = createTwoFilesPatch(
            entry.originalPath || path,
            path,
            oldContent,
            newContent,
          );
          return {
            path,
            changeType: getChangeTypeName(entry.changeType),
            patch,
          };
        }),
      );
    } else {
      // Return only file paths and change types (no diffs)
      files = changeEntries.map((entry: GitChange) => ({
        path: entry.item?.path || entry.originalPath || '',
        changeType: getChangeTypeName(entry.changeType),
      }));
    }

    return {
      changes,
      evaluations,
      files,
      sourceRefName: pullRequest?.sourceRefName,
      targetRefName: pullRequest?.targetRefName,
    };
  } catch (error) {
    if (error instanceof AzureDevOpsError) {
      throw error;
    }
    throw new Error(
      `Failed to get pull request changes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
