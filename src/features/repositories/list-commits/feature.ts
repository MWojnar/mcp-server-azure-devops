import { WebApi } from 'azure-devops-node-api';
import {
  GitChange,
  GitVersionType,
  VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { createTwoFilesPatch } from 'diff';
import { AzureDevOpsError } from '../../../shared/errors';
import {
  CommitFileChange,
  CommitWithContent,
  ListCommitsOptions,
  ListCommitsResponse,
} from '../types';

/** Maximum characters for a single patch before truncation */
const MAX_PATCH_LENGTH = 10000;
/** Maximum total characters across all patches in the response */
const MAX_TOTAL_PATCH_SIZE = 50000;

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', (err) => reject(err));
  });
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
 * List commits on a branch with optional file level diffs
 */
export async function listCommits(
  connection: WebApi,
  options: ListCommitsOptions,
): Promise<ListCommitsResponse> {
  try {
    const gitApi = await connection.getGitApi();
    const commits = await gitApi.getCommits(
      options.repositoryId,
      {
        itemVersion: {
          version: options.branchName,
          versionType: GitVersionType.Branch,
        },
        $top: options.top ?? 10,
        $skip: options.skip,
      },
      options.projectId,
    );

    if (!commits || commits.length === 0) {
      return { commits: [] };
    }

    const getBlobText = async (objId?: string): Promise<string> => {
      if (!objId) {
        return '';
      }
      const stream = await gitApi.getBlobContent(
        options.repositoryId,
        objId,
        options.projectId,
      );
      return stream ? await streamToString(stream) : '';
    };

    const commitsWithContent: CommitWithContent[] = [];
    let totalPatchSize = 0;
    let truncatedPatchCount = 0;
    let omittedPatchCount = 0;
    const totalBudgetExceeded = () => totalPatchSize >= MAX_TOTAL_PATCH_SIZE;

    for (const commit of commits) {
      const commitId = commit.commitId;
      if (!commitId) {
        continue;
      }

      const commitChanges = await gitApi.getChanges(
        commitId,
        options.repositoryId,
        options.projectId,
      );
      const changeEntries = commitChanges?.changes ?? [];

      let files: CommitFileChange[];

      if (options.includeDiffs) {
        // Fetch full diffs for each file, with truncation
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
      } else {
        // Return only file paths and change types (no diffs)
        files = changeEntries.map((entry: GitChange) => ({
          path: entry.item?.path || entry.originalPath || '',
          changeType: getChangeTypeName(entry.changeType),
        }));
      }

      commitsWithContent.push({
        commitId,
        comment: commit.comment,
        author: commit.author,
        committer: commit.committer,
        url: commit.url,
        parents: commit.parents,
        files,
      });
    }

    // Build truncation note if any truncation occurred
    let truncationNote: string | undefined;
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

    return { commits: commitsWithContent, truncationNote };
  } catch (error) {
    if (error instanceof AzureDevOpsError) {
      throw error;
    }
    throw new Error(
      `Failed to list commits: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
