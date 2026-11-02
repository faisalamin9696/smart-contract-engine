import { tokenIcon } from '../../src/state/store';

/**
 * The `icon` read-model projection (docs/TOKENS-DESIGN.md → "Token icon
 * convention"): REST and GraphQL expose a parsed `icon` field derived from the
 * token's free-form `metadata` string (`metadata.icon` — the wiki/Hive-Engine
 * issuer convention set via `tokens.updateMetadata`).
 *
 * The contract stays free-form on purpose; this parse is defence-in-depth for
 * public API consumers: a token whose metadata is empty, malformed or holds a
 * non-string `icon` must project to '' (frontend letter-avatar fallback),
 * never throw into a token list response.
 */

describe('tokenIcon (metadata.icon projection)', () => {
  it('returns the icon URL when metadata carries a string icon', () => {
    expect(tokenIcon('{"icon":"https://cdn.example.com/sce.png"}')).toBe('https://cdn.example.com/sce.png');
    // other keys alongside icon are preserved by the issuer and ignored here
    expect(tokenIcon('{"website":"https://x.example","icon":"https://y.example/i.svg","decimals":3}')).toBe(
      'https://y.example/i.svg',
    );
  });

  it('returns an empty string when metadata has no icon key', () => {
    expect(tokenIcon('')).toBe('');
    expect(tokenIcon('{}')).toBe('');
    expect(tokenIcon('{"website":"https://x.example"}')).toBe('');
  });

  it('returns an empty string for malformed or non-object metadata', () => {
    expect(tokenIcon('not json')).toBe('');
    expect(tokenIcon('null')).toBe('');
    expect(tokenIcon('[1,2,3]')).toBe(''); // array is not an object map
    expect(tokenIcon('"just a string"')).toBe('');
  });

  it('returns an empty string when icon is present but not a string', () => {
    expect(tokenIcon('{"icon":42}')).toBe('');
    expect(tokenIcon('{"icon":null}')).toBe('');
    expect(tokenIcon('{"icon":{"url":"https://x.example"}}')).toBe('');
  });
});
