/* eslint-disable @typescript-eslint/no-require-imports */
const packageJson = require('../../../package.json') as { version: string };

/**
 * Current version of the Azure DevOps MCP server
 * Sourced from package.json to stay in sync with releases
 */
export const VERSION: string = packageJson.version;
