import { listRepositories } from './feature';
import { AzureDevOpsError } from '../../../shared/errors';

// Unit tests should only focus on isolated logic
describe('listRepositories unit', () => {
  test('should return empty array when no repositories are found', async () => {
    // Arrange
    const mockConnection: any = {
      getGitApi: jest.fn().mockImplementation(() => ({
        getRepositories: jest.fn().mockResolvedValue([]), // No repositories found
      })),
    };

    // Act
    const result = await listRepositories(mockConnection, {
      projectId: 'test-project',
    });

    // Assert
    expect(result).toEqual([]);
  });

  test('should propagate custom errors when thrown internally', async () => {
    // Arrange
    const mockConnection: any = {
      getGitApi: jest.fn().mockImplementation(() => {
        throw new AzureDevOpsError('Custom error');
      }),
    };

    // Act & Assert
    await expect(
      listRepositories(mockConnection, { projectId: 'test-project' }),
    ).rejects.toThrow(AzureDevOpsError);

    await expect(
      listRepositories(mockConnection, { projectId: 'test-project' }),
    ).rejects.toThrow('Custom error');
  });

  test('should wrap unexpected errors in a friendly error message', async () => {
    // Arrange
    const mockConnection: any = {
      getGitApi: jest.fn().mockImplementation(() => {
        throw new Error('Unexpected error');
      }),
    };

    // Act & Assert
    await expect(
      listRepositories(mockConnection, { projectId: 'test-project' }),
    ).rejects.toThrow('Failed to list repositories: Unexpected error');
  });

  test('should respect the includeLinks option', async () => {
    // Arrange
    const mockGetRepositories = jest.fn().mockResolvedValue([]);
    const mockConnection: any = {
      getGitApi: jest.fn().mockImplementation(() => ({
        getRepositories: mockGetRepositories,
      })),
    };

    // Act
    await listRepositories(mockConnection, {
      projectId: 'test-project',
      includeLinks: true,
    });

    // Assert
    expect(mockGetRepositories).toHaveBeenCalledWith('test-project', true);
  });

  test('should filter out disabled repositories', async () => {
    // Arrange
    const mockRepositories = [
      { id: '1', name: 'enabled-repo', isDisabled: false },
      { id: '2', name: 'disabled-repo', isDisabled: true },
      { id: '3', name: 'another-enabled-repo', isDisabled: false },
    ];
    const mockConnection: any = {
      getGitApi: jest.fn().mockImplementation(() => ({
        getRepositories: jest.fn().mockResolvedValue(mockRepositories),
      })),
    };

    // Act
    const result = await listRepositories(mockConnection, {
      projectId: 'test-project',
    });

    // Assert
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual([
      'enabled-repo',
      'another-enabled-repo',
    ]);
  });

  test('should not include isDisabled field in the response', async () => {
    // Arrange
    const mockRepositories = [
      { id: '1', name: 'enabled-repo', isDisabled: false, url: 'http://test' },
    ];
    const mockConnection: any = {
      getGitApi: jest.fn().mockImplementation(() => ({
        getRepositories: jest.fn().mockResolvedValue(mockRepositories),
      })),
    };

    // Act
    const result = await listRepositories(mockConnection, {
      projectId: 'test-project',
    });

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: '1',
      name: 'enabled-repo',
      url: 'http://test',
    });
    expect('isDisabled' in result[0]).toBe(false);
  });
});
