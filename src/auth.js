// Verifies Firebase Auth ID tokens using Google's public certs, entirely with
// Web Crypto — no firebase-admin dependency needed (it doesn't run on Workers).

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let certCache = { certs: null, exp: 0 };

function base64urlToUint8Array(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), "=");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function base64urlToString(b64url) {
  return new TextDecoder().decode(base64urlToUint8Array(b64url));
}

async function getCerts() {
  if (certCache.certs && certCache.exp > Date.now() / 1000) return certCache.certs;
  const res = await fetch(CERTS_URL);
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  const certs = await res.json();
  certCache = { certs, exp: Date.now() / 1000 + maxAge };
  return certs;
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function importCertPublicKey(pem) {
  // Certificates embed the RSA public key inside an X.509 wrapper; the WebCrypto
  // "spki" import understands the DER form directly for the certs Google publishes.
  const der = pemToArrayBuffer(pem);
  return crypto.subtle.importKey("spki", extractSpki(der), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

// Google's securetoken certs are X.509 certificates, not bare SPKI keys, so we
// need to pull the subjectPublicKeyInfo out of the certificate DER structure.
function extractSpki(certDer) {
  // Minimal DER walker: certificate -> tbsCertificate -> subjectPublicKeyInfo.
  const bytes = new Uint8Array(certDer);
  let offset = 0;
  function readLength() {
    let len = bytes[offset++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | bytes[offset++];
    }
    return len;
  }
  function readTag() {
    const tag = bytes[offset++];
    const len = readLength();
    return { tag, len, start: offset };
  }
  const seq = readTag(); // Certificate SEQUENCE
  offset = seq.start;
  const tbs = readTag(); // tbsCertificate SEQUENCE
  const tbsEnd = tbs.start + tbs.len;
  offset = tbs.start;
  // version [0] EXPLICIT (optional)
  if (bytes[offset] === 0xa0) {
    const v = readTag();
    offset = v.start + v.len;
  }
  // serialNumber INTEGER
  { const t = readTag(); offset = t.start + t.len; }
  // signature AlgorithmIdentifier SEQUENCE
  { const t = readTag(); offset = t.start + t.len; }
  // issuer Name SEQUENCE
  { const t = readTag(); offset = t.start + t.len; }
  // validity SEQUENCE
  { const t = readTag(); offset = t.start + t.len; }
  // subject Name SEQUENCE
  { const t = readTag(); offset = t.start + t.len; }
  // subjectPublicKeyInfo SEQUENCE -- this is what we want, whole TLV
  const spkiStart = offset;
  const spki = readTag();
  const spkiEnd = spki.start + spki.len;
  return bytes.slice(spkiStart, spkiEnd).buffer;
}

/**
 * Verifies a Firebase ID token. Returns the decoded payload (uid, email, admin
 * custom claim, etc.) or throws if invalid/expired.
 */
export async function verifyIdToken(idToken, projectId) {
  if (!projectId || projectId === "your-firebase-project-id") {
    throw new Error(
      'FIREBASE_PROJECT_ID is not set in wrangler.toml (still the placeholder). Set it under [vars] to your real Firebase project ID and restart `wrangler dev`.'
    );
  }
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(base64urlToString(headerB64));
  const payload = JSON.parse(base64urlToString(payloadB64));

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("Token expired");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Bad issuer");
  if (payload.aud !== projectId) throw new Error("Bad audience");
  if (!payload.sub) throw new Error("Missing subject");

  const certs = await getCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error("Unknown signing key");
  const key = await importCertPublicKey(pem);

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = base64urlToUint8Array(sigB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!valid) throw new Error("Bad signature");

  return { uid: payload.sub, email: payload.email, name: payload.name, admin: payload.admin === true, ...payload };
}

export async function requireAuth(c, next) {
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return c.json({ error: "Missing Authorization bearer token" }, 401);
  try {
    const user = await verifyIdToken(token, c.env.FIREBASE_PROJECT_ID);
    const adminRecord = await ensureLegacyAdminRecord(c.env, user);
    const activeAdmin = adminRecord && !["suspended","deleted","inactive"].includes(adminRecord.status || "active");
    c.set("user", { ...user, admin: !!user.admin || !!activeAdmin, adminRecord: activeAdmin ? adminRecord : null });
    await next();
  } catch (e) {
    return c.json({ error: "Invalid or expired token", detail: String(e.message || e) }, 401);
  }
}

async function getAdminRecord(env, uid) {
  try {
    const { fsGet } = await import("./firestore.js");
    return await fsGet(env, `adminUsers/${uid}`);
  } catch {
    return null;
  }
}

const ALL_ADMIN_PERMISSIONS = [
  "viewDashboard",
  "manageProducts",
  "manageCategories",
  "manageOrders",
  "manageMessages",
  "managePayments",
  "manageHomepage",
  "manageAdmins",
  "viewAuditLogs",
  "manageSettings",
  "manageCirculation",
  "manageMembership",
  "manageContact",
];

const ROLE_DEFAULT_PERMISSIONS = {
  Admin: new Set(ALL_ADMIN_PERMISSIONS),
  Moderator: new Set(["viewDashboard","manageProducts","manageCategories","manageOrders","manageMessages","managePayments","manageHomepage","manageCirculation","manageMembership","manageContact"]),
  Seller: new Set(["viewDashboard","manageProducts","manageOrders"]),
};

async function ensureLegacyAdminRecord(env, user) {
  if (!user?.admin || !user?.uid) return null;
  const existing = await getAdminRecord(env, user.uid);
  if (existing) return existing;
  try {
    const { fsCreate } = await import("./firestore.js");
    const permissions = Object.fromEntries(ALL_ADMIN_PERMISSIONS.map((p) => [p, true]));
    return await fsCreate(env, "adminUsers", {
      name: user.name || user.email || "ArtCanvas Admin",
      email: user.email || "",
      role: "Admin",
      status: "active",
      permissions,
      createdAt: new Date().toISOString(),
      createdBy: "firebase-custom-claim",
    }, user.uid);
  } catch {
    return {
      id: user.uid,
      name: user.name || user.email || "ArtCanvas Admin",
      email: user.email || "",
      role: "Admin",
      status: "active",
      permissions: Object.fromEntries(ALL_ADMIN_PERMISSIONS.map((p) => [p, true])),
    };
  }
}

function permissionAllowed(adminRecord, permission) {
  if (!adminRecord) return false;
  if (adminRecord.role === "Admin") return true;
  if (adminRecord.permissions && typeof adminRecord.permissions[permission] === "boolean") return adminRecord.permissions[permission];
  return ROLE_DEFAULT_PERMISSIONS[adminRecord.role]?.has(permission) === true;
}

export async function requireAdmin(c, next) {
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return c.json({ error: "Missing Authorization bearer token" }, 401);
  try {
    const user = await verifyIdToken(token, c.env.FIREBASE_PROJECT_ID);
    const adminRecord = await ensureLegacyAdminRecord(c.env, user);
    const active = adminRecord && !["suspended","deleted","inactive"].includes(adminRecord.status || "active");
    if (!user.admin && !active) return c.json({ error: "Admin access required" }, 403);
    c.set("user", { ...user, admin: true, adminRecord });
    await next();
  } catch (e) {
    return c.json({ error: "Invalid or expired token", detail: String(e.message || e) }, 401);
  }
}

export function requireAdminPermission(permission) {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return c.json({ error: "Missing Authorization bearer token" }, 401);
    try {
      const user = await verifyIdToken(token, c.env.FIREBASE_PROJECT_ID);
      const adminRecord = await ensureLegacyAdminRecord(c.env, user);
      const active = adminRecord && !["suspended","deleted","inactive"].includes(adminRecord.status || "active");
      if (!active) {
        // A custom-claim admin without a profile is migrated by
        // ensureLegacyAdminRecord(). If a profile exists but is suspended,
        // the profile status is authoritative and access must stop.
        return c.json({ error: "Admin access required" }, 403);
      }
      // Owner-level Firebase custom-claim admins keep full access for backward
      // compatibility. Once a role/permission profile exists, its restrictions
      // are respected unless the profile itself is the Admin role.
      if (!user.admin && !permissionAllowed(adminRecord, permission)) {
        return c.json({ error: `Permission denied: ${permission}` }, 403);
      }
      if (user.admin && adminRecord.role !== "Admin" && !permissionAllowed(adminRecord, permission)) {
        return c.json({ error: `Permission denied: ${permission}` }, 403);
      }
      c.set("user", { ...user, admin: true, adminRecord });
      await next();
    } catch (e) {
      return c.json({ error: "Invalid or expired token", detail: String(e.message || e) }, 401);
    }
  };
}

export function requireAdminAnyPermission(permissions) {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return c.json({ error: "Missing Authorization bearer token" }, 401);
    try {
      const user = await verifyIdToken(token, c.env.FIREBASE_PROJECT_ID);
      const adminRecord = await ensureLegacyAdminRecord(c.env, user);
      const active = adminRecord && !["suspended","deleted","inactive"].includes(adminRecord.status || "active");
      if (!active) return c.json({ error: "Admin access required" }, 403);
      if (adminRecord.role !== "Admin" && !user.admin && !permissions.some((p) => permissionAllowed(adminRecord, p))) return c.json({ error: "Permission denied" }, 403);
      if (adminRecord.role !== "Admin" && user.admin && !permissions.some((p) => permissionAllowed(adminRecord, p))) return c.json({ error: "Permission denied" }, 403);
      c.set("user", { ...user, admin: true, adminRecord });
      await next();
    } catch (e) {
      return c.json({ error: "Invalid or expired token", detail: String(e.message || e) }, 401);
    }
  };
}
