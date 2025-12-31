import { WebApi } from 'azure-devops-node-api';
import axios from 'axios';
import { DefaultAzureCredential, AzureCliCredential } from '@azure/identity';
import {
  AzureDevOpsError,
  AzureDevOpsResourceNotFoundError,
  AzureDevOpsValidationError,
  AzureDevOpsPermissionError,
  AzureDevOpsAuthenticationError,
} from '../../../shared/errors';
import {
  SearchCodeOptions,
  CodeSearchRequest,
  CodeSearchResponse,
  CodeSearchResult,
} from '../types';
import { CODE_SEARCH_PAGE_SIZE } from '../schemas';
import { GitVersionType } from 'azure-devops-node-api/interfaces/GitInterfaces';

// Content truncation constants
const MAX_CONTENT_CHARACTERS = 20000;
const MAX_LINE_LENGTH = 1000;

/**
 * Truncates content to stay within character limits
 * First truncates long lines, then truncates total content if needed
 *
 * @param content The raw content string
 * @returns Truncated content string
 */
function truncateFileContent(content: string): string {
  const lines = content.split('\n');

  // First pass: truncate individual lines that exceed MAX_LINE_LENGTH
  const processedLines = lines.map((line) => {
    if (line.length > MAX_LINE_LENGTH) {
      return line.substring(0, MAX_LINE_LENGTH) + ' [truncated]';
    }
    return line;
  });

  // Join and check total length
  let result = processedLines.join('\n');

  // Second pass: if still over MAX_CONTENT_CHARACTERS, truncate from end
  if (result.length > MAX_CONTENT_CHARACTERS) {
    let currentLength = 0;
    let lastValidIndex = 0;

    for (let i = 0; i < processedLines.length; i++) {
      const lineLength = processedLines[i].length + (i > 0 ? 1 : 0); // +1 for newline
      if (currentLength + lineLength > MAX_CONTENT_CHARACTERS) {
        break;
      }
      currentLength += lineLength;
      lastValidIndex = i;
    }

    // Take only the lines that fit
    const fittingLines = processedLines.slice(0, lastValidIndex + 1);
    result = fittingLines.join('\n');
    result += '\n[content truncated due to size limits]';
  }

  return result;
}

/**
 * Search for code in Azure DevOps repositories
 *
 * @param connection The Azure DevOps WebApi connection
 * @param options Parameters for searching code
 * @returns Search results with optional file content
 */
export async function searchCode(
  connection: WebApi,
  options: SearchCodeOptions,
): Promise<CodeSearchResponse> {
  try {
    // Calculate pagination values from page number
    // Treat invalid/negative page as 0
    const page = Math.max(0, options.page ?? 0);

    // When includeContent is true, limit results to prevent timeouts (max 10)
    const top = options.includeContent
      ? Math.min(CODE_SEARCH_PAGE_SIZE, 10)
      : CODE_SEARCH_PAGE_SIZE;

    const skip = page * CODE_SEARCH_PAGE_SIZE;

    // Get the project ID (either provided or default)
    const projectId =
      options.projectId || process.env.AZURE_DEVOPS_DEFAULT_PROJECT;

    if (!projectId) {
      throw new AzureDevOpsValidationError(
        'Project ID is required. Either provide a projectId or set the AZURE_DEVOPS_DEFAULT_PROJECT environment variable.',
      );
    }

    // Prepare the search request
    const searchRequest: CodeSearchRequest = {
      searchText: options.searchText,
      $skip: skip,
      $top: top,
      filters: {
        Project: [projectId],
        ...(options.filters || {}),
      },
      includeFacets: true,
      includeSnippet: options.includeSnippet,
    };

    // Get the authorization header from the connection
    const authHeader = await getAuthorizationHeader();

    // Extract organization from the connection URL
    const { organization } = extractOrgFromUrl(connection);

    // Make the search API request with the project ID
    const searchUrl = `https://almsearch.dev.azure.com/${organization}/${projectId}/_apis/search/codesearchresults?api-version=7.1`;

    const searchResponse = await axios.post<CodeSearchResponse>(
      searchUrl,
      searchRequest,
      {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
      },
    );

    const results = searchResponse.data;

    // If includeContent is true, fetch the content for each result
    if (options.includeContent && results.results.length > 0) {
      await enrichResultsWithContent(connection, results.results);
    }

    // Add pagination metadata
    const totalPages = Math.ceil(results.count / CODE_SEARCH_PAGE_SIZE);
    const hasMore = page < totalPages - 1;

    return {
      ...results,
      currentPage: page,
      totalPages,
      pageSize: CODE_SEARCH_PAGE_SIZE,
      hasMore,
    };
  } catch (error) {
    if (error instanceof AzureDevOpsError) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 404) {
        throw new AzureDevOpsResourceNotFoundError(
          'Repository or project not found',
          { cause: error },
        );
      }
      if (status === 400) {
        throw new AzureDevOpsValidationError(
          'Invalid search parameters',
          error.response?.data,
          { cause: error },
        );
      }
      if (status === 401) {
        throw new AzureDevOpsAuthenticationError('Authentication failed', {
          cause: error,
        });
      }
      if (status === 403) {
        throw new AzureDevOpsPermissionError(
          'Permission denied to access repository',
          { cause: error },
        );
      }
    }

    throw new AzureDevOpsError('Failed to search code', { cause: error });
  }
}

/**
 * Extract organization from the connection URL
 *
 * @param connection The Azure DevOps WebApi connection
 * @returns The organization
 */
function extractOrgFromUrl(connection: WebApi): { organization: string } {
  // Extract organization from the connection URL
  const url = connection.serverUrl;
  const match = url.match(/https?:\/\/dev\.azure\.com\/([^/]+)/);
  const organization = match ? match[1] : '';

  if (!organization) {
    throw new AzureDevOpsValidationError(
      'Could not extract organization from connection URL',
    );
  }

  return {
    organization,
  };
}

/**
 * Get the authorization header from the connection
 *
 * @returns The authorization header
 */
async function getAuthorizationHeader(): Promise<string> {
  try {
    // For PAT authentication, we can construct the header directly
    if (
      process.env.AZURE_DEVOPS_AUTH_METHOD?.toLowerCase() === 'pat' &&
      process.env.AZURE_DEVOPS_PAT
    ) {
      // For PAT auth, we can construct the Basic auth header directly
      const token = process.env.AZURE_DEVOPS_PAT;
      const base64Token = Buffer.from(`:${token}`).toString('base64');
      return `Basic ${base64Token}`;
    }

    // For Azure Identity / Azure CLI auth, we need to get a token
    // using the Azure DevOps resource ID
    // Choose the appropriate credential based on auth method
    const credential =
      process.env.AZURE_DEVOPS_AUTH_METHOD?.toLowerCase() === 'azure-cli'
        ? new AzureCliCredential()
        : new DefaultAzureCredential();

    // Azure DevOps resource ID for token acquisition
    const AZURE_DEVOPS_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

    // Get token for Azure DevOps
    const token = await credential.getToken(
      `${AZURE_DEVOPS_RESOURCE_ID}/.default`,
    );

    if (!token || !token.token) {
      throw new Error('Failed to acquire token for Azure DevOps');
    }

    return `Bearer ${token.token}`;
  } catch (error) {
    throw new AzureDevOpsValidationError(
      `Failed to get authorization header: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Enrich search results with file content
 *
 * @param connection The Azure DevOps WebApi connection
 * @param results The search results to enrich
 */
async function enrichResultsWithContent(
  connection: WebApi,
  results: CodeSearchResult[],
): Promise<void> {
  try {
    const gitApi = await connection.getGitApi();

    // Process each result in parallel
    await Promise.all(
      results.map(async (result) => {
        try {
          // Get the file content using the Git API
          // Pass only the required parameters to avoid the "path" and "scopePath" conflict
          const contentStream = await gitApi.getItemContent(
            result.repository.id,
            result.path,
            result.project.name,
            undefined, // No version descriptor object
            undefined, // No recursion level
            undefined, // Don't include content metadata
            undefined, // No latest processed change
            false, // Don't download
            {
              version: result.versions[0]?.changeId,
              versionType: GitVersionType.Commit,
            }, // Version descriptor
            true, // Include content
          );

          // Convert the stream to a string and store it in the result
          if (contentStream) {
            // Since getItemContent always returns NodeJS.ReadableStream, we need to read the stream
            const chunks: Buffer[] = [];

            // Listen for data events to collect chunks
            contentStream.on('data', (chunk) => {
              chunks.push(Buffer.from(chunk));
            });

            // Use a promise to wait for the stream to finish
            const rawContent = await new Promise<string>((resolve, reject) => {
              contentStream.on('end', () => {
                // Concatenate all chunks and convert to string
                const buffer = Buffer.concat(chunks);
                resolve(buffer.toString('utf8'));
              });

              contentStream.on('error', (err) => {
                reject(err);
              });
            });

            // Apply truncation to prevent token overflow
            result.content = truncateFileContent(rawContent);
          }
        } catch (error) {
          // Log the error but don't fail the entire operation
          console.error(
            `Failed to fetch content for ${result.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  } catch (error) {
    // Log the error but don't fail the entire operation
    console.error(
      `Failed to enrich results with content: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
