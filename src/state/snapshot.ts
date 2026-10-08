import type { OpAuth } from '../chain/opParser';
import type { ActionName, ContractName } from '../types/actions';
import { PARAM_KEY, balanceKey, emptySnapshot, instanceKey, type Param, type StateSnapshot } from '../types/domain';
import type { EngineStore } from './store';

/** How one fee-bearing action resolves its payer and fee currency at routing time. */
type FeeRoute = {
  /** Payer is the first active authority (`create`); otherwise the collection/token issuer. */
  authPayer: boolean;
  /** The action accepts a `feeSymbol` param that may name a non-default fee currency. */
  feeSymbolParam: boolean;
};

/**
 * Actions the fee engine charges for (docs/TOKENS-DESIGN.md step 3). `fillOrder`'s
 * treasury cut is wired with marketplace settlement (step 4), not here.
 */
const FEE_ROUTES: Record<'nft' | 'tokens', Partial<Record<ActionName, FeeRoute>>> = {
  nft: {
    create: { authPayer: true, feeSymbolParam: false },
    addProperty: { authPayer: false, feeSymbolParam: false },
    issue: { authPayer: false, feeSymbolParam: true },
    issueMultiple: { authPayer: false, feeSymbolParam: true },
  },
  tokens: {
    create: { authPayer: true, feeSymbolParam: false },
    issue: { authPayer: false, feeSymbolParam: true },
  },
};

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

  if (contract === 'engine') {
    // Meta-actions: `setParam` reads and rewrites the single fee row; its signer
    // (param.admin) is already visible from the signer accounts prefetched above.
    if (action === 'setParam') need.param.add(PARAM_KEY);
  } else if (contract === 'tokens') {
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

  // Fee engine (step 3): fee-bearing actions read the `param` row in-VM and — when
  // the scheduled fee is non-zero — move that amount from the payer to the treasury.
  // The prefetch is unconditional (during the zero-fee bootstrap these are unused
  // null reads); what varies is who can pay: the first active authority for `create`,
  // otherwise the collection/token issuer — plus nft-authorized issuers, who may be
  // the actual signer of an `issue`.
  const feeRoute = contract === 'nft' || contract === 'tokens' ? FEE_ROUTES[contract][action] : undefined;
  if (feeRoute !== undefined) {
    need.param.add(PARAM_KEY);
    const feeSymbols = new Set<string>();
    if (!feeRoute.feeSymbolParam) {
      feeSymbols.add('SCE');
    } else if (action === 'issueMultiple') {
      // Each batch item carries its own optional feeSymbol.
      for (const item of arr(params.instances)) {
        if (!isObject(item)) continue;
        feeSymbols.add(typeof item.feeSymbol === 'string' ? item.feeSymbol : 'SCE');
      }
      if (feeSymbols.size === 0) feeSymbols.add('SCE');
    } else {
      feeSymbols.add(typeof params.feeSymbol === 'string' ? params.feeSymbol : 'SCE');
    }
    for (const feeSymbol of feeSymbols) need.token.add(feeSymbol);

    const paramRow = (await store.get('param', PARAM_KEY)) as Param | null;
    if (paramRow !== null) {
      for (const feeSymbol of feeSymbols) need.balance.add(balanceKey(paramRow.treasury, feeSymbol));
    }

    const payers = new Set<string>();
    const addIssuerPayers = async (entitySymbol: string): Promise<void> => {
      const entity = contract === 'nft' ? 'collection' : 'token';
      const raw = await store.get(entity, entitySymbol);
      if (raw && typeof raw === 'object') {
        const row = raw as { issuer?: unknown; authorizedIssuingAccounts?: unknown };
        if (typeof row.issuer === 'string') payers.add(row.issuer);
        for (const account of arr(row.authorizedIssuingAccounts)) {
          if (typeof account === 'string') payers.add(account);
        }
      }
    };
    if (feeRoute.authPayer) {
      if (auth.active[0]) payers.add(auth.active[0]);
    } else if (action === 'issueMultiple') {
      // Batch items name their own collections (no top-level symbol).
      for (const item of arr(params.instances)) {
        if (!isObject(item)) continue;
        const itemSymbol = str(item.symbol);
        if (itemSymbol) await addIssuerPayers(itemSymbol);
      }
    } else if (symbol) {
      await addIssuerPayers(symbol);
    }
    for (const payer of payers) {
      for (const feeSymbol of feeSymbols) need.balance.add(balanceKey(payer, feeSymbol));
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
