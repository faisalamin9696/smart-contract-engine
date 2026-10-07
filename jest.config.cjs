/** Jest config: TS via ts-jest, deterministic single-worker execution. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Block ingestion is stateful; tests must not interleave workers.
  maxWorkers: 1,
  clearMocks: true,
  verbose: true,
  testTimeout: 30000,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
