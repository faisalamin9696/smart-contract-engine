import { createSandbox as baseCreateSandbox, type Sandbox, type SandboxOptions, type SandboxRequest } from '../../src/vm/sandbox';
import { emptySnapshot } from '../../src/types/domain';

export type { Sandbox, SandboxOptions, SandboxRequest };

/** Creates a sandbox for a specific provider with sensible test defaults. */
export async function createSandbox(
  provider: SandboxOptions['provider'],
  overrides: Partial<SandboxOptions> = {},
): Promise<Sandbox> {
  return baseCreateSandbox({
    provider,
    timeoutMs: 1000,
    memoryLimitMb: 128,
    ...overrides,
  });
}

/** Minimal valid request used by isolation tests (contract source is overridden). */
export function emptyRequest(): SandboxRequest {
  return {
    context: {
      action: 'mint',
      actor: 'alice',
      auths: { active: ['alice'], posting: [] },
      blockHeight: 1,
      blockId: 'f'.repeat(40),
      timestamp: '2026-01-01T00:00:00',
      txId: 'tx-1',
      opIndex: 0,
    },
    params: {},
    state: emptySnapshot(),
  };
}
