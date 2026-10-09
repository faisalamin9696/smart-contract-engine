import { getIntrospectionQuery, parse } from 'graphql';

import { analyzeQuery, MAX_QUERY_ALIASES, MAX_QUERY_DEPTH, MAX_QUERY_DIRECTIVES } from '../../src/api/graphql';

/**
 * GraphQL query-cost analysis (SECURITY.md → "Query complexity").
 *
 * The plugin runs this before any resolver, so the numbers here decide what
 * lives or dies on a public endpoint: alias breadth (N×100 rows), directive
 * counts, and nesting — with fragments resolved, because otherwise the cost
 * just hides inside a definition.
 */

function cost(query: string) {
  return analyzeQuery(parse(query));
}

describe('analyzeQuery', () => {
  it('measures a simple query', () => {
    expect(cost('{ status { storage cursorHeight } }')).toEqual({ depth: 2, aliases: 0, directives: 0 });
  });

  it('counts nesting depth', () => {
    const c = cost('{ a { b { c { d } } } }');
    expect(c.depth).toBe(4);
  });

  it('counts aliases but not plain fields', () => {
    const c = cost('{ one: collections { symbol } two: collections { symbol } tokens { symbol } }');
    expect(c.aliases).toBe(2);
    expect(c.depth).toBe(2);
  });

  it('counts directives', () => {
    const c = cost('{ status @include(if: true) { storage } }');
    expect(c.directives).toBe(1);
  });

  it('follows fragment spreads so breadth cannot hide inside definitions', () => {
    const c = cost(`
      query {
        ...bomb
        ...bomb
      }
      fragment bomb on Query {
        a: collections { symbol }
        b: collections { symbol }
      }
    `);
    // The fragment is walked once per spread — exactly the cost the server pays.
    expect(c.aliases).toBe(4);
  });

  it('terminates on self-referential fragments (cycle guard)', () => {
    const c = cost(`
      query { ...loop }
      fragment loop on Query { status { storage ...loop } }
    `);
    expect(c.depth).toBeGreaterThan(0);
    expect(Number.isFinite(c.depth)).toBe(true);
  });

  it('stays transparent for inline fragments', () => {
    const c = cost('{ ... on Query { status { storage } } }');
    expect(c.depth).toBe(2);
    expect(c.directives).toBe(0);
  });

  it('flags the alias bomb the plugin rejects (> MAX_QUERY_ALIASES)', () => {
    const fields = Array.from({ length: MAX_QUERY_ALIASES + 1 }, (_, i) => `q${i}: collections { symbol }`);
    const c = cost(`{ ${fields.join(' ')} }`);
    expect(c.aliases).toBeGreaterThan(MAX_QUERY_ALIASES);
  });

  it('allows the standard introspection query (tooling and IDEs depend on it)', () => {
    const c = analyzeQuery(parse(getIntrospectionQuery()));
    expect(c.depth).toBeLessThanOrEqual(MAX_QUERY_DEPTH);
    expect(c.aliases).toBeLessThanOrEqual(MAX_QUERY_ALIASES);
    expect(c.directives).toBeLessThanOrEqual(MAX_QUERY_DIRECTIVES);
  });

  it('exposes sane ceilings (documented values)', () => {
    expect(MAX_QUERY_DEPTH).toBeGreaterThanOrEqual(10);
    expect(MAX_QUERY_ALIASES).toBeGreaterThanOrEqual(10);
    expect(MAX_QUERY_DIRECTIVES).toBeGreaterThanOrEqual(10);
  });
});
