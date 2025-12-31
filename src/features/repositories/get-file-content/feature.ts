import { WebApi } from 'azure-devops-node-api';
import {
  GitVersionDescriptor,
  GitItem,
  GitVersionType,
  VersionControlRecursionType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AzureDevOpsResourceNotFoundError } from '../../../shared/errors';

/**
 * Response format for file content
 */
export interface FileContentResponse {
  content: string;
  isDirectory: boolean;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
  /** Note about content truncation (e.g., lines truncated, content capped) */
  truncationNote?: string;
}

const MAX_LINES = 1000;
const MAX_CHARACTERS = 20000;
const MAX_LINE_LENGTH = 1000;

/**
 * Truncates content to stay within character limits
 * First truncates long lines, then truncates total content if needed
 *
 * @param lines Array of lines to process
 * @param startLine 1-indexed start line
 * @param endLine 1-indexed end line
 * @returns Processed content with truncation info
 */
function truncateContent(
  lines: string[],
  startLine: number,
  endLine: number,
): {
  content: string;
  actualEndLine: number;
  truncationNote: string | undefined;
} {
  const notes: string[] = [];
  let truncatedLinesCount = 0;

  // First pass: truncate individual lines that exceed MAX_LINE_LENGTH
  const processedLines = lines.map((line) => {
    if (line.length > MAX_LINE_LENGTH) {
      truncatedLinesCount++;
      return line.substring(0, MAX_LINE_LENGTH) + ' [truncated]';
    }
    return line;
  });

  if (truncatedLinesCount > 0) {
    notes.push(
      `${truncatedLinesCount} line(s) exceeded ${MAX_LINE_LENGTH} characters and were truncated`,
    );
  }

  // Join and check total length
  let content = processedLines.join('\n');
  let actualEndLine = endLine;

  // Second pass: if still over MAX_CHARACTERS, remove lines from the end
  if (content.length > MAX_CHARACTERS) {
    let currentLength = 0;
    let lastValidIndex = 0;

    for (let i = 0; i < processedLines.length; i++) {
      const lineLength = processedLines[i].length + (i > 0 ? 1 : 0); // +1 for newline
      if (currentLength + lineLength > MAX_CHARACTERS) {
        break;
      }
      currentLength += lineLength;
      lastValidIndex = i;
    }

    // Take only the lines that fit
    const fittingLines = processedLines.slice(0, lastValidIndex + 1);
    content = fittingLines.join('\n');
    actualEndLine = startLine + lastValidIndex;

    const removedLines = processedLines.length - (lastValidIndex + 1);
    notes.push(
      `Content exceeded ${MAX_CHARACTERS} characters; truncated ${removedLines} line(s) from end`,
    );
  }

  return {
    content,
    actualEndLine,
    truncationNote: notes.length > 0 ? notes.join('. ') : undefined,
  };
}

/**
 * Get content of a file or directory from a repository
 *
 * @param connection - Azure DevOps WebApi connection
 * @param projectId - Project ID or name
 * @param repositoryId - Repository ID or name
 * @param path - Path to file or directory
 * @param versionDescriptor - Optional version descriptor for retrieving file at specific commit/branch/tag
 * @param startLine - Starting line number (1-indexed). Defaults to 1.
 * @param endLine - Ending line number (inclusive). If range exceeds 1000 or not provided, returns startLine + 999.
 * @returns Content of the file or list of items if path is a directory
 */
export async function getFileContent(
  connection: WebApi,
  projectId: string,
  repositoryId: string,
  path: string = '/',
  versionDescriptor?: { versionType: GitVersionType; version: string },
  startLine?: number,
  endLine?: number,
): Promise<FileContentResponse> {
  try {
    const gitApi = await connection.getGitApi();

    // Create version descriptor for API requests
    const gitVersionDescriptor: GitVersionDescriptor | undefined =
      versionDescriptor
        ? {
            version: versionDescriptor.version,
            versionType: versionDescriptor.versionType,
            versionOptions: undefined,
          }
        : undefined;

    // First, try to get items using the path to determine if it's a directory
    let isDirectory = false;
    let items: GitItem[] = [];

    try {
      items = await gitApi.getItems(
        repositoryId,
        projectId,
        path,
        VersionControlRecursionType.OneLevel,
        undefined,
        undefined,
        undefined,
        undefined,
        gitVersionDescriptor,
      );

      // If multiple items are returned or the path ends with /, it's a directory
      isDirectory = items.length > 1 || (path !== '/' && path.endsWith('/'));
    } catch {
      // If getItems fails, try to get file content directly
      isDirectory = false;
    }

    if (isDirectory) {
      // For directories, return a formatted list of the items
      return {
        content: JSON.stringify(items, null, 2),
        isDirectory: true,
      };
    } else {
      // For files, get the actual content
      try {
        // Get file content using the Git API
        const contentStream = await gitApi.getItemContent(
          repositoryId,
          path,
          projectId,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          gitVersionDescriptor,
          true,
        );

        // Convert the stream to a string
        if (contentStream) {
          const chunks: Buffer[] = [];

          // Listen for data events to collect chunks
          contentStream.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
          });

          // Use a promise to wait for the stream to finish
          const fullContent = await new Promise<string>((resolve, reject) => {
            contentStream.on('end', () => {
              // Concatenate all chunks and convert to string
              const buffer = Buffer.concat(chunks);
              resolve(buffer.toString('utf8'));
            });

            contentStream.on('error', (err) => {
              reject(err);
            });
          });

          // Apply line-based pagination
          const lines = fullContent.split('\n');
          const totalLines = lines.length;

          // Calculate effective start and end lines
          const effectiveStartLine = startLine ?? 1;
          let effectiveEndLine = endLine ?? effectiveStartLine + MAX_LINES - 1;

          // Cap range at MAX_LINES
          if (effectiveEndLine - effectiveStartLine + 1 > MAX_LINES) {
            effectiveEndLine = effectiveStartLine + MAX_LINES - 1;
          }

          // Clamp to actual file bounds
          const clampedStartLine = Math.max(1, effectiveStartLine);
          const clampedEndLine = Math.min(totalLines, effectiveEndLine);

          // Extract the requested lines (convert 1-indexed to 0-indexed)
          const selectedLines = lines.slice(
            clampedStartLine - 1,
            clampedEndLine,
          );

          // Apply character-based truncation to prevent token overflow
          const { content, actualEndLine, truncationNote } = truncateContent(
            selectedLines,
            clampedStartLine,
            clampedEndLine,
          );

          // Determine if content was truncated (either by line limit or character limit)
          const truncated = actualEndLine < totalLines;

          return {
            content,
            isDirectory: false,
            totalLines,
            startLine: clampedStartLine,
            endLine: actualEndLine,
            truncated,
            truncationNote,
          };
        }

        throw new Error('No content returned from API');
      } catch (error) {
        // If it's a 404 or similar error, throw a ResourceNotFoundError
        if (
          error instanceof Error &&
          (error.message.includes('not found') ||
            error.message.includes('does not exist'))
        ) {
          throw new AzureDevOpsResourceNotFoundError(
            `Path '${path}' not found in repository '${repositoryId}' of project '${projectId}'`,
          );
        }
        throw error;
      }
    }
  } catch (error) {
    // If it's already an AzureDevOpsResourceNotFoundError, rethrow it
    if (error instanceof AzureDevOpsResourceNotFoundError) {
      throw error;
    }

    // Otherwise, wrap it in a ResourceNotFoundError
    throw new AzureDevOpsResourceNotFoundError(
      `Failed to get content for path '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
