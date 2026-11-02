import type { OpAuth } from '../chain/opParser';
import type { ActionName, ContractName } from '../types/actions';
import { PARAM_KEY, balanceKey, emptySnapshot, instanceKey, type Param, type StateSnapshot } from '../types/domain';
import type { EngineStore } from './store';

/**
 * Safety valve on the prefetched book for one trading pair. Open orders are capped
 * per account (100, enforced in-VM), so reaching this would take a coordinated book
 * of thousands of orders — at which point failing loudly beats a silent partial view
 * (the matcher must see every crossing order to be deterministic).
 */
const MAX_BOOK_PREFETCH = 10_000;
/**
 * Absolute ceiling on a prefetched pair book. Paging runs to completion so the
 * matcher never sees a silently truncated view; a book beyond this bound fails
 * the op loudly instead (failing loudly beats matching a partial view — the
 * rule this module's own header comment states).
 */
const BOOK_PREFETCH_HARD_CAP = 200_000;

/**
 * Synthetic snapshot key carrying a signer's current open-order count (fetched with
 * `countBookOrders`, never stored): the VM refuses to rest a new order above the
 * per-account cap. Read-only — the contract never writes it, so it is not part of
 * state and never enters the checksum.
 */
export function openOrdersMetaKey(account: string): string {
  return `open:${account}`;
}

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
    marketOrder: new Set<string>(),
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

  // Synthetic read-only snapshot entries (fetched host-side, never stored): applied
  // after the generic load loop, which would otherwise overwrite them with a null
  // store read of a key that has no row.
  const syntheticMeta: Record<string, string> = {};

  // Generic routing shared by almost every action: a top-level `symbol` identifies the
  // collection/token, a top-level `to` is an account the contract will ensure exists.
  const symbol = str(params.symbol);
  const to = str(params.to);
  const quote = str(params.quote);

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
  } else if (contract === 'market') {
    // Fungible order book (docs/MARKET-DESIGN.md). `buy`/`sell` carry the trading
    // pair and may match against the *entire* open book for it, so the book itself
    // is prefetched (store-ordered by id — the VM re-sorts for matching, but the
    // prefetch set must be complete: an unprefetched crossing order would raise
    // SNAPSHOT_MISS mid-match and make the op nondeterministically fail).
    if (action === 'cancel') {
      const orderId = str(params.orderId);
      if (orderId) need.marketOrder.add(orderId);
    } else {
      if (symbol && quote) {
        need.token.add(symbol);
        need.token.add(quote);
        // Page the pair book to completion: the matcher may only read prefetched
        // rows, so any silent truncation at MAX_BOOK_PREFETCH would hide newer
        // resting orders from matching entirely (starved escrow) and deny takers
        // crossing liquidity the REST book still advertises as OPEN. 101 accounts
        // x 100 open orders (the per-account cap is pair-agnostic) already exceeds
        // the old single-call window deterministically.
        let fetched = 0;
        let bookOffset = 0;
        for (;;) {
          const page = await store.listBookOrders({
            symbol,
            quote,
            status: 'OPEN',
            limit: MAX_BOOK_PREFETCH,
            offset: bookOffset,
          });
          fetched += page.length;
          if (fetched > BOOK_PREFETCH_HARD_CAP) {
            throw new Error(
              `market book for ${symbol}/${quote} exceeds ${BOOK_PREFETCH_HARD_CAP} open orders — refusing to match on a partial view`,
            );
          }
          for (const bookOrder of page) need.marketOrder.add(bookOrder.id);
          if (page.length < MAX_BOOK_PREFETCH) break;
          bookOffset += MAX_BOOK_PREFETCH;
        }
      }
      need.meta.add('market_order_seq');
      need.param.add(PARAM_KEY);

      // Signers pay escrow and settlement legs in both tokens of the pair; the
      // treasury receives the trade fee in the quote token.
      const sender = auth.active[0];
      if (sender) need.account.add(sender);
      for (const acct of auth.active) {
        if (symbol) need.balance.add(balanceKey(acct, symbol));
        if (quote) need.balance.add(balanceKey(acct, quote));
      }
      const paramRow = (await store.get('param', PARAM_KEY)) as Param | null;
      if (paramRow !== null && quote) need.balance.add(balanceKey(paramRow.treasury, quote));

      // Per-account open-order cap: the count is fetched here (host side) and handed
      // to the VM through a synthetic read-only meta key (see openOrdersMetaKey).
      if (sender) {
        const open = await store.countBookOrders({ account: sender, status: 'OPEN' });
        need.meta.add(openOrdersMetaKey(sender));
        syntheticMeta[openOrdersMetaKey(sender)] = String(open);
      }
    }
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
        // the price token definition (precision check runs in the VM); default SCE
        need.token.add(str(params.priceSymbol) ?? 'SCE');
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
      const order = raw as {
        instanceId?: unknown;
        symbol?: unknown;
        seller?: unknown;
        royaltyRecipient?: unknown;
        priceSymbol?: unknown;
      };
      if (typeof order.instanceId === 'string') need.instance.add(order.instanceId);
      if (typeof order.symbol === 'string') need.collection.add(order.symbol);
      if (typeof order.seller === 'string') need.account.add(order.seller);
      if (action === 'fillOrder') {
        // Settlement (step 4): the price token moves buyer (an active signer) → seller
        // + royalty recipient + `fillOrderFeeBps` treasury cut — all rows in
        // `order.priceSymbol`, with the cut read from the `param` row in-VM.
        const priceSymbol = typeof order.priceSymbol === 'string' ? order.priceSymbol : 'SCE';
        need.token.add(priceSymbol);
        need.param.add(PARAM_KEY);
        const holders = new Set<string>();
        if (typeof order.seller === 'string') holders.add(order.seller);
        if (typeof order.royaltyRecipient === 'string') holders.add(order.royaltyRecipient);
        for (const signer of auth.active) holders.add(signer);
        const paramRow = (await store.get('param', PARAM_KEY)) as Param | null;
        if (paramRow !== null) holders.add(paramRow.treasury);
        for (const holder of holders) need.balance.add(balanceKey(holder, priceSymbol));
      }
    }
  }
  // marketOrder -> holder edges: a book order's owner may receive settlement (SELL
  // orders earn quote, BUY orders earn base) and is refunded on cancel in the
  // escrow's own token — prefetch both sides of the pair for every order account.
  for (const orderId of [...need.marketOrder]) {
    const raw = await store.get('marketOrder', orderId);
    if (raw && typeof raw === 'object') {
      const bookOrder = raw as {
        account?: unknown;
        symbol?: unknown;
        quote?: unknown;
      };
      if (typeof bookOrder.account === 'string') {
        need.account.add(bookOrder.account);
        if (typeof bookOrder.symbol === 'string') {
          need.balance.add(balanceKey(bookOrder.account, bookOrder.symbol));
        }
        if (typeof bookOrder.quote === 'string') {
          need.balance.add(balanceKey(bookOrder.account, bookOrder.quote));
        }
      }
    }
  }
  // Instance -> collection edges (issue checks supply, placeOrder snapshots royalties).
  for (const key of [...need.instance]) {
    const raw = await store.get('instance', key);
    if (raw && typeof (raw as { symbol?: unknown }).symbol === 'string') {
      need.collection.add((raw as { symbol: string }).symbol);
    }
  }

  for (const entity of [
    'collection',
    'instance',
    'account',
    'order',
    'marketOrder',
    'token',
    'balance',
    'param',
    'meta',
  ] as const) {
    for (const key of need[entity]) {
      (snapshot[entity] as Record<string, unknown>)[key] = await store.get(entity, key);
    }
  }
  for (const [key, value] of Object.entries(syntheticMeta)) snapshot.meta[key] = value;

  return snapshot;
}
