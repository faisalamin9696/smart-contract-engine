/**
 * Deterministic contract runtime — all contracts in one sandboxed source.
 *
 * This source is executed **inside the sandbox** (isolated-vm isolate, or a fresh Node vm
 * context as fallback) with the exact same bytes in every environment, so the state
 * transition of a block is reproducible bit-for-bit.
 *
 * Three contracts share this runtime and the single `sce-mainnet1` op id (the same
 * multiplexing pattern as the real Steem Engine); `HANDLERS[contract][action]` picks
 * the implementation from the contract selected by the envelope:
 *
 *  - **`nft`** — action names, parameter shapes and semantics follow the Steem Engine
 *    `nft` contract (https://github.com/hive-engine/steemsmartcontracts-wiki/blob/master/NFT-Contracts.md):
 *    `create`, `issue`, `issueMultiple`, `transfer`, `burn`, `setProperties`, the metadata
 *    and issuer-management actions, and the typed data-property schema
 *    (`addProperty` / `setPropertyPermissions` / `setGroupBy` / `updatePropertyDefinition`).
 *    The marketplace actions (`placeOrder` / `fillOrder` / `cancelOrder`) are an engine
 *    extension; upstream they live in a separate `market` contract.
 *  - **`tokens`** — the fungible contract from .../Tokens-Contract.md (v1 scope of
 *    docs/TOKENS-DESIGN.md): `create`, `issue`, `transfer`, `burn` (engine extension —
 *    supply must decrease), `updateUrl` / `updateMetadata`, `transferOwnership` and
 *    `updatePrecision` (increase only). Quantities are decimal strings handled with
 *    BigNumber; balances are keyed `<account>:<SYMBOL>`.
 *  - **`engine`** — meta-actions outside both wiki contracts; currently `setParam`,
 *    which patches the in-state fee schedule (admin-only).
 *
 * Deliberate deviations, all documented in the README:
 *  - fees are read from the in-state `param` row and debited from the payer to the
 *    treasury (step 3 fee engine); delegation, staking and locked tokens are not
 *    modelled at all;
 *  - `number` data properties accept **integers only** (wiki floats break determinism);
 *  - ids are `<SYMBOL>:<id>` composite keys in storage because wiki ids are per-symbol.
 *
 * Constraints honoured by this file:
 *  - no backticks / template literals / regex escapes (it is embedded in a TS literal);
 *  - no host APIs: no Date, no Math.random, no timers, no I/O (the isolate never had
 *    them, and the bootstrap stubs out the two that exist as globals);
 *  - all arithmetic goes through BigNumber, never through the `+` operator on numbers
 *    that could be fractional;
 *  - time comes from `context.timestamp` (the block header), never from the host clock.
 *
 * The contract returns *declarative mutations*; it never touches storage itself. The host
 * verifies every mutation against its read set before committing anything.
 */
export const CONTRACT_SOURCE = `
(function () {
  'use strict';

  var MAX_ISSUE_BATCH = 10;    // wiki: issueMultiple issues at most 10 tokens
  var MAX_BATCH = 50;          // wiki: transfer/burn/setProperties handle at most 50
  var MAX_AUTH_LIST = 10;      // wiki: authorized lists hold at most 10 entries
  var MAX_PROP_DEFS = 50;      // engine cap standing in for the wiki's per-property fee
  var MAX_PROPERTY_BYTES = 4096;
  var MAX_METADATA_CHARS = 1000;
  var MAX_PROP_STRING = 100;
  var MAX_SAFE = 9007199254740991;

  var RE_SYMBOL = /^[A-Z]{3,10}$/;
  var RE_TOKEN_ID = /^[0-9]{1,15}$/;
  var RE_UINT = /^[0-9]{1,20}$/;
  var RE_ACCOUNT = /^[a-z][a-z0-9.-]{2,15}$/;
  var RE_NAME = /^[A-Za-z0-9 ]{1,50}$/;
  var RE_PROP_NAME = /^[A-Za-z0-9]{1,25}$/;
  var RE_AMOUNT = /^[0-9]{1,15}([.][0-9]{1,3})?$/;
  var RE_DECIMAL = /^[0-9]{1,15}([.][0-9]{1,8})?$/;
  var RE_INT_STRING = /^-?[0-9]{1,15}$/;

  // ---- fee engine (docs/TOKENS-DESIGN.md step 3) --------------------------
  var PARAM_KEY = 'param';   // key of the single fee-schedule row (entity "param")
  var FEE_SYMBOL = 'SCE';    // canonical fee unit for actions without a feeSymbol param
  var FEE_KEYS = ['nftCreationFee', 'addPropertyFee', 'tokenCreationFee', 'issueFee', 'fillOrderFeeBps'];

  var PROPERTY_TYPES = ['number', 'string', 'boolean'];

  // ---------------------------------------------------------------- primitives

  function fail(code, message) {
    var err = new Error(message);
    err.code = code;
    throw err;
  }

  function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function copy(source) {
    var out = {};
    for (var k in source) {
      if (has(source, k)) out[k] = source[k];
    }
    return out;
  }

  function read(S, entity, key) {
    var map = S[entity];
    if (!has(map, key)) {
      fail('SNAPSHOT_MISS', 'state for ' + entity + ' ' + key + ' was not prefetched');
    }
    return map[key];
  }

  function write(S, M, entity, key, value) {
    S[entity][key] = value;
    M.push({ entity: entity, key: key, value: value });
  }

  function erase(S, M, entity, key) {
    S[entity][key] = null;
    M.push({ entity: entity, key: key, value: null });
  }

  // ------------------------------------------------------------ deterministic math

  function intAdd(a, b) {
    return new BigNumber(a).plus(new BigNumber(b)).toFixed(0);
  }

  function intSub(a, b) {
    if (new BigNumber(a).lt(new BigNumber(b))) {
      fail('ARITHMETIC_UNDERFLOW', 'subtraction underflow: ' + a + ' minus ' + b);
    }
    return new BigNumber(a).minus(new BigNumber(b)).toFixed(0);
  }

  function intLt(a, b) {
    return new BigNumber(a).lt(new BigNumber(b));
  }

  function intGt(a, b) {
    return new BigNumber(a).gt(new BigNumber(b));
  }

  function toInt(text) {
    var n = parseInt(text, 10);
    if (!isFinite(n) || n < 0 || n > MAX_SAFE) {
      fail('ARITHMETIC_OVERFLOW', 'integer out of safe range: ' + text);
    }
    return n;
  }

  function pad(value, width) {
    var s = String(value);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function assertNoFloats(value, path) {
    if (typeof value === 'number') {
      if (!isFinite(value) || Math.floor(value) !== value) {
        fail('FLOAT_FORBIDDEN', 'floating point number at ' + path + ' is forbidden');
      }
      return;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) assertNoFloats(value[i], path + '[' + i + ']');
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (var k in value) {
        if (has(value, k)) assertNoFloats(value[k], path + '.' + k);
      }
    }
  }

  /** Wiki ids are per-symbol, so storage keys/events/orders use the composite SYMBOL:id. */
  function instanceKey(symbol, id) {
    return symbol + ':' + id;
  }

  // ------------------------------------------------------------------ authority

  function allAuths(ctx) {
    return ctx.auths.active.concat(ctx.auths.posting);
  }

  function hasAuth(ctx, account, level) {
    if (level === 'active') return ctx.auths.active.indexOf(account) >= 0;
    return allAuths(ctx).indexOf(account) >= 0;
  }

  function requireAuth(ctx, account, level, reason) {
    if (!hasAuth(ctx, account, level)) {
      fail('NOT_AUTHORIZED', account + ' lacks ' + level + ' authority required to ' + reason);
    }
  }

  function ensureAccount(S, M, ctx, name) {
    if (typeof name !== 'string' || !RE_ACCOUNT.test(name)) {
      fail('BAD_ACCOUNT', 'not a valid account name: ' + String(name));
    }
    var account = read(S, 'account', name);
    if (account === null) {
      write(S, M, 'account', name, {
        name: name,
        createdAtBlock: ctx.blockHeight,
        createdAt: ctx.timestamp,
      });
    }
  }

  function emit(E, type, ctx, data) {
    var event = { type: type, block: ctx.blockHeight, timestamp: ctx.timestamp };
    for (var k in data) {
      if (has(data, k)) event[k] = data[k];
    }
    E.push(event);
  }

  function loadCollection(S, symbol) {
    if (typeof symbol !== 'string' || !RE_SYMBOL.test(symbol)) {
      fail('BAD_SYMBOL', 'invalid collection symbol: ' + String(symbol));
    }
    var collection = read(S, 'collection', symbol);
    if (collection === null) fail('COLLECTION_NOT_FOUND', 'collection ' + symbol + ' does not exist');
    return collection;
  }

  /** Wiki: only the NFT owner may manage an NFT (level per action). */
  function requireOwner(ctx, collection, action, level) {
    if (!hasAuth(ctx, collection.issuer, level)) {
      fail('NOT_AUTHORIZED', 'only the owner of ' + collection.symbol + ' may ' + action);
    }
    return collection.issuer;
  }

  /** Wiki: issuing requires active authority of the owner or an authorized issuer. */
  function requireIssuer(ctx, collection, action) {
    for (var i = 0; i < ctx.auths.active.length; i++) {
      var account = ctx.auths.active[i];
      if (account === collection.issuer || collection.authorizedIssuingAccounts.indexOf(account) >= 0) {
        return account;
      }
    }
    fail('NOT_AUTHORIZED', 'no authorized issuer of ' + collection.symbol + ' signed this ' + action);
    return null;
  }

  function canEditProperty(ctx, def) {
    for (var i = 0; i < ctx.auths.active.length; i++) {
      if (def.authorizedEditingAccounts.indexOf(ctx.auths.active[i]) >= 0) return true;
    }
    for (var j = 0; j < ctx.auths.posting.length; j++) {
      if (def.authorizedEditingAccounts.indexOf(ctx.auths.posting[j]) >= 0) return true;
    }
    return false;
  }

  function validateAccountList(list, field) {
    if (!Array.isArray(list)) fail('BAD_LIST', field + ' must be an array');
    if (list.length > MAX_AUTH_LIST) {
      fail('TOO_MANY', field + ' may contain at most ' + MAX_AUTH_LIST + ' entries');
    }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var name = list[i];
      if (typeof name !== 'string' || !RE_ACCOUNT.test(name)) {
        fail('BAD_ACCOUNT', field + ' contains an invalid account name: ' + String(name));
      }
      if (out.indexOf(name) < 0) out.push(name);
    }
    return out;
  }

  function validateName(value, field, pattern) {
    if (typeof value !== 'string' || !pattern.test(value)) {
      fail('BAD_NAME', field + ' must be letters/numbers/whitespace only, max 50 characters');
    }
    return value;
  }

  // ----------------------------------------------------------- data properties

  /**
   * Coerces one incoming value to the property's declared type.
   * Wiki rule: a number property accepts either a number or a numeric string.
   * Engine rule: integers only — floats are refused for determinism.
   */
  function coercePropertyValue(def, value, name) {
    if (def.type === 'boolean') {
      if (typeof value !== 'boolean') {
        fail('BAD_PROPERTY_TYPE', 'property ' + name + ' is declared boolean');
      }
      return value;
    }
    if (def.type === 'string') {
      if (typeof value !== 'string') {
        fail('BAD_PROPERTY_TYPE', 'property ' + name + ' is declared string');
      }
      if (value.length > MAX_PROP_STRING) {
        fail('PROPERTY_TOO_LONG', 'property ' + name + ' exceeds ' + MAX_PROP_STRING + ' characters');
      }
      return value;
    }
    if (typeof value === 'number') {
      if (!isFinite(value) || Math.floor(value) !== value) {
        fail('FLOAT_FORBIDDEN', 'property ' + name + ' must be an integer (floats break determinism)');
      }
      if (value > MAX_SAFE || value < -MAX_SAFE) {
        fail('ARITHMETIC_OVERFLOW', 'property ' + name + ' is outside the safe integer range');
      }
      return value;
    }
    if (typeof value === 'string' && RE_INT_STRING.test(value)) {
      var parsed = parseInt(value, 10);
      if (Math.abs(parsed) > MAX_SAFE) {
        fail('ARITHMETIC_OVERFLOW', 'property ' + name + ' is outside the safe integer range');
      }
      return parsed;
    }
    fail('BAD_PROPERTY_TYPE', 'property ' + name + ' is declared number (integer or integer string)');
    return null;
  }

  /**
   * Validates an incoming property map against the collection's schema and returns a
   * fresh normalised object. Unknown properties are refused: the schema declared through
   * addProperty is the single source of truth (wiki behaviour).
   */
  function normaliseForSchema(collection, properties) {
    if (properties === undefined || properties === null) return {};
    if (!isObject(properties)) fail('BAD_PROPERTIES', 'properties must be an object');
    var out = {};
    for (var key in properties) {
      if (!has(properties, key)) continue;
      var def = collection.properties[key];
      if (def === undefined) {
        fail(
          'UNKNOWN_PROPERTY',
          'property ' + key + ' is not defined on ' + collection.symbol + ' (declare it with addProperty)'
        );
      }
      out[key] = coercePropertyValue(def, properties[key], key);
    }
    if (JSON.stringify(out).length > MAX_PROPERTY_BYTES) {
      fail('PROPERTIES_TOO_LARGE', 'properties exceed ' + MAX_PROPERTY_BYTES + ' characters');
    }
    return out;
  }

  function splitRoyalty(price, royaltyBps, precision) {
    if (typeof price !== 'string' || !RE_DECIMAL.test(price)) {
      fail('BAD_PRICE', 'price must be a decimal string with at most 8 fractional digits');
    }
    if (typeof royaltyBps !== 'string' || !RE_UINT.test(royaltyBps)) {
      fail('BAD_ROYALTY', 'royaltyBps must be an unsigned integer string');
    }
    var amount = new BigNumber(price);
    if (!amount.gt(0)) fail('BAD_PRICE', 'price must be greater than zero');
    var bps = new BigNumber(royaltyBps);
    if (bps.gt(10000)) fail('BAD_ROYALTY', 'royaltyBps must not exceed 10000');
    var places = precision === undefined ? 3 : precision;
    var royalty = amount.times(bps).div(10000).decimalPlaces(places, BigNumber.ROUND_DOWN);
    var proceeds = amount.minus(royalty);
    if (royalty.plus(proceeds).comparedTo(amount) !== 0) {
      fail('SETTLEMENT_ERROR', 'royalty split does not reconcile');
    }
    return {
      price: amount.toFixed(),
      royalty: royalty.toFixed(places),
      sellerProceeds: proceeds.toFixed(places),
    };
  }

  function nextOrderId(S, M) {
    var current = read(S, 'meta', 'order_seq');
    var next = current === null ? '1' : intAdd(current, '1');
    write(S, M, 'meta', 'order_seq', next);
    return 'ORD-' + pad(toInt(next), 8);
  }

  // ------------------------------------------------------------------- issuing

  /**
   * Issues one token. The supply field counts tokens ever issued, so the wiki's id rule
   * ("starts at 1 ... increments by 1 every time a new token is issued") is simply
   * id = supply + 1, and burned ids can never come back.
   */
  function mintOne(ctx, collection, to, properties, S, M, E) {
    if (typeof to !== 'string' || !RE_ACCOUNT.test(to)) {
      fail('BAD_ACCOUNT', 'recipient is not a valid account name: ' + String(to));
    }
    if (collection.maxSupply !== '0' && !intLt(collection.supply, collection.maxSupply)) {
      fail(
        'MAX_SUPPLY_REACHED',
        'collection ' + collection.symbol + ' reached its max supply of ' + collection.maxSupply
      );
    }
    var id = intAdd(collection.supply, '1');
    var seq = toInt(id);
    var key = instanceKey(collection.symbol, id);

    var instance = {
      id: id,
      symbol: collection.symbol,
      seq: seq,
      owner: to,
      properties: normaliseForSchema(collection, properties),
      listedOrderId: null,
      previousAccount: null,
      createdAtBlock: ctx.blockHeight,
      createdAt: ctx.timestamp,
    };
    write(S, M, 'instance', key, instance);

    var updated = copy(collection);
    updated.supply = intAdd(collection.supply, '1');
    updated.circulatingSupply = intAdd(collection.circulatingSupply, '1');
    write(S, M, 'collection', collection.symbol, updated);

    ensureAccount(S, M, ctx, to);
    emit(E, 'NFT_MINTED', ctx, { symbol: collection.symbol, instanceId: key, account: to });
    emit(E, 'NFT_RECEIVED', ctx, { symbol: collection.symbol, instanceId: key, account: to });
    return updated;
  }

  // ------------------------------------------------------------------ creation

  function hCreate(ctx, p, S, M, E) {
    if (ctx.auths.active.length === 0) {
      fail('ACTIVE_AUTH_REQUIRED', 'create requires active authority');
    }
    var creator = ctx.auths.active[0];
    if (typeof p.symbol !== 'string' || !RE_SYMBOL.test(p.symbol)) {
      fail('BAD_SYMBOL', 'symbol must be 3 to 10 uppercase letters');
    }
    validateName(p.name, 'name', RE_NAME);
    if (p.url !== undefined && (typeof p.url !== 'string' || p.url.length > 255)) {
      fail('BAD_URL', 'url must be a string of at most 255 characters');
    }
    if (p.orgName !== undefined) validateName(p.orgName, 'orgName', RE_NAME);
    if (p.productName !== undefined) validateName(p.productName, 'productName', RE_NAME);

    var maxSupply = '0';
    if (p.maxSupply !== undefined) {
      if (typeof p.maxSupply !== 'string' || !RE_UINT.test(p.maxSupply) || intGt(p.maxSupply, String(MAX_SAFE))) {
        fail('BAD_MAX_SUPPLY', 'maxSupply must be an integer between 1 and ' + MAX_SAFE);
      }
      if (intLt(p.maxSupply, '1')) fail('BAD_MAX_SUPPLY', 'maxSupply must be at least 1');
      maxSupply = p.maxSupply;
    }

    var issuingAccounts;
    if (p.authorizedIssuingAccounts === undefined) {
      issuingAccounts = [creator];
    } else {
      issuingAccounts = validateAccountList(p.authorizedIssuingAccounts, 'authorizedIssuingAccounts');
    }
    var issuingContracts =
      p.authorizedIssuingContracts === undefined
        ? []
        : validateAccountList(p.authorizedIssuingContracts, 'authorizedIssuingContracts');

    var bps = p.royaltyBps === undefined ? '0' : p.royaltyBps;
    if (typeof bps !== 'string' || !RE_UINT.test(bps) || intGt(bps, '10000')) {
      fail('BAD_ROYALTY', 'royaltyBps must be an unsigned integer between 0 and 10000');
    }
    var recipient = p.royaltyRecipient === undefined ? creator : p.royaltyRecipient;
    if (typeof recipient !== 'string' || !RE_ACCOUNT.test(recipient)) {
      fail('BAD_ACCOUNT', 'royaltyRecipient is not a valid account name');
    }
    if (read(S, 'collection', p.symbol) !== null) {
      fail('COLLECTION_EXISTS', 'collection ' + p.symbol + ' already exists');
    }
    chargeFee(ctx, S, M, creator, 'nftCreationFee');

    var collection = {
      symbol: p.symbol,
      name: p.name,
      issuer: creator,
      url: p.url === undefined ? '' : p.url,
      orgName: p.orgName === undefined ? '' : p.orgName,
      productName: p.productName === undefined ? '' : p.productName,
      metadata: {},
      maxSupply: maxSupply,
      supply: '0',
      burned: '0',
      circulatingSupply: '0',
      authorizedIssuingAccounts: issuingAccounts,
      authorizedIssuingContracts: issuingContracts,
      properties: {},
      groupBy: [],
      royaltyBps: bps,
      royaltyRecipient: recipient,
      createdAtBlock: ctx.blockHeight,
      createdAt: ctx.timestamp,
    };
    write(S, M, 'collection', p.symbol, collection);
    ensureAccount(S, M, ctx, creator);
    emit(E, 'COLLECTION_CREATED', ctx, { symbol: p.symbol, account: creator });
    return collection;
  }

  // ------------------------------------------------- metadata & issuer management

  function editCollection(S, M, ctx, symbol, action, level, mutate) {
    var collection = loadCollection(S, symbol);
    requireOwner(ctx, collection, action, level);
    var updated = copy(collection);
    mutate(updated, collection);
    write(S, M, 'collection', collection.symbol, updated);
    return updated;
  }

  function hUpdateUrl(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'updateUrl', 'either', function (updated) {
      updated.url = p.url;
    });
  }

  function hUpdateMetadata(ctx, p, S, M, E) {
    if (!isObject(p.metadata)) fail('BAD_METADATA', 'metadata must be an object');
    assertNoFloats(p.metadata, 'metadata');
    if (JSON.stringify(p.metadata).length > MAX_METADATA_CHARS) {
      fail('METADATA_TOO_LARGE', 'metadata must stringify to at most ' + MAX_METADATA_CHARS + ' characters');
    }
    editCollection(S, M, ctx, p.symbol, 'updateMetadata', 'either', function (updated) {
      updated.metadata = p.metadata;
    });
  }

  function hUpdateName(ctx, p, S, M, E) {
    validateName(p.name, 'name', RE_NAME);
    editCollection(S, M, ctx, p.symbol, 'updateName', 'either', function (updated) {
      updated.name = p.name;
    });
  }

  function hUpdateOrgName(ctx, p, S, M, E) {
    validateName(p.orgName, 'orgName', RE_NAME);
    editCollection(S, M, ctx, p.symbol, 'updateOrgName', 'either', function (updated) {
      updated.orgName = p.orgName;
    });
  }

  function hUpdateProductName(ctx, p, S, M, E) {
    validateName(p.productName, 'productName', RE_NAME);
    editCollection(S, M, ctx, p.symbol, 'updateProductName', 'either', function (updated) {
      updated.productName = p.productName;
    });
  }

  function hAddAuthorizedIssuingAccounts(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'addAuthorizedIssuingAccounts', 'active', function (updated, before) {
      var merged = before.authorizedIssuingAccounts.slice();
      var added = validateAccountList(p.accounts, 'accounts');
      for (var i = 0; i < added.length; i++) {
        if (merged.indexOf(added[i]) < 0) merged.push(added[i]);
      }
      if (merged.length > MAX_AUTH_LIST) {
        fail('TOO_MANY', 'authorizedIssuingAccounts may contain at most ' + MAX_AUTH_LIST + ' entries');
      }
      updated.authorizedIssuingAccounts = merged;
    });
  }

  function hRemoveAuthorizedIssuingAccounts(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'removeAuthorizedIssuingAccounts', 'active', function (updated, before) {
      var removed = validateAccountList(p.accounts, 'accounts');
      updated.authorizedIssuingAccounts = before.authorizedIssuingAccounts.filter(function (name) {
        return removed.indexOf(name) < 0;
      });
    });
  }

  function hAddAuthorizedIssuingContracts(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'addAuthorizedIssuingContracts', 'active', function (updated, before) {
      var merged = before.authorizedIssuingContracts.slice();
      var added = validateAccountList(p.contracts, 'contracts');
      for (var i = 0; i < added.length; i++) {
        if (merged.indexOf(added[i]) < 0) merged.push(added[i]);
      }
      if (merged.length > MAX_AUTH_LIST) {
        fail('TOO_MANY', 'authorizedIssuingContracts may contain at most ' + MAX_AUTH_LIST + ' entries');
      }
      updated.authorizedIssuingContracts = merged;
    });
  }

  function hRemoveAuthorizedIssuingContracts(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'removeAuthorizedIssuingContracts', 'active', function (updated, before) {
      var removed = validateAccountList(p.contracts, 'contracts');
      updated.authorizedIssuingContracts = before.authorizedIssuingContracts.filter(function (name) {
        return removed.indexOf(name) < 0;
      });
    });
  }

  function hTransferOwnership(ctx, p, S, M, E) {
    if (typeof p.to !== 'string' || !RE_ACCOUNT.test(p.to)) {
      fail('BAD_ACCOUNT', 'new owner is not a valid account name');
    }
    var collection = loadCollection(S, p.symbol);
    requireOwner(ctx, collection, 'transferOwnership', 'active');
    if (p.to === collection.issuer) fail('SAME_OWNER', 'collection is already owned by ' + p.to);
    var updated = copy(collection);
    updated.issuer = p.to;
    write(S, M, 'collection', collection.symbol, updated);
    ensureAccount(S, M, ctx, p.to);
  }

  // ------------------------------------------------------------ property schema

  function hAddProperty(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'addProperty', 'active', function (updated, before) {
      if (typeof p.name !== 'string' || !RE_PROP_NAME.test(p.name)) {
        fail('BAD_PROPERTY_NAME', 'property name must be 1 to 25 letters/numbers');
      }
      if (has(before.properties, p.name)) {
        fail('PROPERTY_EXISTS', 'property ' + p.name + ' is already defined');
      }
      if (PROPERTY_TYPES.indexOf(p.type) < 0) {
        fail('BAD_PROPERTY_TYPE', 'type must be number, string or boolean');
      }
      var count = 0;
      for (var k in before.properties) if (has(before.properties, k)) count += 1;
      if (count >= MAX_PROP_DEFS) {
        fail('TOO_MANY_PROPERTIES', 'at most ' + MAX_PROP_DEFS + ' property definitions are allowed');
      }
      // Wiki: the first three property definitions are free; the 4th and later pay
      // addPropertyFee (charged to the issuer, who is the only account that signs here).
      if (count >= 3) chargeFee(ctx, S, M, before.issuer, 'addPropertyFee');
      var accounts =
        p.authorizedEditingAccounts === undefined
          ? [before.issuer]
          : validateAccountList(p.authorizedEditingAccounts, 'authorizedEditingAccounts');
      var contracts =
        p.authorizedEditingContracts === undefined
          ? []
          : validateAccountList(p.authorizedEditingContracts, 'authorizedEditingContracts');
      var properties = copy(before.properties);
      properties[p.name] = {
        type: p.type,
        isReadOnly: p.isReadOnly === undefined ? false : p.isReadOnly === true,
        authorizedEditingAccounts: accounts,
        authorizedEditingContracts: contracts,
      };
      updated.properties = properties;
    });
  }

  function hSetPropertyPermissions(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'setPropertyPermissions', 'active', function (updated, before) {
      var def = before.properties[p.name];
      if (def === undefined) fail('PROPERTY_NOT_FOUND', 'property ' + p.name + ' is not defined');
      var next = copy(def);
      // Wiki: provided lists completely replace the current ones; absent lists are kept.
      if (p.accounts !== undefined) next.authorizedEditingAccounts = validateAccountList(p.accounts, 'accounts');
      if (p.contracts !== undefined) next.authorizedEditingContracts = validateAccountList(p.contracts, 'contracts');
      var properties = copy(before.properties);
      properties[p.name] = next;
      updated.properties = properties;
    });
  }

  function hUpdatePropertyDefinition(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'updatePropertyDefinition', 'active', function (updated, before) {
      var def = before.properties[p.name];
      if (def === undefined) fail('PROPERTY_NOT_FOUND', 'property ' + p.name + ' is not defined');
      // Wiki: schema edits are only possible before the first token has been issued.
      if (before.supply !== '0') {
        fail(
          'PROPERTY_DEFINITION_LOCKED',
          'property schemas cannot change once tokens have been issued (supply is ' + before.supply + ')'
        );
      }
      if (p.type !== undefined && PROPERTY_TYPES.indexOf(p.type) < 0) {
        fail('BAD_PROPERTY_TYPE', 'type must be number, string or boolean');
      }
      var newName = p.name;
      if (p.newName !== undefined) {
        if (typeof p.newName !== 'string' || !RE_PROP_NAME.test(p.newName)) {
          fail('BAD_PROPERTY_NAME', 'property name must be 1 to 25 letters/numbers');
        }
        if (p.newName !== p.name && has(before.properties, p.newName)) {
          fail('PROPERTY_EXISTS', 'property ' + p.newName + ' already exists');
        }
        newName = p.newName;
      }
      var properties = copy(before.properties);
      if (newName !== p.name) delete properties[p.name];
      properties[newName] = {
        type: p.type === undefined ? def.type : p.type,
        isReadOnly: p.isReadOnly === undefined ? def.isReadOnly : p.isReadOnly === true,
        authorizedEditingAccounts: def.authorizedEditingAccounts,
        authorizedEditingContracts: def.authorizedEditingContracts,
      };
      updated.properties = properties;
    });
  }

  function hSetGroupBy(ctx, p, S, M, E) {
    editCollection(S, M, ctx, p.symbol, 'setGroupBy', 'active', function (updated, before) {
      if (before.groupBy.length > 0) {
        fail('GROUP_BY_ALREADY_SET', 'grouping can only be set once (currently: ' + before.groupBy.join(',') + ')');
      }
      var names = [];
      for (var i = 0; i < p.properties.length; i++) {
        var name = p.properties[i];
        if (typeof name !== 'string' || !RE_PROP_NAME.test(name)) {
          fail('BAD_PROPERTY_NAME', 'property name must be 1 to 25 letters/numbers');
        }
        if (!has(before.properties, name)) {
          fail('UNKNOWN_PROPERTY', 'property ' + name + ' is not defined on ' + before.symbol);
        }
        if (names.indexOf(name) < 0) names.push(name);
      }
      updated.groupBy = names;
    });
  }

  // ------------------------------------------------------------------ issuance

  function assertNoLocks(p) {
    if (p.lockTokens !== undefined || p.lockNfts !== undefined) {
      fail('LOCKED_TOKENS_UNSUPPORTED', 'lockTokens/lockNfts are not supported by this engine');
    }
  }

  function hIssue(ctx, p, S, M, E) {
    var collection = loadCollection(S, p.symbol);
    var issuer = requireIssuer(ctx, collection, 'issue');
    chargeFee(ctx, S, M, issuer, 'issueFee', p.feeSymbol);
    assertNoLocks(p);
    mintOne(ctx, collection, p.to, p.properties, S, M, E);
  }

  /**
   * Wiki: issueMultiple is NOT all-or-nothing — a bad entry fails alone while the other
   * entries still issue. Failures are reported as ITEM_FAILED events.
   */
  function hIssueMultiple(ctx, p, S, M, E) {
    var items = p.instances;
    if (!Array.isArray(items)) fail('BAD_BATCH', 'instances must be an array');
    if (items.length < 1 || items.length > MAX_ISSUE_BATCH) {
      fail('BAD_BATCH', 'instances must contain between 1 and ' + MAX_ISSUE_BATCH + ' entries');
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      try {
        if (!isObject(item)) fail('BAD_BATCH', 'instances[' + i + '] must be an object');
        assertNoLocks(item);
        var collection = loadCollection(S, item.symbol);
        var issuer = requireIssuer(ctx, collection, 'issueMultiple');
        chargeFee(ctx, S, M, issuer, 'issueFee', item.feeSymbol);
        mintOne(ctx, collection, item.to, item.properties, S, M, E);
      } catch (error) {
        emit(E, 'ITEM_FAILED', ctx, {
          data: {
            index: i,
            symbol: isObject(item) && typeof item.symbol === 'string' ? item.symbol : null,
            code: error && error.code ? String(error.code) : 'VM_ERROR',
            message: String(error && error.message ? error.message : error),
          },
        });
      }
    }
  }

  // ----------------------------------------------------------------- lifecycle

  function validateGroups(groups) {
    if (!Array.isArray(groups)) fail('BAD_BATCH', 'nfts must be an array');
    if (groups.length < 1) fail('BAD_BATCH', 'nfts must contain at least one entry');
    var total = 0;
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      if (!isObject(group)) fail('BAD_BATCH', 'nfts[' + i + '] must be an object');
      if (typeof group.symbol !== 'string' || !RE_SYMBOL.test(group.symbol)) {
        fail('BAD_SYMBOL', 'invalid collection symbol: ' + String(group.symbol));
      }
      if (!Array.isArray(group.ids) || group.ids.length < 1) {
        fail('BAD_BATCH', 'nfts[' + i + '].ids must be a non-empty array');
      }
      total += group.ids.length;
      if (total > MAX_BATCH) {
        fail('BATCH_TOO_LARGE', 'at most ' + MAX_BATCH + ' tokens may be handled in one action');
      }
    }
    return total;
  }

  function forEachToken(groups, visit) {
    var seen = {};
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      for (var j = 0; j < group.ids.length; j++) {
        var id = group.ids[j];
        if (typeof id !== 'string' || !RE_TOKEN_ID.test(id)) {
          fail('BAD_TOKEN_ID', 'token ids are numeric strings (got ' + String(id) + ')');
        }
        var key = instanceKey(group.symbol, id);
        if (has(seen, key)) fail('DUPLICATE_TOKEN', 'token ' + key + ' appears more than once');
        seen[key] = true;
        var instance = read(S_FROM_CALL, 'instance', key);
        if (instance === null) fail('INSTANCE_NOT_FOUND', 'instance ' + key + ' does not exist');
        visit(key, instance, group);
      }
    }
  }

  // forEachToken needs the snapshot; the handlers assign it just before calling so the
  // helper stays free of a hidden parameter (keeps the call sites terse).
  var S_FROM_CALL = null;

  function hTransfer(ctx, p, S, M, E) {
    if (typeof p.to !== 'string' || !RE_ACCOUNT.test(p.to)) {
      fail('BAD_ACCOUNT', 'recipient is not a valid account name');
    }
    if (p.to === 'null') {
      fail('USE_BURN', 'tokens cannot be transferred to null; use burn instead');
    }
    validateGroups(p.nfts);
    var to = p.to;
    var moves = [];
    S_FROM_CALL = S;
    forEachToken(p.nfts, function (key, instance) {
      requireAuth(ctx, instance.owner, 'active', 'transfer of ' + key);
      if (instance.owner === to) fail('SAME_OWNER', 'instance ' + key + ' is already owned by ' + to);
      if (instance.listedOrderId !== null) {
        fail(
          'INSTANCE_LISTED',
          'instance ' + key + ' is listed as ' + instance.listedOrderId + ' and must be cancelled first'
        );
      }
      moves.push({ key: key, instance: instance });
    });

    for (var i = 0; i < moves.length; i++) {
      var move = moves[i];
      var updated = copy(move.instance);
      updated.previousAccount = move.instance.owner;
      updated.owner = to;
      write(S, M, 'instance', move.key, updated);
      emit(E, 'NFT_TRANSFERRED', ctx, {
        symbol: move.instance.symbol,
        instanceId: move.key,
        account: to,
        data: { from: move.instance.owner, to: to },
      });
      emit(E, 'NFT_RECEIVED', ctx, { symbol: move.instance.symbol, instanceId: move.key, account: to });
    }
    ensureAccount(S, M, ctx, to);
  }

  function hBurn(ctx, p, S, M, E) {
    validateGroups(p.nfts);
    var targets = [];
    S_FROM_CALL = S;
    forEachToken(p.nfts, function (key, instance) {
      // Wiki: only the holder may burn, and it requires the active key.
      requireAuth(ctx, instance.owner, 'active', 'burn of ' + key);
      if (instance.listedOrderId !== null) {
        fail(
          'INSTANCE_LISTED',
          'instance ' + key + ' is listed as ' + instance.listedOrderId + ' and must be cancelled first'
        );
      }
      targets.push({ key: key, instance: instance });
    });

    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      var collection = loadCollection(S, target.instance.symbol);
      var updated = copy(collection);
      updated.burned = intAdd(collection.burned, '1');
      updated.circulatingSupply = intSub(collection.circulatingSupply, '1');
      write(S, M, 'collection', collection.symbol, updated);
      erase(S, M, 'instance', target.key);
      emit(E, 'NFT_BURNED', ctx, {
        symbol: target.instance.symbol,
        instanceId: target.key,
        account: target.instance.owner,
      });
    }
  }

  function hSetProperties(ctx, p, S, M, E) {
    var collection = loadCollection(S, p.symbol);
    var items = p.nfts;
    if (!Array.isArray(items)) fail('BAD_BATCH', 'nfts must be an array');
    if (items.length < 1 || items.length > MAX_BATCH) {
      fail('BAD_BATCH', 'nfts must contain between 1 and ' + MAX_BATCH + ' entries');
    }

    var seen = {};
    var updates = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isObject(item)) fail('BAD_BATCH', 'nfts[' + i + '] must be an object');
      if (typeof item.id !== 'string' || !RE_TOKEN_ID.test(item.id)) {
        fail('BAD_TOKEN_ID', 'token ids are numeric strings (got ' + String(item.id) + ')');
      }
      var key = instanceKey(collection.symbol, item.id);
      if (has(seen, key)) fail('DUPLICATE_TOKEN', 'token ' + key + ' appears more than once');
      seen[key] = true;
      var instance = read(S, 'instance', key);
      if (instance === null) fail('INSTANCE_NOT_FOUND', 'instance ' + key + ' does not exist');
      if (!isObject(item.properties)) fail('BAD_PROPERTIES', 'properties must be an object');

      var merged = copy(instance.properties);
      var changed = 0;
      for (var name in item.properties) {
        if (!has(item.properties, name)) continue;
        var def = collection.properties[name];
        if (def === undefined) {
          fail(
            'UNKNOWN_PROPERTY',
            'property ' + name + ' is not defined on ' + collection.symbol + ' (declare it with addProperty)'
          );
        }
        if (!canEditProperty(ctx, def)) {
          fail('NOT_AUTHORIZED', 'not authorized to edit property ' + name + ' of ' + collection.symbol);
        }
        if (def.isReadOnly && has(merged, name)) {
          fail('READ_ONLY_PROPERTY', 'property ' + name + ' is read-only once set');
        }
        merged[name] = coercePropertyValue(def, item.properties[name], name);
        changed += 1;
      }
      if (JSON.stringify(merged).length > MAX_PROPERTY_BYTES) {
        fail('PROPERTIES_TOO_LARGE', 'properties exceed ' + MAX_PROPERTY_BYTES + ' characters');
      }
      updates.push({ key: key, instance: instance, merged: merged, changed: changed });
    }

    for (var j = 0; j < updates.length; j++) {
      var update = updates[j];
      var next = copy(update.instance);
      next.properties = update.merged;
      write(S, M, 'instance', update.key, next);
      emit(E, 'PROPERTIES_UPDATED', ctx, {
        symbol: update.instance.symbol,
        instanceId: update.key,
        account: update.instance.owner,
        data: { changed: update.changed },
      });
    }
  }

  // ---------------------------------------------------------------- marketplace
  // Engine extension (upstream these live in the separate market contract).

  function hPlaceOrder(ctx, p, S, M, E) {
    if (typeof p.symbol !== 'string' || !RE_SYMBOL.test(p.symbol)) {
      fail('BAD_SYMBOL', 'invalid collection symbol: ' + String(p.symbol));
    }
    if (typeof p.id !== 'string' || !RE_TOKEN_ID.test(p.id)) {
      fail('BAD_TOKEN_ID', 'token ids are numeric strings (got ' + String(p.id) + ')');
    }
    var key = instanceKey(p.symbol, p.id);
    var instance = read(S, 'instance', key);
    if (instance === null) fail('INSTANCE_NOT_FOUND', 'instance ' + key + ' does not exist');
    requireAuth(ctx, instance.owner, 'active', 'listing of ' + key);
    if (instance.listedOrderId !== null) {
      fail('ALREADY_LISTED', 'instance ' + key + ' is already listed as ' + instance.listedOrderId);
    }
    var collection = loadCollection(S, instance.symbol);
    var priceSymbol = p.priceSymbol === undefined ? 'SCE' : p.priceSymbol;
    if (typeof priceSymbol !== 'string' || !RE_SYMBOL.test(priceSymbol)) {
      fail('BAD_SYMBOL', 'priceSymbol must be 3 to 10 uppercase letters');
    }
    var priceToken = read(S, 'token', priceSymbol);
    if (priceToken === null) {
      fail('TOKEN_NOT_FOUND', 'token ' + priceSymbol + ' does not exist yet');
    }
    if (typeof p.price !== 'string' || !RE_DECIMAL.test(p.price)) {
      fail('BAD_PRICE', 'price must be a decimal string with at most 8 fractional digits');
    }
    var amount = new BigNumber(p.price);
    if (!amount.gt(0)) fail('BAD_PRICE', 'price must be greater than zero');
    if (amount.decimalPlaces() > priceToken.precision) {
      fail(
        'BAD_PRICE',
        'price has ' + amount.decimalPlaces() + ' fractional digits but ' + priceSymbol + ' has precision ' + priceToken.precision
      );
    }

    var orderId = nextOrderId(S, M);
    var order = {
      id: orderId,
      symbol: instance.symbol,
      instanceId: key,
      seller: instance.owner,
      price: amount.toFixed(),
      priceSymbol: priceSymbol,
      status: 'OPEN',
      royaltyBps: collection.royaltyBps,
      royaltyRecipient: collection.royaltyRecipient,
      createdAtBlock: ctx.blockHeight,
      updatedAtBlock: ctx.blockHeight,
      filledAtBlock: null,
      fillBy: null,
      settlement: null,
    };
    write(S, M, 'order', orderId, order);

    var listed = copy(instance);
    listed.listedOrderId = orderId;
    write(S, M, 'instance', key, listed);

    ensureAccount(S, M, ctx, instance.owner);
    emit(E, 'ORDER_PLACED', ctx, {
      symbol: instance.symbol,
      instanceId: key,
      orderId: orderId,
      price: order.price,
      priceSymbol: order.priceSymbol,
      account: instance.owner,
    });
  }

  function hFillOrder(ctx, p, S, M, E) {
    var order = read(S, 'order', p.orderId);
    if (order === null) fail('ORDER_NOT_FOUND', 'order ' + p.orderId + ' does not exist');
    if (order.status !== 'OPEN') fail('ORDER_NOT_OPEN', 'order ' + order.id + ' is ' + order.status);
    if (ctx.auths.active.length === 0) {
      fail('ACTIVE_AUTH_REQUIRED', 'filling an order requires active authority');
    }
    var buyer = null;
    for (var i = 0; i < ctx.auths.active.length; i++) {
      if (ctx.auths.active[i] !== order.seller) {
        buyer = ctx.auths.active[i];
        break;
      }
    }
    if (buyer === null) fail('NOT_AUTHORIZED', 'the seller cannot fill their own order');

    var instance = read(S, 'instance', order.instanceId);
    if (instance === null) fail('INSTANCE_NOT_FOUND', 'instance ' + order.instanceId + ' no longer exists');
    if (instance.owner !== order.seller) {
      fail(
        'INSTANCE_NOT_OWNED_BY_SELLER',
        'instance ' + instance.id + ' is owned by ' + instance.owner + ' but the order was placed by ' + order.seller
      );
    }
    if (instance.listedOrderId !== order.id) {
      fail('LISTING_MISMATCH', 'instance ' + instance.id + ' is not listed as ' + order.id);
    }

    var param = read(S, 'param', PARAM_KEY);
    if (param === null) fail('PARAM_NOT_FOUND', 'fee parameter row is missing');
    var priceToken = read(S, 'token', order.priceSymbol);
    if (priceToken === null) {
      fail('TOKEN_NOT_FOUND', 'token ' + order.priceSymbol + ' does not exist');
    }
    var feeBpsValue = param.fees.fillOrderFeeBps;
    if (typeof feeBpsValue !== 'string') fail('BAD_FEE_KEY', 'fillOrderFeeBps is missing from the fee schedule');
    var split = splitRoyalty(order.price, order.royaltyBps, priceToken.precision);
    var price = new BigNumber(order.price);
    var fee = price.times(new BigNumber(feeBpsValue)).div(10000).decimalPlaces(priceToken.precision, BigNumber.ROUND_DOWN);
    if (fee.plus(split.royalty).gt(price)) {
      fail('SETTLEMENT_ERROR', 'royalty plus the fillOrder fee exceed the price');
    }
    var proceeds = price.minus(split.royalty).minus(fee);
    var settlement = {
      price: split.price,
      royalty: split.royalty,
      fee: fee.toFixed(priceToken.precision),
      sellerProceeds: proceeds.toFixed(priceToken.precision),
      royaltyRecipient: order.royaltyRecipient,
      buyer: buyer,
      seller: order.seller,
    };

    var buyerBalance = loadBalance(S, buyer, order.priceSymbol);
    if (new BigNumber(buyerBalance.quantity).lt(price)) {
      fail(
        'INSUFFICIENT_BALANCE',
        buyer + ' has ' + buyerBalance.quantity + ' ' + order.priceSymbol + ' but the order costs ' + order.price
      );
    }
    var deltas = {};
    var legs = [
      [buyer, price.times(-1)],
      [order.seller, proceeds],
      [order.royaltyRecipient, split.royalty],
      [param.treasury, fee],
    ];
    for (var li = 0; li < legs.length; li++) {
      var legAccount = legs[li][0];
      if (!has(deltas, legAccount)) deltas[legAccount] = new BigNumber(0);
      deltas[legAccount] = deltas[legAccount].plus(legs[li][1]);
    }
    settleDeltas(S, M, order.priceSymbol, deltas);

    var nextInstance = copy(instance);
    nextInstance.previousAccount = instance.owner;
    nextInstance.owner = buyer;
    nextInstance.listedOrderId = null;
    write(S, M, 'instance', instance.id ? instanceKey(instance.symbol, instance.id) : order.instanceId, nextInstance);

    var nextOrder = copy(order);
    nextOrder.status = 'FILLED';
    nextOrder.updatedAtBlock = ctx.blockHeight;
    nextOrder.filledAtBlock = ctx.blockHeight;
    nextOrder.fillBy = buyer;
    nextOrder.settlement = settlement;
    write(S, M, 'order', order.id, nextOrder);

    ensureAccount(S, M, ctx, buyer);
    emit(E, 'ORDER_FILLED', ctx, {
      symbol: order.symbol,
      instanceId: order.instanceId,
      orderId: order.id,
      price: settlement.price,
      priceSymbol: order.priceSymbol,
      royalty: settlement.royalty,
      fee: settlement.fee,
      sellerProceeds: settlement.sellerProceeds,
      account: buyer,
    });
    emit(E, 'NFT_RECEIVED', ctx, { symbol: order.symbol, instanceId: order.instanceId, account: buyer });
  }

  function hCancelOrder(ctx, p, S, M, E) {
    var order = read(S, 'order', p.orderId);
    if (order === null) fail('ORDER_NOT_FOUND', 'order ' + p.orderId + ' does not exist');
    if (order.status !== 'OPEN') fail('ORDER_NOT_OPEN', 'order ' + order.id + ' is ' + order.status);
    requireAuth(ctx, order.seller, 'active', 'cancellation of ' + order.id);

    var instance = read(S, 'instance', order.instanceId);
    if (instance !== null && instance.listedOrderId === order.id) {
      var unlisted = copy(instance);
      unlisted.listedOrderId = null;
      write(S, M, 'instance', order.instanceId, unlisted);
    }

    var cancelled = copy(order);
    cancelled.status = 'CANCELLED';
    cancelled.updatedAtBlock = ctx.blockHeight;
    write(S, M, 'order', order.id, cancelled);
    emit(E, 'ORDER_CANCELLED', ctx, {
      symbol: order.symbol,
      instanceId: order.instanceId,
      orderId: order.id,
      account: order.seller,
    });
  }

  // ------------------------------------------------------- fungible tokens contract
  // Wiki Tokens-Contract (docs/TOKENS-DESIGN.md v1 scope). Quantities are decimal
  // strings; all arithmetic goes through BigNumber. Rows live in the 'token' and
  // 'balance' partitions (keys: symbol / <account>:<SYMBOL>).

  function loadToken(S, symbol) {
    if (typeof symbol !== 'string' || !RE_SYMBOL.test(symbol)) {
      fail('BAD_SYMBOL', 'invalid token symbol: ' + String(symbol));
    }
    var token = read(S, 'token', symbol);
    if (token === null) fail('TOKEN_NOT_FOUND', 'token ' + symbol + ' does not exist');
    return token;
  }

  /** Holder row, synthesising a zero row when the account never received the token. */
  function loadBalance(S, account, symbol) {
    var balance = read(S, 'balance', account + ':' + symbol);
    if (balance === null) return { account: account, symbol: symbol, quantity: '0' };
    return balance;
  }

  /**
   * Marketplace settlement (step 4): applies net balance deltas in one write set.
   * Legs that share a holder (seller == royalty recipient, treasury == buyer, ...)
   * are summed first so no credit overwrites another; by construction
   * sellerProceeds + royalty + fee === price, so the op still nets to zero.
   */
  function settleDeltas(S, M, symbol, deltas) {
    for (var account in deltas) {
      if (!has(deltas, account)) continue;
      var delta = deltas[account];
      if (delta.isZero()) continue;
      var balance = loadBalance(S, account, symbol);
      var quantity = new BigNumber(balance.quantity).plus(delta);
      if (quantity.lt(0)) {
        fail('INSUFFICIENT_BALANCE', account + ' would end up with ' + quantity.toFixed() + ' ' + symbol);
      }
      write(S, M, 'balance', account + ':' + symbol, {
        account: account,
        symbol: symbol,
        quantity: quantity.toFixed(),
      });
    }
  }

  /** Wiki quantities: decimal string, > 0, fractional digits <= the token's precision. */
  function validateQuantity(token, value) {
    if (typeof value !== 'string' || !RE_DECIMAL.test(value)) {
      fail('BAD_QUANTITY', 'quantity must be a decimal string with at most 8 fractional digits');
    }
    var amount = new BigNumber(value);
    if (!amount.gt(0)) fail('BAD_QUANTITY', 'quantity must be greater than zero');
    if (amount.decimalPlaces() > token.precision) {
      fail(
        'PRECISION_EXCEEDED',
        'token ' + token.symbol + ' has precision ' + token.precision + ' (got "' + value + '")'
      );
    }
    return value;
  }

  function decAdd(a, b) {
    return new BigNumber(a).plus(new BigNumber(b)).toFixed();
  }

  function decSub(a, b) {
    return new BigNumber(a).minus(new BigNumber(b)).toFixed();
  }

  function requireUnderMaxSupply(token, quantity) {
    if (token.maxSupply === '0') return;
    var next = new BigNumber(token.supply).plus(quantity);
    if (next.gt(new BigNumber(token.maxSupply))) {
      fail('MAX_SUPPLY_REACHED', 'token ' + token.symbol + ' reached its max supply of ' + token.maxSupply);
    }
  }

  /** Wiki: only the account that created the token may issue it. */
  function requireTokenIssuer(ctx, token, action) {
    for (var i = 0; i < ctx.auths.active.length; i++) {
      if (ctx.auths.active[i] === token.issuer) return token.issuer;
    }
    fail('NOT_AUTHORIZED', 'only the issuer of ' + token.symbol + ' may ' + action);
    return null;
  }

  /** Active authority is mandatory; the first active signer acts as the holder. */
  function activeSender(ctx, action) {
    if (ctx.auths.active.length === 0) {
      fail('ACTIVE_AUTH_REQUIRED', action + ' requires active authority');
    }
    return ctx.auths.active[0];
  }

  function validRecipient(value, field) {
    if (typeof value !== 'string' || !RE_ACCOUNT.test(value)) {
      fail('BAD_ACCOUNT', field + ' is not a valid account name: ' + String(value));
    }
    if (value === 'null') {
      fail('USE_BURN', 'tokens cannot be sent to null; use burn instead');
    }
    return value;
  }

  /** Owner-gated edit of a token row (level per action, mirroring editCollection). */
  function editToken(S, M, ctx, symbol, action, level, mutate) {
    var token = loadToken(S, symbol);
    requireOwner(ctx, token, action, level);
    var updated = copy(token);
    mutate(updated, token);
    write(S, M, 'token', token.symbol, updated);
    return updated;
  }

  function tCreate(ctx, p, S, M, E) {
    var creator = activeSender(ctx, 'create');
    if (typeof p.symbol !== 'string' || !RE_SYMBOL.test(p.symbol)) {
      fail('BAD_SYMBOL', 'symbol must be 3 to 10 uppercase letters');
    }
    validateName(p.name, 'name', RE_NAME);
    if (typeof p.precision !== 'number' || !isFinite(p.precision) || Math.floor(p.precision) !== p.precision) {
      fail('BAD_PRECISION', 'precision must be an integer between 0 and 8');
    }
    if (p.precision < 0 || p.precision > 8) {
      fail('BAD_PRECISION', 'precision must be an integer between 0 and 8');
    }
    if (p.url !== undefined && (typeof p.url !== 'string' || p.url.length > 255)) {
      fail('BAD_URL', 'url must be a string of at most 255 characters');
    }
    var maxSupply = '0';
    if (p.maxSupply !== undefined) {
      if (typeof p.maxSupply !== 'string' || !RE_UINT.test(p.maxSupply) || intGt(p.maxSupply, String(MAX_SAFE))) {
        fail('BAD_MAX_SUPPLY', 'maxSupply must be an integer between 1 and ' + MAX_SAFE);
      }
      if (intLt(p.maxSupply, '1')) fail('BAD_MAX_SUPPLY', 'maxSupply must be at least 1');
      maxSupply = p.maxSupply;
    }
    if (read(S, 'token', p.symbol) !== null) {
      fail('TOKEN_EXISTS', 'token ' + p.symbol + ' already exists');
    }
    chargeFee(ctx, S, M, creator, 'tokenCreationFee');

    var token = {
      symbol: p.symbol,
      name: p.name,
      precision: p.precision,
      maxSupply: maxSupply,
      supply: '0',
      issuer: creator,
      url: p.url === undefined ? '' : p.url,
      metadata: '',
      createdAtBlock: ctx.blockHeight,
      createdAt: ctx.timestamp,
    };
    write(S, M, 'token', p.symbol, token);
    ensureAccount(S, M, ctx, creator);
    emit(E, 'TOKEN_CREATED', ctx, { symbol: p.symbol, account: creator });
    return token;
  }

  function tIssue(ctx, p, S, M, E) {
    var token = loadToken(S, p.symbol);
    var issuer = requireTokenIssuer(ctx, token, 'issue');
    validRecipient(p.to, 'to');
    var quantity = validateQuantity(token, p.quantity);
    requireUnderMaxSupply(token, quantity);
    chargeFee(ctx, S, M, issuer, 'issueFee', p.feeSymbol);

    var balance = loadBalance(S, p.to, token.symbol);
    var credited = {
      account: p.to,
      symbol: token.symbol,
      quantity: decAdd(balance.quantity, quantity),
    };
    write(S, M, 'balance', p.to + ':' + token.symbol, credited);

    var updated = copy(token);
    updated.supply = decAdd(token.supply, quantity);
    write(S, M, 'token', token.symbol, updated);

    ensureAccount(S, M, ctx, p.to);
    emit(E, 'TOKEN_ISSUED', ctx, {
      symbol: token.symbol,
      account: p.to,
      data: { quantity: quantity, issuer: token.issuer },
    });
    return credited;
  }

  function tTransfer(ctx, p, S, M, E) {
    var from = activeSender(ctx, 'transfer');
    validRecipient(p.to, 'to');
    if (from === p.to) fail('SAME_ACCOUNT', 'sender and recipient are the same account: ' + from);
    var token = loadToken(S, p.symbol);
    var quantity = validateQuantity(token, p.quantity);

    var senderBalance = loadBalance(S, from, token.symbol);
    if (new BigNumber(senderBalance.quantity).lt(quantity)) {
      fail(
        'INSUFFICIENT_BALANCE',
        from + ' has ' + senderBalance.quantity + ' ' + token.symbol + ' but tried to transfer ' + quantity
      );
    }
    write(S, M, 'balance', from + ':' + token.symbol, {
      account: from,
      symbol: token.symbol,
      quantity: decSub(senderBalance.quantity, quantity),
    });

    var recipientBalance = loadBalance(S, p.to, token.symbol);
    var credited = {
      account: p.to,
      symbol: token.symbol,
      quantity: decAdd(recipientBalance.quantity, quantity),
    };
    write(S, M, 'balance', p.to + ':' + token.symbol, credited);

    ensureAccount(S, M, ctx, p.to);
    emit(E, 'TOKEN_TRANSFERRED', ctx, {
      symbol: token.symbol,
      account: p.to,
      data: { from: from, quantity: quantity },
    });
    return credited;
  }

  function tBurn(ctx, p, S, M, E) {
    var holder = activeSender(ctx, 'burn');
    var token = loadToken(S, p.symbol);
    var quantity = validateQuantity(token, p.quantity);

    var balance = loadBalance(S, holder, token.symbol);
    if (new BigNumber(balance.quantity).lt(quantity)) {
      fail(
        'INSUFFICIENT_BALANCE',
        holder + ' has ' + balance.quantity + ' ' + token.symbol + ' but tried to burn ' + quantity
      );
    }
    write(S, M, 'balance', holder + ':' + token.symbol, {
      account: holder,
      symbol: token.symbol,
      quantity: decSub(balance.quantity, quantity),
    });

    if (new BigNumber(token.supply).lt(quantity)) {
      fail(
        'SUPPLY_UNDERFLOW',
        'token ' + token.symbol + ' supply ' + token.supply + ' is below the burn amount ' + quantity
      );
    }
    var updated = copy(token);
    updated.supply = decSub(token.supply, quantity);
    write(S, M, 'token', token.symbol, updated);

    emit(E, 'TOKEN_BURNED', ctx, {
      symbol: token.symbol,
      account: holder,
      data: { quantity: quantity },
    });
    return updated;
  }

  function tUpdateUrl(ctx, p, S, M, E) {
    if (typeof p.url !== 'string' || p.url.length > 255) {
      fail('BAD_URL', 'url must be a string of at most 255 characters');
    }
    var token = editToken(S, M, ctx, p.symbol, 'updateUrl', 'either', function (updated) {
      updated.url = p.url;
    });
    emit(E, 'TOKEN_UPDATED', ctx, {
      symbol: token.symbol,
      account: token.issuer,
      data: { field: 'url', url: token.url },
    });
    return token;
  }

  function tUpdateMetadata(ctx, p, S, M, E) {
    if (!isObject(p.metadata)) fail('BAD_METADATA', 'metadata must be an object');
    assertNoFloats(p.metadata, 'metadata');
    var encoded = JSON.stringify(p.metadata);
    if (encoded.length > MAX_METADATA_CHARS) {
      fail('METADATA_TOO_LARGE', 'metadata must stringify to at most ' + MAX_METADATA_CHARS + ' characters');
    }
    var token = editToken(S, M, ctx, p.symbol, 'updateMetadata', 'either', function (updated) {
      updated.metadata = encoded;
    });
    emit(E, 'TOKEN_UPDATED', ctx, {
      symbol: token.symbol,
      account: token.issuer,
      data: { field: 'metadata' },
    });
    return token;
  }

  function tTransferOwnership(ctx, p, S, M, E) {
    if (typeof p.to !== 'string' || !RE_ACCOUNT.test(p.to)) {
      fail('BAD_ACCOUNT', 'new owner is not a valid account name');
    }
    var token = loadToken(S, p.symbol);
    requireOwner(ctx, token, 'transferOwnership', 'active');
    if (p.to === token.issuer) fail('SAME_OWNER', 'token is already owned by ' + p.to);
    var updated = copy(token);
    updated.issuer = p.to;
    write(S, M, 'token', token.symbol, updated);
    ensureAccount(S, M, ctx, p.to);
    emit(E, 'TOKEN_UPDATED', ctx, {
      symbol: token.symbol,
      account: p.to,
      data: { field: 'issuer', from: token.issuer },
    });
    return updated;
  }

  function tUpdatePrecision(ctx, p, S, M, E) {
    var token = loadToken(S, p.symbol);
    requireOwner(ctx, token, 'updatePrecision', 'active');
    if (
      typeof p.precision !== 'number' ||
      !isFinite(p.precision) ||
      Math.floor(p.precision) !== p.precision ||
      p.precision < 0 ||
      p.precision > 8
    ) {
      fail('BAD_PRECISION', 'precision must be an integer between 0 and 8');
    }
    if (p.precision <= token.precision) {
      fail(
        'PRECISION_NOT_INCREASED',
        'precision of ' + token.symbol + ' can only be increased (current: ' + token.precision + ')'
      );
    }
    var updated = copy(token);
    updated.precision = p.precision;
    write(S, M, 'token', token.symbol, updated);
    emit(E, 'TOKEN_UPDATED', ctx, {
      symbol: token.symbol,
      account: token.issuer,
      data: { field: 'precision', precision: updated.precision },
    });
    return updated;
  }

  // ------------------------------------------------------------- fee engine

  /**
   * Debit 'amount' of the fee currency from 'payer' and credit 'param.treasury'
   * (docs/TOKENS-DESIGN.md step 3). A "0" fee — the bootstrap default — returns
   * before any balance is touched, so actions stay free until the admin raises the
   * schedule through 'engine.setParam'. Debit and credit always move the same
   * amount of the same symbol, so the conservation invariant (sum of balance
   * deltas vs supply) still holds per operation.
   */
  function chargeFee(ctx, S, M, payer, feeKey, feeSymbol) {
    var param = read(S, 'param', PARAM_KEY);
    if (param === null) fail('PARAM_NOT_FOUND', 'fee parameter row is missing');
    var amount = param.fees[feeKey];
    if (typeof amount !== 'string') fail('BAD_FEE_KEY', 'unknown fee key: ' + feeKey);
    if (amount === '0') return null;
    var symbol = feeSymbol === undefined ? FEE_SYMBOL : feeSymbol;
    if (param.feeTokens.indexOf(symbol) < 0) {
      fail('FEE_TOKEN_UNSUPPORTED', 'fee token ' + symbol + ' is not in param.feeTokens');
    }
    var feeToken = read(S, 'token', symbol);
    if (feeToken === null) {
      fail('TOKEN_NOT_FOUND', 'fee token ' + symbol + ' does not exist yet');
    }
    if (new BigNumber(amount).decimalPlaces() > feeToken.precision) {
      fail('BAD_FEE', 'fee ' + feeKey + ' exceeds the precision of ' + symbol);
    }
    // Paying the treasury yourself (admin creating while treasury == admin) is a no-op.
    if (payer === param.treasury) return amount;
    var payerBalance = read(S, 'balance', payer + ':' + symbol);
    if (payerBalance === null || new BigNumber(payerBalance.quantity).lt(amount)) {
      fail('INSUFFICIENT_BALANCE', payer + ' cannot pay the ' + feeKey + ' of ' + amount + ' ' + symbol);
    }
    write(S, M, 'balance', payer + ':' + symbol, {
      account: payer,
      symbol: symbol,
      quantity: new BigNumber(payerBalance.quantity).minus(amount).toFixed(),
    });
    var treasuryBalance = read(S, 'balance', param.treasury + ':' + symbol);
    var treasuryQuantity = '0';
    if (treasuryBalance !== null) treasuryQuantity = treasuryBalance.quantity;
    write(S, M, 'balance', param.treasury + ':' + symbol, {
      account: param.treasury,
      symbol: symbol,
      quantity: new BigNumber(treasuryQuantity).plus(amount).toFixed(),
    });
    return amount;
  }

  /**
   * 'engine.setParam' — admin-only partial patch of the fee row (active authority of
   * 'param.admin'). The host schema already rejects unknown keys; the VM re-validates
   * because TestEngine callers may bypass zod. 'admin'/'treasury' are immutable and
   * simply not accepted here (the guard would reject a write that changed them).
   */
  function hSetParam(ctx, p, S, M, E) {
    var param = read(S, 'param', PARAM_KEY);
    if (param === null) fail('PARAM_NOT_FOUND', 'fee parameter row is missing');
    if (!hasAuth(ctx, param.admin, 'active')) {
      fail('NOT_AUTHORIZED', 'only the engine admin ' + param.admin + ' may setParam');
    }
    if (p.fees === undefined && p.feeTokens === undefined) {
      fail('BAD_PARAMS', 'setParam requires a fees patch and/or feeTokens');
    }
    var updated = copy(param);
    updated.fees = copy(param.fees);
    if (p.fees !== undefined) {
      if (!isObject(p.fees)) fail('BAD_FEES', 'fees must be an object');
      var keys = Object.keys(p.fees);
      if (keys.length === 0) fail('BAD_FEES', 'fees must patch at least one fee');
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (FEE_KEYS.indexOf(key) < 0) fail('BAD_FEE_KEY', 'unknown fee: ' + key);
        var value = p.fees[key];
        if (key === 'fillOrderFeeBps') {
          if (typeof value !== 'string' || !RE_UINT.test(value) || intGt(value, '10000')) {
            fail('BAD_FEE', 'fillOrderFeeBps must be an unsigned integer at most 10000');
          }
        } else if (typeof value !== 'string' || !RE_DECIMAL.test(value)) {
          fail('BAD_FEE', 'fee ' + key + ' must be a non-negative decimal string');
        }
        updated.fees[key] = value;
      }
    }
    if (p.feeTokens !== undefined) {
      if (!Array.isArray(p.feeTokens) || p.feeTokens.length > 10) {
        fail('BAD_FEE_TOKENS', 'feeTokens must be an array of at most 10 symbols');
      }
      var seen = [];
      for (var j = 0; j < p.feeTokens.length; j++) {
        var entry = p.feeTokens[j];
        if (typeof entry !== 'string' || !RE_SYMBOL.test(entry)) {
          fail('BAD_FEE_TOKENS', 'invalid fee token symbol: ' + String(entry));
        }
        if (seen.indexOf(entry) >= 0) fail('BAD_FEE_TOKENS', 'duplicate fee token: ' + entry);
        seen.push(entry);
      }
      updated.feeTokens = seen;
    }
    write(S, M, 'param', PARAM_KEY, updated);
    emit(E, 'PARAM_UPDATED', ctx, {
      account: param.admin,
      data: { fees: updated.fees, feeTokens: updated.feeTokens },
    });
    return updated;
  }

  // ------------------------------------------------------------------ dispatch

  // Contract-scoped dispatch: several action names are shared across contracts, so the
  // envelope's contract selects the table (mirrors real Steem Engine multiplexing).
  var HANDLERS = {
    nft: {
      create: hCreate,
      updateUrl: hUpdateUrl,
      updateMetadata: hUpdateMetadata,
      updateName: hUpdateName,
      updateOrgName: hUpdateOrgName,
      updateProductName: hUpdateProductName,
      addAuthorizedIssuingAccounts: hAddAuthorizedIssuingAccounts,
      removeAuthorizedIssuingAccounts: hRemoveAuthorizedIssuingAccounts,
      addAuthorizedIssuingContracts: hAddAuthorizedIssuingContracts,
      removeAuthorizedIssuingContracts: hRemoveAuthorizedIssuingContracts,
      transferOwnership: hTransferOwnership,
      addProperty: hAddProperty,
      setPropertyPermissions: hSetPropertyPermissions,
      setProperties: hSetProperties,
      setGroupBy: hSetGroupBy,
      updatePropertyDefinition: hUpdatePropertyDefinition,
      issue: hIssue,
      issueMultiple: hIssueMultiple,
      transfer: hTransfer,
      burn: hBurn,
      placeOrder: hPlaceOrder,
      fillOrder: hFillOrder,
      cancelOrder: hCancelOrder,
    },
    tokens: {
      create: tCreate,
      issue: tIssue,
      transfer: tTransfer,
      burn: tBurn,
      updateUrl: tUpdateUrl,
      updateMetadata: tUpdateMetadata,
      transferOwnership: tTransferOwnership,
      updatePrecision: tUpdatePrecision,
    },
    engine: {
      setParam: hSetParam,
    },
  };

  function run(request) {
    if (!isObject(request)) fail('BAD_REQUEST', 'request must be an object');
    var ctx = request.context;
    var S = request.state;
    if (!isObject(S)) fail('BAD_STATE', 'state snapshot is missing');
    if (!isObject(ctx) || typeof ctx.blockHeight !== 'number') {
      fail('BAD_CONTEXT', 'execution context is missing');
    }
    // The contract comes from the envelope (validated by the host); a missing value is
    // the legacy engine shorthand, which has always addressed the 'nft' contract.
    var contract = request.contract === undefined ? 'nft' : request.contract;
    if (typeof contract !== 'string' || !has(HANDLERS, contract)) {
      fail('UNKNOWN_CONTRACT', 'unknown contract: ' + String(contract));
    }
    var table = HANDLERS[contract];
    if (typeof request.action !== 'string' || !has(table, request.action)) {
      fail('UNKNOWN_ACTION', 'unknown action: ' + String(request.action) + ' for contract ' + contract);
    }
    var handler = table[request.action];
    if (typeof handler !== 'function') {
      fail('UNKNOWN_ACTION', 'action ' + request.action + ' of contract ' + contract + ' is not executable');
    }
    var mutations = [];
    var events = [];
    handler(ctx, request.params, S, mutations, events);
    return { ok: true, mutations: mutations, events: events };
  }

  function nftExecute(requestJson) {
    var out;
    try {
      out = run(JSON.parse(requestJson));
    } catch (error) {
      out = {
        ok: false,
        error: {
          code: error && error.code ? String(error.code) : 'VM_ERROR',
          message: String((error && error.message) ? error.message : error),
        },
      };
    }
    return JSON.stringify(out);
  }

  globalThis.__nftExecute = nftExecute;
})();
`;
