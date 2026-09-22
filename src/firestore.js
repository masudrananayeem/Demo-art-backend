// Minimal Firestore REST client for Cloudflare Workers.
// Authenticates as a Google service account using the JWT bearer flow
// (signed with Web Crypto, no Node-only libraries needed).

let cachedToken = null; // { token, exp }

// Read-through cache for Firestore REST reads. Cloudflare Worker isolates keep
// module state warm between requests, so this removes repeated reads caused by
// React StrictMode, dashboard remounts, route navigation, and auth middleware.
// Every successful write invalidates the affected collection/doc cache.
const readCache = new Map();
const readInFlight = new Map();

const LIST_TTL_MS = {
  products: 300_000,
  categories: 300_000,
  subcategories: 300_000,
  siteContent: 300_000,
  adminUsers: 120_000,
  adminRequests: 15_000,
  users: 120_000,
  orders: 30_000,
  messages: 30_000,
  paymentSettings: 300_000,
  storeSettings: 300_000,
  memberships: 120_000,
  membershipRequests: 120_000,
  coinRules: 60_000,
  circulation: 120_000,
  contactSubmissions: 120_000,
  auditLogs: 120_000,
};

const GET_TTL_MS = {
  adminUsers: 120_000,
  users: 120_000,
  siteContent: 300_000,
  categories: 300_000,
  subcategories: 300_000,
  storeSettings: 300_000,
  paymentSettings: 300_000,
  memberships: 120_000,
  coinRules: 300_000,
};

const QUERY_TTL_MS = {
  messages: 30_000,
  orders: 30_000,
  circulation: 120_000,
  membershipRequests: 120_000,
  users: 120_000,
  products: 300_000,
};

function cloneCached(value) {
  if (value === null || value === undefined) return value;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function projectIdOf(env) { return String(env.FIREBASE_PROJECT_ID || "default"); }

function splitCollectionPath(path) {
  return String(path || "").split("/").filter(Boolean)[0] || "";
}

function cacheKey(project, kind, value) { return `${project}:${kind}:${value}`; }

function clearCollectionCache(env, collection) {
  const project = projectIdOf(env);
  readCache.delete(cacheKey(project, "list", collection));
  const prefixes = [
    cacheKey(project, "get", `${collection}/`),
    cacheKey(project, "query", `${collection}|`),
  ];
  for (const key of readCache.keys()) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) readCache.delete(key);
  }
}

function clearDocumentCache(env, path) {
  const project = projectIdOf(env);
  readCache.delete(cacheKey(project, "get", path));
  clearCollectionCache(env, splitCollectionPath(path));
}

const NOTIFICATION_SECTIONS = new Set(["products","categories","subcategories","orders","messages","homepage","payments"]);
const NOTIFICATION_COLLECTION_TO_SECTION = {
  products: "products",
  categories: "categories",
  subcategories: "subcategories",
  orders: "orders",
  messages: "messages",
  siteContent: "homepage",
  storeSettings: "payments",
};

async function bumpAdminNotification(env, collection) {
  const section = NOTIFICATION_COLLECTION_TO_SECTION[collection];
  if (!section) return;
  try {
    const token = await getAccessToken(env);
    const docName = `${baseUrl(env)}/adminNotificationState`;
    const stamp = new Date().toISOString();
    const res = await fetch(`${baseUrl(env)}:commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        writes: [{
          update: { name: docName, fields: { [section]: { stringValue: stamp } } },
          updateMask: { fieldPaths: [section] },
        }],
      }),
    });
    if (!res.ok) return;
    clearDocumentCache(env, "adminNotificationState");
  } catch (_) {
    // Notification dots are non-critical and must never break the real mutation.
  }
}

function invalidateTransactionWrites(env, writes) {
  for (const write of Array.isArray(writes) ? writes : []) {
    const resource = write?.update?.name || write?.delete || "";
    const marker = "/documents/";
    const index = String(resource).indexOf(marker);
    if (index >= 0) {
      const path = String(resource).slice(index + marker.length);
      clearDocumentCache(env, path);
    }
  }
}

async function cachedRead(key, ttlMs, loader, enabled = true) {
  if (!enabled || !ttlMs) return loader();
  const now = Date.now();
  const cached = readCache.get(key);
  if (cached && cached.expiresAt > now) return cloneCached(cached.value);
  if (readInFlight.has(key)) return cloneCached(await readInFlight.get(key));

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      readCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .catch((error) => {
      // If Firestore temporarily rejects reads (for example, a no-cost quota
      // window is exhausted), serve the last known value instead of turning a
      // temporary database limit into a broken storefront/admin screen.
      if (cached && /429|Quota exceeded|RESOURCE_EXHAUSTED/i.test(String(error?.message || error))) {
        return cached.value;
      }
      throw error;
    })
    .finally(() => readInFlight.delete(key));
  readInFlight.set(key, promise);
  return cloneCached(await promise);
}

function base64url(input) {
  let str = typeof input === "string" ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(env) {
  if (cachedToken && cachedToken.exp - 60 > Date.now() / 1000) return cachedToken.token;

  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) {
    throw new Error(
      "Missing FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY. For local dev, create a `.dev.vars` file in Art-Canvas-backend (copy .dev.vars.example) and restart `wrangler dev`. For production, set them with `wrangler secret put`."
    );
  }
  const privateKeyPem = privateKeyRaw.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error("Failed to mint Google access token: " + (await res.text()));
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: now + data.expires_in };
  return cachedToken.token;
}

function baseUrl(env) {
  if (!env.FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID === "your-firebase-project-id") {
    throw new Error(
      'FIREBASE_PROJECT_ID is not set (it\'s still the placeholder "your-firebase-project-id"). Open wrangler.toml and set it under [vars] to your real Firebase project ID, then restart `wrangler dev`. For production, redeploy after changing wrangler.toml.'
    );
  }
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// ---- JS <-> Firestore REST "fields" value encoding ----

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in v) return fromFirestoreDoc({ fields: v.mapValue.fields || {} });
  return null;
}

function fromFirestoreDoc(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = fromFirestoreValue(v);
  return out;
}

function idFromName(name) {
  return name.split("/").pop();
}

// ---- Public helpers ----

export async function fsGet(env, path, options = {}) {
  const collection = splitCollectionPath(path);
  const ttl = options.cache === false ? 0 : (options.ttlMs ?? GET_TTL_MS[collection] ?? 0);
  const key = cacheKey(projectIdOf(env), "get", path);
  return cachedRead(key, ttl, async () => {
    const token = await getAccessToken(env);
    const res = await fetch(`${baseUrl(env)}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${await res.text()}`);
    const doc = await res.json();
    return { id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) };
  }, ttl > 0);
}

export async function fsList(env, collection, options = {}) {
  const ttl = options.cache === false ? 0 : (options.ttlMs ?? LIST_TTL_MS[collection] ?? 0);
  const key = cacheKey(projectIdOf(env), "list", collection);
  return cachedRead(key, ttl, async () => {
    const token = await getAccessToken(env);
    let docs = [];
    let pageToken;
    do {
      const url = new URL(`${baseUrl(env)}/${collection}`);
      url.searchParams.set("pageSize", "300");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Firestore LIST ${collection} failed: ${await res.text()}`);
      const data = await res.json();
      docs = docs.concat(data.documents || []);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return docs.map((doc) => ({ id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) }));
  }, ttl > 0);
}

export async function fsCreate(env, collection, data, id) {
  const token = await getAccessToken(env);
  const url = new URL(`${baseUrl(env)}/${collection}`);
  if (id) url.searchParams.set("documentId", id);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore CREATE ${collection} failed: ${await res.text()}`);
  const doc = await res.json();
  const saved = { id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) };
  clearCollectionCache(env, collection);
  await bumpAdminNotification(env, collection);
  return saved;
}

// Patch (partial update) specific fields. Optionally pass expectedUpdateTime for
// optimistic-concurrency (used for safe stock decrements).
export async function fsPatch(env, path, data, expectedUpdateTime) {
  const token = await getAccessToken(env);
  const url = new URL(`${baseUrl(env)}/${path}`);
  for (const key of Object.keys(data)) url.searchParams.append("updateMask.fieldPaths", key);
  const body = { fields: toFirestoreFields(data) };
  if (expectedUpdateTime) body.currentDocument = { updateTime: expectedUpdateTime };
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Firestore PATCH ${path} failed: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const doc = await res.json();
  const saved = { id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) };
  clearDocumentCache(env, path);
  await bumpAdminNotification(env, splitCollectionPath(path));
  return saved;
}


// Run a Firestore REST transaction. The callback receives a transaction id and
// can read documents inside that transaction. Writes are committed atomically.
// This is used by checkout so stock reservation cannot fail because of a stale
// updateTime/precondition (the previous approach could surface HTTP 409).
export async function fsRunTransaction(env, callback, maxAttempts = 5) {
  const token = await getAccessToken(env);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const begin = await fetch(`${baseUrl(env)}:beginTransaction`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ options: { readWrite: {} } }),
    });
    if (!begin.ok) throw new Error(`Firestore BEGIN TRANSACTION failed: ${await begin.text()}`);
    const { transaction } = await begin.json();

    const txGet = async (path) => {
      const url = new URL(`${baseUrl(env)}/${path}`);
      url.searchParams.set("transaction", transaction);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 404) return null;
      if (!res.ok) {
        const err = new Error(`Firestore TX GET ${path} failed: ${await res.text()}`);
        err.status = res.status;
        throw err;
      }
      const doc = await res.json();
      return { id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) };
    };

    try {
      const result = await callback({ transaction, get: txGet });
      const writes = Array.isArray(result?.writes) ? result.writes : [];
      const commit = await fetch(`${baseUrl(env)}:commit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ transaction, writes }),
      });
      if (commit.ok) {
        invalidateTransactionWrites(env, writes);
        // Checkout/stock transactions touch both orders and products. Only the
        // order change is a user-visible admin notification; avoiding a second
        // notification write for product stock keeps write amplification low.
        const touchesOrder = writes.some((write) => String(write?.update?.name || write?.delete || "").includes("/documents/orders/"));
        if (touchesOrder) await bumpAdminNotification(env, "orders");
        return result?.value;
      }
      const text = await commit.text();
      const err = new Error(`Firestore COMMIT failed: ${text}`);
      err.status = commit.status;
      // Firestore may return 409 ABORTED when another checkout touches the
      // same product concurrently. Restarting the whole transaction is safe.
      if (commit.status === 409 || /ABORTED|transaction.*abort/i.test(text)) {
        lastError = err;
        continue;
      }
      throw err;
    } catch (e) {
      if (e?.status === 409 || /ABORTED|transaction.*abort/i.test(String(e?.message || ""))) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }

  throw lastError || new Error("Could not complete Firestore transaction");
}

export async function fsDelete(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Firestore DELETE ${path} failed: ${await res.text()}`);
  clearDocumentCache(env, path);
  await bumpAdminNotification(env, splitCollectionPath(path));
}

// Query documents in `collection` where `field` == `value`.
export async function fsQueryEquals(env, collection, field, value, options = {}) {
  const ttl = options.cache === false ? 0 : (options.ttlMs ?? QUERY_TTL_MS[collection] ?? 0);
  const valueKey = JSON.stringify(value);
  const key = cacheKey(projectIdOf(env), "query", `${collection}|${field}|${valueKey}`);
  return cachedRead(key, ttl, async () => {
    const token = await getAccessToken(env);
    const res = await fetch(`${baseUrl(env)}:runQuery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: collection }],
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op: "EQUAL",
              value: toFirestoreValue(value),
            },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`Firestore QUERY ${collection} failed: ${await res.text()}`);
    const rows = await res.json();
    return rows.filter((r) => r.document).map((r) => ({ id: idFromName(r.document.name), updateTime: r.document.updateTime, ...fromFirestoreDoc(r.document) }));
  }, ttl > 0);
}


function buildFieldFilter(field, op, value) {
  return { fieldFilter: { field: { fieldPath: field }, op, value: toFirestoreValue(value) } };
}

function buildWhere(filters) {
  const list = Array.isArray(filters) ? filters.filter(Boolean) : [];
  if (!list.length) return undefined;
  if (list.length === 1) return buildFieldFilter(list[0].field, list[0].op || "EQUAL", list[0].value);
  return { compositeFilter: { op: "AND", filters: list.map((f) => buildFieldFilter(f.field, f.op || "EQUAL", f.value)) } };
}

export async function fsAggregate(env, collection, aggregations, options = {}) {
  const ttl = options.cache === false ? 0 : (options.ttlMs ?? 120_000);
  const key = cacheKey(projectIdOf(env), "aggregate", `${collection}|${JSON.stringify(options.filters || [])}|${JSON.stringify(aggregations)}`);
  return cachedRead(key, ttl, async () => {
    const token = await getAccessToken(env);
    const structuredQuery = { from: [{ collectionId: collection }] };
    const where = buildWhere(options.filters);
    if (where) structuredQuery.where = where;
    const res = await fetch(`${baseUrl(env)}:runAggregationQuery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredAggregationQuery: {
          structuredQuery,
          aggregations: aggregations.map((item) => {
            const op = item.type || "count";
            if (op === "sum" || op === "avg") return { alias: item.alias, [op]: { field: { fieldPath: item.field } } };
            return { alias: item.alias, count: {} };
          }),
        },
      }),
    });
    if (!res.ok) throw new Error(`Firestore AGGREGATE ${collection} failed: ${await res.text()}`);
    const rows = await res.json();
    const result = rows.find((row) => row.result)?.result?.aggregateFields || {};
    const out = {};
    for (const item of aggregations) out[item.alias] = fromFirestoreValue(result[item.alias]);
    return out;
  }, ttl > 0);
}

export async function fsGetAdminNotificationState(env, options = {}) {
  return fsGet(env, "adminNotificationState", { ttlMs: options.ttlMs ?? 30_000 });
}

export async function fsListPage(env, collection, options = {}) {
  const token = await getAccessToken(env);
  const url = new URL(`${baseUrl(env)}/${collection}`);
  url.searchParams.set("pageSize", String(Math.min(100, Math.max(1, Number(options.pageSize || 25)))));
  if (options.pageToken) url.searchParams.set("pageToken", String(options.pageToken));
  if (options.orderBy) url.searchParams.set("orderBy", String(options.orderBy));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Firestore LIST PAGE ${collection} failed: ${await res.text()}`);
  const data = await res.json();
  return {
    items: (data.documents || []).map((doc) => ({ id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) })),
    nextPageToken: data.nextPageToken || null,
  };
}


function encodeCursor(value) { return base64url(JSON.stringify(value)); }
function decodeCursor(value) {
  if (!value) return null;
  try {
    const text = atob(String(value).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(value).length + 3) % 4));
    return JSON.parse(text);
  } catch { return null; }
}

export async function fsQueryPageEquals(env, collection, field, value, options = {}) {
  const token = await getAccessToken(env);
  const limit = Math.min(50, Math.max(1, Number(options.limit || 25)));
  const cursor = decodeCursor(options.cursor);
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toFirestoreValue(value) } },
    orderBy: [
      { field: { fieldPath: options.orderField || "createdAt" }, direction: "DESCENDING" },
      { field: { fieldPath: "__name__" }, direction: "DESCENDING" },
    ],
    limit,
  };
  if (cursor?.createdAt && cursor?.id) {
    structuredQuery.startAt = {
      before: false,
      values: [
        { timestampValue: cursor.createdAt },
        { referenceValue: `${baseUrl(env)}/${collection}/${cursor.id}` },
      ],
    };
  }
  const res = await fetch(`${baseUrl(env)}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`Firestore QUERY PAGE ${collection} failed: ${await res.text()}`);
  const rows = await res.json();
  const items = rows.filter((r) => r.document).map((r) => ({ id: idFromName(r.document.name), updateTime: r.document.updateTime, ...fromFirestoreDoc(r.document) }));
  const last = items[items.length - 1];
  const nextCursor = items.length === limit && last?.createdAt ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
  return { items, nextCursor };
}
