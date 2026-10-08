import type { OpAuth } from '../chain/opParser';
import type { ActionName, ContractName } from '../types/actions';
import { balanceKey, emptySnapshot, instanceKey, type StateSnapshot } from '../types/domain';
import type { EngineStore } from './store';

/**
 * Builds the minimal read-view the sandbox receives for one action.
 *
 * The prefetch list is derived from the *contract + action + params + authorities* only
 * (routing, not business logic). Anything the contract reads but was not prefetched
 * raises `SNAPSHOT_MISS` inside the VM, and the guard refuses writes to unread keys —
 * together they make the read set explicit and auditable.
 *
 * Two-phase resolution handles dependencies that are only known after a lookup
 * (e.g. an instance's collection symbol, an order's instance id).
 *
 * Note on ids: wiki token ids are only unique *per symbol*, so instance keys are the
 * composite `<SYMBOL>:<id>` everywhere (see {@link instanceKey}); fungible balances use
 * `<account>:<SYMBOL>` (see {@link balanceKey}).
 */
export async function buildSnapshot(
  store: EngineStore,
  contract: ContractName,
  action: ActionName,
  params: Record<string, unknown>,
  auth: OpAuth,
): Promise<StateSnapshot> {
  const snapshot = emptySnapshot();
  const need = {
    collection: new Set<string>(),
    instance: new Set<string>(),
    account: new Set<string>(),
    order: new Set<string>(),
    token: new Set<string>(),
    balance: new Set<string>(),
    param: new Set<string>(),
    meta: new Set<string>(),
  };

  // Signing accounts are always visible so the contract can evaluate authorisation
  // (and so `fillOrder` can resolve a buyer that differs from the primary actor).
  for (const name of [...auth.active, ...auth.posting]) need.account.add(name);

  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  // Generic routing shared by almost every action: a top-level `symbol` identifies the
  // collection/token, a top-level `to` is an account the contract will ensure exists.
  const symbol = str(params.symbol);
  const to = str(params.to);

  if (contract === 'tokens') {
    // Fungible rows: the token definition plus the balance rows this action can move —
    // the sender's own row (first active authority; issue/burn/transfer act on it) and
    // the recipient's. Posting-only metadata actions never touch balances, and the
    // extra keys cost only a `null` read when unused.
    if (symbol) {
      need.token.add(symbol);
      const sender = auth.active[0];
      if (sender) need.balance.add(balanceKey(sender, symbol));
      if (to) need.balance.add(balanceKey(to, symbol));
    }
    if (to) need.account.add(to);
  } else {
    if (symbol) need.collection.add(symbol);
    if (to) need.account.add(to);

    switch (action) {
      case 'issue': {
        // collection + `to` covered by the generic step.
        break;
      }
      case 'issueMultiple': {
        for (const item of arr(params.instances)) {
          if (!isObject(item)) continue;
          const itemSymbol = str(item.symbol);
          if (itemSymbol) need.collection.add(itemSymbol);
          const itemTo = str(item.to);
          if (itemTo) need.account.add(itemTo);
        }
        break;
      }
      case 'transfer':
      case 'burn': {
        // Wiki batch shape: nfts = [{ symbol, ids: [...] }]
        for (const group of arr(params.nfts)) {
          if (!isObject(group)) continue;
          const groupSymbol = str(group.symbol);
          if (groupSymbol) need.collection.add(groupSymbol);
          for (const id of arr(group.ids)) {
            const tokenId = str(id);
            if (groupSymbol && tokenId) need.instance.add(instanceKey(groupSymbol, tokenId));
          }
        }
        break;
      }
      case 'setProperties': {
        if (!symbol) break;
        for (const item of arr(params.nfts)) {
          if (!isObject(item)) continue;
          const id = str(item.id);
          if (id) need.instance.add(instanceKey(symbol, id));
        }
        break;
      }
      case 'placeOrder': {
        const id = str(params.id);
        if (symbol && id) need.instance.add(instanceKey(symbol, id));
        need.meta.add('order_seq');
        break;
      }
      case 'fillOrder':
      case 'cancelOrder': {
        const orderId = str(params.orderId);
        if (orderId) need.order.add(orderId);
        break;
      }
      default: {
        // metadata / issuer-management / property-schema actions: collection (+ `to` for
        // transferOwnership) already covered by the generic step above.
        break;
      }
    }
  }

  // Phase 2: follow edges that are only resolvable after the first lookup.
  for (const orderId of [...need.order]) {
    const raw = await store.get('order', orderId);
    if (raw && typeof raw === 'object') {
      const order = raw as { instanceId?: unknown; symbol?: unknown; seller?: unknown };
      if (typeof order.instanceId === 'string') need.instance.add(order.instanceId);
      if (typeof order.symbol === 'string') need.collection.add(order.symbol);
      if (typeof order.seller === 'string') need.account.add(order.seller);
    }
  }
  // Instance -> collection edges (issue checks supply, placeOrder snapshots royalties).
  for (const key of [...need.instance]) {
    const raw = await store.get('instance', key);
    if (raw && typeof (raw as { symbol?: unknown }).symbol === 'string') {
      need.collection.add((raw as { symbol: string }).symbol);
    }
  }

  for (const entity of ['collection', 'instance', 'account', 'order', 'token', 'balance', 'param', 'meta'] as const) {
    for (const key of need[entity]) {
      (snapshot[entity] as Record<string, unknown>)[key] = await store.get(entity, key);
    }
  }

  return snapshot;
}
