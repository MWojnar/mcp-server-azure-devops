import { WebApi } from 'azure-devops-node-api';
import {
  GitPullRequestIterationChanges,
  GitChange,
  VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PolicyEvaluationRecord } from 'azure-devops-node-api/interfaces/PolicyInterfaces';
import { AzureDevOpsError } from '../../../shared/errors';
import { createTwoFilesPatch } from 'diff';

/** Maximum characters for a single patch before truncation */
const MAX_PATCH_LENGTH = 10000;
/** Maximum total characters across all patches in the response */
const MAX_TOTAL_PATCH_SIZE = 50000;

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
  /** Indicates if the patch was truncated due to size limits */
  truncated?: boolean;
}

export interface PullRequestChangesResponse {
  changes: GitPullRequestIterationChanges;
  evaluations: PolicyEvaluationRecord[];
  files: PullRequestFileChange[];
  sourceRefName?: string;
  targetRefName?: string;
  /** Note about any truncation applied to patch content */
  truncationNote?: string;
}

/**
 * Truncates a patch if it exceeds the maximum length
 */
function truncatePatch(patch: string): { patch: string; truncated: boolean } {
  if (patch.length <= MAX_PATCH_LENGTH) {
    return { patch, truncated: false };
  }
  return {
    patch:
      patch.substring(0, MAX_PATCH_LENGTH) +
      '\n... [truncated - patch exceeded ' +
      MAX_PATCH_LENGTH +
      ' characters]',
    truncated: true,
  };
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
    let truncationNote: string | undefined;

    if (options.includeDiffs) {
      // Fetch full diffs for each file, with truncation
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

      let totalPatchSize = 0;
      let truncatedPatchCount = 0;
      let omittedPatchCount = 0;
      const totalBudgetExceeded = () => totalPatchSize >= MAX_TOTAL_PATCH_SIZE;

      files = await Promise.all(
        changeEntries.map(async (entry: GitChange) => {
          const path = entry.item?.path || entry.originalPath || '';
          const changeType = getChangeTypeName(entry.changeType);

          // If we've exceeded total budget, skip fetching more diffs
          if (totalBudgetExceeded()) {
            omittedPatchCount++;
            return {
              path,
              changeType,
              patch: '[omitted - total patch size limit reached]',
              truncated: true,
            };
          }

          const [oldContent, newContent] = await Promise.all([
            getBlobText(entry.item?.originalObjectId),
            getBlobText(entry.item?.objectId),
          ]);
          const rawPatch = createTwoFilesPatch(
            entry.originalPath || path,
            path,
            oldContent,
            newContent,
          );

          const { patch, truncated } = truncatePatch(rawPatch);
          if (truncated) {
            truncatedPatchCount++;
          }
          totalPatchSize += patch.length;

          return {
            path,
            changeType,
            patch,
            truncated: truncated || undefined,
          };
        }),
      );

      // Build truncation note if any truncation occurred
      if (truncatedPatchCount > 0 || omittedPatchCount > 0) {
        const notes: string[] = [];
        if (truncatedPatchCount > 0) {
          notes.push(
            `${truncatedPatchCount} patch(es) truncated (exceeded ${MAX_PATCH_LENGTH} chars)`,
          );
        }
        if (omittedPatchCount > 0) {
          notes.push(
            `${omittedPatchCount} patch(es) omitted (total size limit of ${MAX_TOTAL_PATCH_SIZE} chars reached)`,
          );
        }
        truncationNote = notes.join('; ');
      }
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
      truncationNote,
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
