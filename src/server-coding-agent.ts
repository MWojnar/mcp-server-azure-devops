import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebApi } from 'azure-devops-node-api';
import { VERSION } from './shared/config';
import { AzureDevOpsConfig } from './shared/types';
import {
  AzureDevOpsAuthenticationError,
  AzureDevOpsValidationError,
} from './shared/errors';
import { handleResponseError } from './shared/errors/handle-request-error';
import { AuthenticationMethod, AzureDevOpsClient } from './shared/auth';

// Import feature modules for coding agent
import {
  workItemsTools,
  isWorkItemsRequest,
  handleWorkItemsRequest,
} from './features/work-items';

import {
  projectsTools,
  isProjectsRequest,
  handleProjectsRequest,
} from './features/projects';

import {
  searchTools,
  isSearchRequest,
  handleSearchRequest,
} from './features/search';

import {
  usersTools,
  isUsersRequest,
  handleUsersRequest,
} from './features/users';

import {
  artifactLinkTools,
  isArtifactLinksRequest,
  handleArtifactLinksRequest,
} from './features/artifact-links';

/**
 * Type definition for the Azure DevOps Coding Agent MCP Server
 */
export type AzureDevOpsCodingAgentServer = Server;

/**
 * Filter tool arrays to only include tools needed for coding agents
 */
const codingAgentSearchTools = searchTools.filter(
  (tool) => tool.name === 'search_work_items',
);

const codingAgentProjectsTools = projectsTools.filter(
  (tool) => tool.name === 'list_projects' || tool.name === 'get_project',
);

/**
 * Create an Azure DevOps MCP Server optimized for coding agents
 *
 * This variant provides only work item management and commit/branch linking tools.
 * It does not include repository browsing, file content, pull request, or pipeline tools
 * since coding agents typically have local repository access.
 *
 * @param config The Azure DevOps configuration
 * @returns A configured MCP server instance
 */
export function createCodingAgentServer(config: AzureDevOpsConfig): Server {
  // Validate the configuration
  validateConfig(config);

  // Initialize the MCP server with coding agent identity
  const server = new Server(
    {
      name: 'azure-devops-mcp-coding-agent',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        // No resources - coding agents have local repository access
      },
      instructions: `Azure DevOps MCP Server (Coding Agent Edition) v${VERSION}.

This server is designed for LLM coding agents that have local Git repository access.
It provides work item management and commit/branch linking capabilities.

Available tools:
- Work Items: list_work_items, get_work_item, create_work_item, update_work_item, manage_work_item_link
- Projects: list_projects, get_project
- Search: search_work_items
- Artifact Links: link_commit_to_work_item, link_branch_to_work_item
- User: get_me

Since you have local repository access, this server does NOT provide:
- Repository browsing (use local git commands)
- File content reading (use local file access)
- Pull request management (use after pushing to remote)
- Pipeline operations (handled separately)

Typical workflow:
1. search_work_items - Find your assigned ticket
2. get_work_item - Understand requirements
3. link_branch_to_work_item - Associate your feature branch
4. Make code changes locally
5. link_commit_to_work_item - Associate your commits
6. update_work_item - Change status to Done`,
    },
  );

  // Register the ListTools request handler with coding agent tools only
  server.setRequestHandler(ListToolsRequestSchema, () => {
    // Combine tools for coding agent variant
    const tools = [
      ...usersTools, // get_me
      ...codingAgentProjectsTools, // list_projects, get_project
      ...workItemsTools, // all work item tools
      ...codingAgentSearchTools, // search_work_items only
      ...artifactLinkTools, // link_commit_to_work_item, link_branch_to_work_item
    ];

    return { tools };
  });

  // No resource handlers for coding agent variant
  // Coding agents have local repository access

  // Register the CallTool request handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      // Get a connection to Azure DevOps
      const connection = await getConnection(config);

      // Route the request to the appropriate feature handler
      if (isWorkItemsRequest(request)) {
        return await handleWorkItemsRequest(connection, request);
      }

      if (isProjectsRequest(request)) {
        return await handleProjectsRequest(connection, request);
      }

      if (isSearchRequest(request)) {
        return await handleSearchRequest(connection, request);
      }

      if (isUsersRequest(request)) {
        return await handleUsersRequest(connection, request);
      }

      if (isArtifactLinksRequest(request)) {
        return await handleArtifactLinksRequest(connection, request);
      }

      // If we get here, the tool is not recognized by any feature handler
      throw new Error(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      return handleResponseError(error);
    }
  });

  return server;
}

/**
 * Validate the Azure DevOps configuration
 *
 * @param config The configuration to validate
 * @throws {AzureDevOpsValidationError} If the configuration is invalid
 */
function validateConfig(config: AzureDevOpsConfig): void {
  if (!config.organizationUrl) {
    process.stderr.write(
      'ERROR: Organization URL is required but was not provided.\n',
    );
    process.stderr.write(
      `Config: ${JSON.stringify(
        {
          organizationUrl: config.organizationUrl,
          authMethod: config.authMethod,
          defaultProject: config.defaultProject,
          // Hide PAT for security
          personalAccessToken: config.personalAccessToken
            ? 'REDACTED'
            : undefined,
          apiVersion: config.apiVersion,
        },
        null,
        2,
      )}\n`,
    );
    throw new AzureDevOpsValidationError('Organization URL is required');
  }

  // Set default authentication method if not specified
  if (!config.authMethod) {
    config.authMethod = AuthenticationMethod.AzureIdentity;
  }

  // Validate PAT if using PAT authentication
  if (
    config.authMethod === AuthenticationMethod.PersonalAccessToken &&
    !config.personalAccessToken
  ) {
    throw new AzureDevOpsValidationError(
      'Personal access token is required when using PAT authentication',
    );
  }
}

/**
 * Create a connection to Azure DevOps
 *
 * @param config The configuration to use
 * @returns A WebApi connection
 */
async function getConnection(config: AzureDevOpsConfig): Promise<WebApi> {
  try {
    // Create a client with the appropriate authentication method
    const client = new AzureDevOpsClient({
      method: config.authMethod || AuthenticationMethod.AzureIdentity,
      organizationUrl: config.organizationUrl,
      personalAccessToken: config.personalAccessToken,
    });

    // Test the connection by getting the Core API
    await client.getCoreApi();

    // Return the underlying WebApi client
    return await client.getWebApiClient();
  } catch (error) {
    throw new AzureDevOpsAuthenticationError(
      `Failed to connect to Azure DevOps: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
