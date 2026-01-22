import { WorkItem } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';

/**
 * Options for linking a commit to a work item
 */
export interface LinkCommitToWorkItemOptions {
  workItemId: number;
  projectId: string;
  repositoryId: string;
  commitSha: string;
  operation: 'add' | 'remove';
  comment?: string;
}

/**
 * Options for linking a branch to a work item
 */
export interface LinkBranchToWorkItemOptions {
  workItemId: number;
  projectId: string;
  repositoryId: string;
  branchName: string;
  operation: 'add' | 'remove';
  comment?: string;
}

/**
 * Result of an artifact link operation
 */
export interface ArtifactLinkResult {
  success: boolean;
  workItemId: number;
  artifactUrl: string;
  operation: 'add' | 'remove';
  workItem?: WorkItem;
}

// Re-export WorkItem type for convenience
export type { WorkItem };
