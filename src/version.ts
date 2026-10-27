import packageJson from '../package.json';

/**
 * Build identity surfaced by `GET /health`, `GET /` and `GET /api/v1/status`
 * so an operator can confirm at a glance which build a node runs — e.g. right
 * after an upgrade, or when cross-checking two nodes during verification.
 *
 * - `appVersion` comes from package.json and is bumped when cutting a release tag.
 * - `buildSha` is an optional build-time stamp (`SCE_BUILD_SHA=<git rev>` env);
 *   null when the build did not provide one (e.g. Dokploy builds that never set it).
 *
 * From `dist/src/version.js` the package.json import resolves to `dist/package.json`
 * (TypeScript copies the imported manifest into outDir), and locally that copy is
 * identical to the repo-root one; in the container both package.json files ship.
 */
export const appVersion: string =
  typeof packageJson.version === 'string' && packageJson.version.length > 0
    ? packageJson.version
    : 'unknown';

export const buildSha: string | null = process.env.SCE_BUILD_SHA?.trim() || null;
