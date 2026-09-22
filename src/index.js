import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireAuth, requireAdmin, requireAdminPermission, requireAdminAnyPermission } from "./auth.js";
import { fsGet, fsList, fsCreate, fsPatch, fsDelete, fsQueryEquals, fsRunTransaction, fsAggregate, fsGetAdminNotificationState, fsListPage, fsQueryPageEquals } from "./firestore.js";
import { buildCloudinarySignature } from "./cloudinary.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
      // Always allow the two local frontend apps during development. This keeps
      // local Admin/Client working even when .dev.vars only contains production origins.
      const localOrigins = new Set([
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
      ]);
      if (localOrigins.has(origin)) return origin;
      if (allowed.length === 0) return origin; // dev fallback: reflect origin
      return allowed.includes(origin) ? origin : undefined;
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/", (c) => {
  const configured = {
    FIREBASE_PROJECT_ID: !!c.env.FIREBASE_PROJECT_ID && c.env.FIREBASE_PROJECT_ID !== "your-firebase-project-id",
    FIREBASE_CLIENT_EMAIL: !!c.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: !!c.env.FIREBASE_PRIVATE_KEY,
    CLOUDINARY_CLOUD_NAME: !!c.env.CLOUDINARY_CLOUD_NAME && c.env.CLOUDINARY_CLOUD_NAME !== "your-cloudinary-cloud-name",
    CLOUDINARY_API_KEY: !!c.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: !!c.env.CLOUDINARY_API_SECRET,
  };
  const allSet = Object.values(configured).every(Boolean);
  return c.json({
    ok: true,
    service: "art-canvas-backend",
    configured,
    note: allSet ? "All required config detected." : "Some config is missing — see README.md (.dev.vars for local dev, `wrangler secret put` for production).",
  });
});

// Public newsletter subscription. Stores subscribers in Firestore so the footer
// studio-letter form works in both local Wrangler and production deployments.
app.post("/api/newsletter", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Please enter a valid email address." }, 400);
  }

  // Use a deterministic document id so repeated subscriptions are idempotent
  // and do not create duplicate subscriber records.
  const docId = encodeURIComponent(email);
  const existing = await fsGet(c.env, `newsletter/${docId}`);
  if (existing) {
    return c.json({ ok: true, subscribed: true, alreadySubscribed: true });
  }

  await fsCreate(c.env, "newsletter", {
    email,
    createdAt: new Date().toISOString(),
    source: "studio-letter",
  }, docId);

  return c.json({ ok: true, subscribed: true, alreadySubscribed: false }, 201);
});

// ---------- helpers ----------

function isActiveDateWindow(enabled, startAt, endAt, now = new Date()) {
  if (enabled !== true) return false;
  const start = startAt ? Date.parse(startAt) : NaN;
  const end = endAt ? Date.parse(endAt) : NaN;
  if (Number.isFinite(start) && now.getTime() < start) return false;
  if (Number.isFinite(end) && now.getTime() > end) return false;
  return true;
}

function getProductPricing(p, now = new Date()) {
  const originalPrice = Number.isFinite(Number(p?.originalPrice))
    ? Math.max(0, Number(p.originalPrice))
    : Math.max(0, Number(p?.price) || 0);
  const offerPrice = Number.isFinite(Number(p?.offerPrice))
    ? Math.max(0, Number(p.offerPrice))
    : null;
  const offerActive =
    p?.offerEnabled === true &&
    offerPrice !== null &&
    offerPrice < originalPrice &&
    isActiveDateWindow(true, p?.offerStartAt, p?.offerEndAt, now);
  return {
    originalPrice,
    offerPrice,
    offerEnabled: p?.offerEnabled === true,
    offerActive,
    price: offerActive ? offerPrice : originalPrice,
  };
}

function publicProduct(p) {
  const { stock, ...rest } = p;
  const productCode = p.productCode || `AC-${String(p.id || "PRODUCT").slice(-8).toUpperCase()}`;
  const pricing = getProductPricing(p);
  return {
    ...rest,
    ...pricing,
    productCode,
    inStock: (stock ?? 0) > 0,
    sold: Number.isFinite(p.sold) ? p.sold : 0,
  };
}

function isValidProductInput(body) {
  return body && typeof body.name === "string" && body.name.trim().length > 0 && typeof body.price === "number" && body.price >= 0;
}

function normalizeProductSizes(body) {
  const raw = Array.isArray(body?.sizes) ? body.sizes : [];
  return raw.map((item) => ({
    size: String(item?.size || "").trim().slice(0, 20),
    stock: Math.max(0, Math.floor(Number(item?.stock) || 0)),
  })).filter((item) => item.size).slice(0, 20);
}

function totalSizeStock(sizes) {
  return Array.isArray(sizes) && sizes.length ? sizes.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item?.stock) || 0)), 0) : null;
}

function normalizeProductImages(body) {
  const raw = Array.isArray(body?.images) ? body.images : [];
  const urls = raw
    .map((item) => typeof item === "string" ? item : item?.url)
    .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url));
  if (typeof body?.image === "string" && body.image && !urls.includes(body.image)) urls.unshift(body.image);
  return urls.slice(0, 8);
}

const PRODUCT_FIELDS = ["name", "description", "price", "originalPrice", "offerEnabled", "offerPrice", "offerStartAt", "offerEndAt", "category", "gender", "subcategory", "stock", "sizes", "image", "imagePublicId", "images", "rating", "reviews", "seed", "isFeatured", "sold", "productCode"];

// The five categories the store ships with. They always appear in
// GET /api/categories and can't be deleted — admins can only add to this
// list or remove the custom ones they created.
const BUILTIN_CATEGORIES = [
  { id: "clothing", name: "Clothing" },
  { id: "art", name: "Art" },
  { id: "objects", name: "Objects" },
  { id: "accessories", name: "Accessories" },
  { id: "gifts", name: "Gifts" },
];
const BUILTIN_CATEGORY_IDS = new Set(BUILTIN_CATEGORIES.map((c) => c.id));

async function getCategorySettings(env) {
  const doc = await fsGet(env, "categories/_settings");
  return { renamed: doc?.renamed || {}, hidden: Array.isArray(doc?.hidden) ? doc.hidden : [] };
}

// Clothing's built-in Women/Men/Kids sub-categories. Same deal as
// categories: these always show up and can't be deleted, admins can add
// more or remove the ones they added.
const BUILTIN_SUBCATEGORIES = {
  women: ["Dresses", "Outerwear", "Tops"],
  men: ["Shirts", "Outerwear", "Trousers"],
  kids: ["Tees", "Outerwear", "Sets"],
};
const SUBCATEGORY_GENDERS = new Set(Object.keys(BUILTIN_SUBCATEGORIES));

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function cleanAddress(a) {
  if (!a || typeof a !== "object") return null;
  const pick = (k) => (typeof a[k] === "string" ? a[k].trim().slice(0, 200) : "");
  const out = {
    fullName: pick("fullName"),
    phone: pick("phone"),
    line1: pick("line1"),
    line2: pick("line2"),
    city: pick("city"),
    state: pick("state"),
    zip: pick("zip"),
    country: pick("country"),
    deliveryZone: ["inside_dhaka", "outside_dhaka"].includes(a.deliveryZone) ? a.deliveryZone : "",
  };
  return Object.values(out).some(Boolean) ? out : null;
}

// ---------- products: public ----------

app.get("/api/products", async (c) => {
  const products = await fsList(c.env, "products");
  return c.json(products.map(publicProduct));
});

app.get("/api/products/:id", async (c) => {
  const p = await fsGet(c.env, `products/${c.req.param("id")}`);
  if (!p) return c.json({ error: "Not found" }, 404);
  return c.json(publicProduct(p));
});

// ---------- products: admin ----------

app.get("/api/admin/products", requireAdminPermission("manageProducts"), async (c) => {
  const products = await fsList(c.env, "products");
  return c.json(products);
});

app.post("/api/admin/products", requireAdminPermission("manageProducts"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isValidProductInput(body)) return c.json({ error: "name and price are required" }, 400);
  const originalPrice = Number.isFinite(Number(body.originalPrice)) ? Math.max(0, Number(body.originalPrice)) : Number(body.price);
  const rawOfferPrice = Number(body.offerPrice);
  const offerPrice = body.offerPrice === null || body.offerPrice === undefined || body.offerPrice === "" || !Number.isFinite(rawOfferPrice)
    ? null
    : Math.max(0, rawOfferPrice);
  if (body.offerEnabled === true && (!Number.isFinite(offerPrice) || offerPrice >= originalPrice)) {
    return c.json({ error: "Offer price must be lower than the original price." }, 400);
  }
  if (body.offerEnabled === true && body.offerStartAt && body.offerEndAt) {
    const start = Date.parse(body.offerStartAt);
    const end = Date.parse(body.offerEndAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
      return c.json({ error: "Offer end date/time must be after the start date/time." }, 400);
    }
  }

  const product = {
    name: body.name.trim(),
    description: body.description || "",
    price: Number(body.price),
    originalPrice,
    offerEnabled: body.offerEnabled === true,
    offerPrice,
    offerStartAt: typeof body.offerStartAt === "string" ? body.offerStartAt.trim().slice(0, 40) : "",
    offerEndAt: typeof body.offerEndAt === "string" ? body.offerEndAt.trim().slice(0, 40) : "",
    category: body.category || "objects",
    gender: body.gender || "all",
    subcategory: body.subcategory || "",
    stock: totalSizeStock(normalizeProductSizes(body)) ?? (Number.isFinite(body.stock) ? Math.max(0, Math.floor(body.stock)) : 0),
    sizes: normalizeProductSizes(body),
    image: body.image || normalizeProductImages(body)[0] || "",
    imagePublicId: body.imagePublicId || "",
    images: normalizeProductImages(body),
    rating: Number.isFinite(body.rating) ? body.rating : 4.8,
    reviews: Number.isFinite(body.reviews) ? body.reviews : 0,
    isFeatured: body.isFeatured === true,
    sold: 0,
    productCode: body.productCode || `AC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,
    seed: body.seed || `ac-clothing-${Math.floor(Math.random() * 6)}`,
    createdAt: new Date().toISOString(),
  };
  const created = await fsCreate(c.env, "products", product);
  return c.json(created, 201);
});

app.patch("/api/admin/products/:id", requireAdminPermission("manageProducts"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);

  const update = {};
  for (const key of PRODUCT_FIELDS) {
    if (key in body) update[key] = body[key];
  }
  if (update.sizes !== undefined) {
    update.sizes = normalizeProductSizes(update);
    update.stock = totalSizeStock(update.sizes) ?? Math.max(0, Math.floor(Number(update.stock) || 0));
  } else if (update.stock !== undefined) update.stock = Math.max(0, Math.floor(Number(update.stock) || 0));
  if (update.productCode !== undefined) update.productCode = String(update.productCode || "").trim().slice(0, 80);
  if (update.price !== undefined) update.price = Math.max(0, Number(update.price) || 0);
  if (update.originalPrice !== undefined) update.originalPrice = Math.max(0, Number(update.originalPrice) || 0);
  if (update.offerEnabled !== undefined) update.offerEnabled = update.offerEnabled === true;
  if (update.offerPrice !== undefined) update.offerPrice = update.offerPrice === null || update.offerPrice === "" ? null : Math.max(0, Number(update.offerPrice) || 0);
  if (update.offerStartAt !== undefined) update.offerStartAt = String(update.offerStartAt || "").trim().slice(0, 40);
  if (update.offerEndAt !== undefined) update.offerEndAt = String(update.offerEndAt || "").trim().slice(0, 40);
  if (update.offerEnabled === true) {
    const basePrice = Number.isFinite(Number(update.originalPrice)) ? Number(update.originalPrice) : Number(update.price);
    const salePrice = Number(update.offerPrice);
    if (!Number.isFinite(salePrice) || salePrice < 0 || !Number.isFinite(basePrice) || salePrice >= basePrice) {
      return c.json({ error: "Offer price must be lower than the original price." }, 400);
    }
    if (update.offerStartAt && update.offerEndAt) {
      const start = Date.parse(update.offerStartAt);
      const end = Date.parse(update.offerEndAt);
      if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
        return c.json({ error: "Offer end date/time must be after the start date/time." }, 400);
      }
    }
  }
  if (update.isFeatured !== undefined) update.isFeatured = update.isFeatured === true;
  if (update.images !== undefined) {
    const normalized = normalizeProductImages(update);
    update.images = normalized;
    if (normalized.length && !update.image) update.image = normalized[0];
  }
  if (body.productCode === undefined || !String(body.productCode || "").trim()) { const current = await fsGet(c.env, `products/${id}`); if (current && !current.productCode) update.productCode = `AC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`; else if (body.productCode !== undefined && !String(body.productCode || "").trim()) update.productCode = current?.productCode || `AC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`; }
  if (Object.keys(update).length === 0) return c.json({ error: "No valid fields to update" }, 400);

  try {
    const updated = await fsPatch(c.env, `products/${id}`, update);
    return c.json(updated);
  } catch (e) {
    return c.json({ error: "Update failed", detail: String(e.message || e) }, 400);
  }
});

app.delete("/api/admin/products/:id", requireAdminPermission("manageProducts"), async (c) => {
  await fsDelete(c.env, `products/${c.req.param("id")}`);
  return c.json({ ok: true });
});

// ---------- categories ----------

app.get("/api/categories", async (c) => {
  const custom = await fsList(c.env, "categories");
  const settings = await getCategorySettings(c.env);
  const hidden = new Set(settings.hidden);
  const builtins = BUILTIN_CATEGORIES
    .filter((cat) => !hidden.has(cat.id))
    .map((cat) => ({ ...cat, name: settings.renamed?.[cat.id] || cat.name, builtin: true }));
  const all = [...builtins, ...custom.filter((cat) => cat.id !== "_settings").map((cat) => ({ id: cat.id, name: cat.name, builtin: false }))];
  return c.json(all);
});

app.get("/api/admin/categories", requireAdminPermission("manageCategories"), async (c) => {
  const custom = await fsList(c.env, "categories");
  const settings = await getCategorySettings(c.env);
  const hidden = new Set(settings.hidden);
  const builtins = BUILTIN_CATEGORIES.map((cat) => ({
    ...cat,
    name: settings.renamed?.[cat.id] || cat.name,
    originalName: cat.name,
    builtin: true,
    hidden: hidden.has(cat.id),
  }));
  const customs = custom
    .filter((cat) => cat.id !== "_settings")
    .map((cat) => ({ id: cat.id, name: cat.name, builtin: false, hidden: false }));
  return c.json([...builtins, ...customs]);
});

app.patch("/api/admin/categories/:id", requireAdminPermission("manageCategories"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "Category name is required" }, 400);
  if (BUILTIN_CATEGORY_IDS.has(id)) {
    const settings = await getCategorySettings(c.env);
    const renamed = { ...settings.renamed, [id]: name };
    const saved = await fsGet(c.env, "categories/_settings");
    const payload = { renamed, hidden: settings.hidden };
    if (saved) await fsPatch(c.env, "categories/_settings", payload);
    else await fsCreate(c.env, "categories", payload, "_settings");
    return c.json({ id, name, builtin: true });
  }
  const existing = await fsGet(c.env, `categories/${id}`);
  if (!existing) return c.json({ error: "Category not found" }, 404);
  const duplicate = (await fsList(c.env, "categories")).some((x) => x.id !== id && x.id !== "_settings" && String(x.name).toLowerCase() === name.toLowerCase());
  if (duplicate) return c.json({ error: `A category named "${name}" already exists` }, 409);
  return c.json(await fsPatch(c.env, `categories/${id}`, { name }));
});

app.post("/api/admin/categories", requireAdminPermission("manageCategories"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "Category name is required" }, 400);

  const id = slugify(name);
  if (!id) return c.json({ error: "Please use a name with at least one letter or number" }, 400);
  if (BUILTIN_CATEGORY_IDS.has(id)) {
    const settings = await getCategorySettings(c.env);
    const hidden = settings.hidden.filter((x) => x !== id);
    const renamed = { ...settings.renamed };
    delete renamed[id];
    const saved = await fsGet(c.env, "categories/_settings");
    const payload = { renamed, hidden };
    if (saved) await fsPatch(c.env, "categories/_settings", payload);
    else await fsCreate(c.env, "categories", payload, "_settings");
    return c.json({ id, name: BUILTIN_CATEGORIES.find((x) => x.id === id)?.name || name, builtin: true, restored: true });
  }

  const existing = await fsGet(c.env, `categories/${id}`);
  if (existing) return c.json({ error: `A category named "${existing.name}" already exists` }, 409);

  const created = await fsCreate(c.env, "categories", { name, createdAt: new Date().toISOString() }, id);
  return c.json({ id: created.id, name: created.name, builtin: false }, 201);
});

app.delete("/api/admin/categories/:id", requireAdminPermission("manageCategories"), async (c) => {
  const id = c.req.param("id");
  const products = await fsQueryEquals(c.env, "products", "category", id);
  const inUse = products.length;
  if (inUse > 0) return c.json({ error: `${inUse} product${inUse === 1 ? "" : "s"} still use this category. Move or delete ${inUse === 1 ? "it" : "them"} first.` }, 409);

  if (BUILTIN_CATEGORY_IDS.has(id)) {
    const settings = await getCategorySettings(c.env);
    const hidden = Array.from(new Set([...settings.hidden, id]));
    const payload = { renamed: settings.renamed, hidden };
    const saved = await fsGet(c.env, "categories/_settings");
    if (saved) await fsPatch(c.env, "categories/_settings", payload);
    else await fsCreate(c.env, "categories", payload, "_settings");
    return c.json({ ok: true });
  }
  const existing = await fsGet(c.env, `categories/${id}`);
  if (!existing) return c.json({ error: "Category not found" }, 404);
  await fsDelete(c.env, `categories/${id}`);
  return c.json({ ok: true });
});

// ---------- clothing sub-categories (Women / Men / Kids) ----------

app.get("/api/subcategories", async (c) => {
  const custom = await fsList(c.env, "subcategories");
  const byGender = Object.fromEntries(custom.map((d) => [d.id, d]));
  const result = {};
  for (const gender of Object.keys(BUILTIN_SUBCATEGORIES)) {
    const doc = byGender[gender] || {};
    const hidden = new Set(Array.isArray(doc.hidden) ? doc.hidden : []);
    const renamed = doc.renamed || {};
    result[gender] = [
      ...BUILTIN_SUBCATEGORIES[gender]
        .filter((name) => !hidden.has(name))
        .map((name) => ({ name: renamed[name] || name, originalName: name, builtin: true })),
      ...(doc.items || []).map((name) => ({ name, originalName: name, builtin: false })),
    ];
  }
  return c.json(result);
});

app.get("/api/admin/subcategories", requireAdminPermission("manageCategories"), async (c) => {
  const custom = await fsList(c.env, "subcategories");
  const byGender = Object.fromEntries(custom.map((d) => [d.id, d]));
  const result = {};
  for (const gender of Object.keys(BUILTIN_SUBCATEGORIES)) {
    const doc = byGender[gender] || {};
    const hidden = new Set(Array.isArray(doc.hidden) ? doc.hidden : []);
    const renamed = doc.renamed || {};
    result[gender] = [
      ...BUILTIN_SUBCATEGORIES[gender].map((originalName) => ({
        name: renamed[originalName] || originalName,
        originalName,
        builtin: true,
        hidden: hidden.has(originalName),
      })),
      ...(doc.items || []).map((name) => ({ name, originalName: name, builtin: false, hidden: false })),
    ];
  }
  return c.json(result);
});

app.post("/api/admin/subcategories", requireAdminPermission("manageCategories"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const gender = body?.gender;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!SUBCATEGORY_GENDERS.has(gender)) return c.json({ error: "gender must be one of women, men, kids" }, 400);
  if (!name) return c.json({ error: "Sub-category name is required" }, 400);

  const doc = await fsGet(c.env, `subcategories/${gender}`) || { items: [], renamed: {}, hidden: [] };
  const builtinOriginal = BUILTIN_SUBCATEGORIES[gender].find((n) => n.toLowerCase() === name.toLowerCase());
  if (builtinOriginal) {
    const hidden = (doc.hidden || []).filter((x) => x !== builtinOriginal);
    const renamed = { ...(doc.renamed || {}) };
    delete renamed[builtinOriginal];
    await fsPatch(c.env, `subcategories/${gender}`, { items: doc.items || [], renamed, hidden });
    return c.json({ gender, name: builtinOriginal, builtin: true, restored: true }, 200);
  }
  const existingNames = [...BUILTIN_SUBCATEGORIES[gender]];
  const items = doc.items || [];
  existingNames.push(...items);
  if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: `"${name}" already exists under ${gender}` }, 409);
  }

  const nextItems = [...items, name];
  const saved = doc ? await fsPatch(c.env, `subcategories/${gender}`, { items: nextItems }) : await fsCreate(c.env, "subcategories", { items: nextItems }, gender);
  return c.json({ gender, items: saved.items }, 201);
});

app.patch("/api/admin/subcategories", requireAdminPermission("manageCategories"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const gender = body?.gender;
  const oldName = typeof body?.oldName === "string" ? body.oldName.trim() : "";
  const newName = typeof body?.name === "string" ? body.name.trim() : "";
  if (!SUBCATEGORY_GENDERS.has(gender)) return c.json({ error: "gender must be one of women, men, kids" }, 400);
  if (!oldName || !newName) return c.json({ error: "Both oldName and name are required" }, 400);
  const doc = await fsGet(c.env, `subcategories/${gender}`) || { items: [], renamed: {}, hidden: [] };
  const builtIn = BUILTIN_SUBCATEGORIES[gender].find((n) => n.toLowerCase() === oldName.toLowerCase());
  const customName = (doc.items || []).find((n) => n.toLowerCase() === oldName.toLowerCase());
  if (!builtIn && !customName) return c.json({ error: "Sub-category not found" }, 404);
  const currentNames = [
    ...BUILTIN_SUBCATEGORIES[gender].filter((n) => n.toLowerCase() !== oldName.toLowerCase()).map((n) => doc.renamed?.[n] || n),
    ...(doc.items || []).filter((n) => n.toLowerCase() !== oldName.toLowerCase()),
  ];
  if (currentNames.some((n) => n.toLowerCase() === newName.toLowerCase())) return c.json({ error: `"${newName}" already exists under ${gender}` }, 409);
  const products = await fsQueryEquals(c.env, "products", "category", "clothing");
  const sourceName = builtIn || customName;
  const affected = products.filter((p) => p.gender === gender && p.subcategory === sourceName);
  if (builtIn) {
    const renamed = { ...(doc.renamed || {}), [builtIn]: newName };
    for (const product of affected) {
      await fsPatch(c.env, `products/${product.id}`, { subcategory: newName });
    }
    const payload = { items: doc.items || [], renamed, hidden: doc.hidden || [] };
    const saved = await fsGet(c.env, `subcategories/${gender}`)
      ? await fsPatch(c.env, `subcategories/${gender}`, payload)
      : await fsCreate(c.env, "subcategories", payload, gender);
    return c.json({ gender, name: newName, builtin: true, saved });
  }
  const items = (doc.items || []).map((n) => n.toLowerCase() === oldName.toLowerCase() ? newName : n);
  for (const product of affected) {
    await fsPatch(c.env, `products/${product.id}`, { subcategory: newName });
  }
  const saved = await fsPatch(c.env, `subcategories/${gender}`, { items, renamed: doc.renamed || {}, hidden: doc.hidden || [] });
  return c.json({ gender, name: newName, builtin: false, saved });
});

app.delete("/api/admin/subcategories", requireAdminPermission("manageCategories"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const gender = body?.gender;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!SUBCATEGORY_GENDERS.has(gender)) return c.json({ error: "gender must be one of women, men, kids" }, 400);
  if (!name) return c.json({ error: "Sub-category name is required" }, 400);

  const doc = await fsGet(c.env, `subcategories/${gender}`) || { items: [], renamed: {}, hidden: [] };
  const builtInOriginal = BUILTIN_SUBCATEGORIES[gender].find((n) => (doc.renamed?.[n] || n).toLowerCase() === name.toLowerCase());
  const customOriginal = (doc.items || []).find((n) => n.toLowerCase() === name.toLowerCase());
  if (!builtInOriginal && !customOriginal) return c.json({ error: "Sub-category not found" }, 404);

  const products = await fsQueryEquals(c.env, "products", "category", "clothing");
  const inUse = products.filter((p) => p.gender === gender && (p.subcategory === name || p.subcategory === builtInOriginal)).length;
  if (inUse > 0) return c.json({ error: `${inUse} product${inUse === 1 ? "" : "s"} still use this sub-category. Move or update ${inUse === 1 ? "it" : "them"} first.` }, 409);

  if (builtInOriginal) {
    const hidden = Array.from(new Set([...(doc.hidden || []), builtInOriginal]));
    const payload = { items: doc.items || [], renamed: doc.renamed || {}, hidden };
    const existingDoc = await fsGet(c.env, `subcategories/${gender}`);
    if (existingDoc) await fsPatch(c.env, `subcategories/${gender}`, payload);
    else await fsCreate(c.env, "subcategories", payload, gender);
  } else {
    const items = (doc.items || []).filter((n) => n.toLowerCase() !== customOriginal.toLowerCase());
    await fsPatch(c.env, `subcategories/${gender}`, { items, renamed: doc.renamed || {}, hidden: doc.hidden || [] });
  }
  return c.json({ ok: true });
});

// ---------- cloudinary signed uploads ----------
// Product photos & the homepage hero image are admin-only. Profile photos can
// be uploaded by any signed-in user, but only into their own folder.

app.post("/api/admin/cloudinary-signature", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const context = body?.context === "site" ? "site" : "product";
  const baseFolder = c.env.CLOUDINARY_FOLDER || "artcanvas/products";
  const folder = context === "site" ? baseFolder.replace(/\/products$/, "") + "/site" : baseFolder;
  const sig = await buildCloudinarySignature(c.env, folder);
  return c.json(sig);
});

app.post("/api/cloudinary-signature", requireAuth, async (c) => {
  const user = c.get("user");
  const baseFolder = (c.env.CLOUDINARY_FOLDER || "artcanvas/products").replace(/\/products$/, "");
  const folder = `${baseFolder}/profiles/${user.uid}`;
  const sig = await buildCloudinarySignature(c.env, folder);
  return c.json(sig);
});

// ---------- site content (admin-controlled homepage) ----------

const SITE_CONTENT_DEFAULTS = {
  heroImage: "", manifestoImage: "", heroHeadline: "", heroTagline: "", heroTopLeft: "ARTCANVAS / NEW SEASON", heroTopRight: "DROP 04 — 2026",
  heroCtaLabel: "Explore the collection", heroCtaLink: "/shop?category=clothing", heroCtaNote: "Designed in small runs.\nMade to be kept.",
  heroBottomLeft: "01", heroBottomRight: "EST. 2026", filmTitle: "Clothing in motion.", filmDescription: "A moving study of fabric, proportion and everyday gesture.", filmVideoUrl: "",
  showWhatsNew: true, showFilm: true, showManifesto: true, showAnnouncement: false, announcementText: "", featuredTitle: "Currently interesting.", featuredDescription: "", whatsNewTitle: "What’s new.", whatsNewDescription: "Fresh pieces, new proportions and objects worth noticing."
};

app.get("/api/site-content", async (c) => {
  const doc = await fsGet(c.env, "siteContent/home");
  return c.json({ ...SITE_CONTENT_DEFAULTS, ...(doc || {}) });
});

app.patch("/api/admin/site-content", requireAdminPermission("manageHomepage"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);
  const update = {};
  const strings = ["heroImage","manifestoImage","heroHeadline","heroTagline","heroTopLeft","heroTopRight","heroCtaLabel","heroCtaLink","heroCtaNote","heroBottomLeft","heroBottomRight","filmTitle","filmDescription","filmVideoUrl","announcementText","featuredTitle","featuredDescription","whatsNewTitle","whatsNewDescription"];
  for (const key of strings) if (key in body) update[key] = String(body[key] || "").slice(0, 2000);
  for (const key of ["showWhatsNew","showFilm","showManifesto","showAnnouncement"]) if (key in body) update[key] = body[key] === true;
  const existing = await fsGet(c.env, "siteContent/home");
  const saved = existing ? await fsPatch(c.env, "siteContent/home", update) : await fsCreate(c.env, "siteContent", update, "home");
  return c.json({ ...SITE_CONTENT_DEFAULTS, ...saved });
});

// ---------- user profile ----------

function publicUser(claims, profile) {
  return {
    uid: claims.uid,
    email: claims.email,
    admin: !!claims.admin || !!claims.adminRecord,
    role: claims.adminRecord?.role || null,
    permissions: claims.adminRecord?.permissions || null,
    status: claims.adminRecord?.status || null,
    createdAt: claims.adminRecord?.createdAt || null,
    updatedAt: claims.adminRecord?.updatedAt || null,
    lastLogin: claims.adminRecord?.lastLogin || null,
    name: profile?.name || claims.adminRecord?.name || claims.name || "",
    phone: profile?.phone || claims.adminRecord?.phone || "",
    photoURL: profile?.photoURL || claims.adminRecord?.avatar || "",
    address: profile?.address || null,
  };
}

const meProfileCache = new Map();

app.get("/api/me", requireAuth, async (c) => {
  const user = c.get("user");
  const cacheKey = user.uid;
  const cached = meProfileCache.get(cacheKey);
  let profile = cached && cached.expiresAt > Date.now() ? cached.profile : null;
  if (!profile) profile = await fsGet(c.env, `users/${user.uid}`);
  // Make sure a profile doc always exists once someone has signed in, so the
  // admin can find this person by email in the Messages tab even before they
  // ever touch the Account page.
  if (!profile) {
    profile = await fsCreate(c.env, "users", { email: user.email || "", name: user.name || "" }, user.uid);
  } else if (user.email && profile.email !== user.email) {
    profile = await fsPatch(c.env, `users/${user.uid}`, { email: user.email });
  }
  meProfileCache.set(cacheKey, { profile, expiresAt: Date.now() + 60000 });
  return c.json(publicUser(user, profile));
});

app.patch("/api/me", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);

  const update = {};
  if (typeof body.name === "string") update.name = body.name.trim().slice(0, 120);
  if (typeof body.phone === "string") update.phone = body.phone.trim().slice(0, 40);
  if (typeof body.photoURL === "string") update.photoURL = body.photoURL.slice(0, 1000);
  if (body.address !== undefined) update.address = cleanAddress(body.address);

  const existing = await fsGet(c.env, `users/${user.uid}`);
  const saved = existing ? await fsPatch(c.env, `users/${user.uid}`, update) : await fsCreate(c.env, "users", { email: user.email || "", ...update }, user.uid);
  return c.json(publicUser(user, saved));
});

// ---------- orders / checkout / purchase history ----------

app.post("/api/orders", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) return c.json({ error: "items[] required" }, 400);

  const shipping = cleanAddress(body.shipping);
  if (!shipping || !shipping.fullName || !shipping.phone || !shipping.line1 || !shipping.city) {
    return c.json({ error: "Shipping details (name, phone, address, city) are required" }, 400);
  }

  const paymentMethod = ["cod", "bkash", "nagad"].includes(body.paymentMethod) ? body.paymentMethod : "cod";
  const paymentRef = paymentMethod !== "cod" && typeof body.paymentRef === "string"
    ? body.paymentRef.trim().slice(0, 60)
    : "";
  const paymentPayerName = paymentMethod !== "cod" && typeof body.paymentPayerName === "string" ? body.paymentPayerName.trim().slice(0, 120) : "";
  const paymentProductCodes = Array.isArray(body.paymentProductCodes) ? body.paymentProductCodes.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : [];
  if (paymentMethod !== "cod" && !paymentRef) {
    return c.json({ error: `Please provide the ${paymentMethod === "bkash" ? "bKash" : "Nagad"} transaction ID` }, 400);
  }

  const paymentConfig = await getPaymentSettings(c.env);
  const deliveryZone = shipping.deliveryZone;
  if (!["inside_dhaka", "outside_dhaka"].includes(deliveryZone)) {
    return c.json({ error: "Please select a delivery area: Inside Dhaka or Outside Dhaka." }, 400);
  }
  const deliveryFree = isFreeDeliveryActive(paymentConfig);
  const configuredDeliveryCharge = deliveryZone === "inside_dhaka"
    ? Math.max(0, Number(paymentConfig.insideDhakaCharge ?? 75) || 0)
    : Math.max(0, Number(paymentConfig.outsideDhakaCharge ?? 150) || 0);
  const deliveryCharge = deliveryFree ? 0 : configuredDeliveryCharge;
  const returnCharge = Math.max(0, Number(paymentConfig?.returnCharge) || 0);
  let membership = null;
  let membershipDiscountPercent = 0;
  let useCoins = body?.useCoins === true;
  let coinDiscount = 0;
  let coinsUsed = 0;
  try {
    const membershipRecord = await fsGet(c.env, `memberships/${user.uid}`);
    if (membershipRecord?.status === "active") membership = membershipRecord;
  } catch {}
  const coinSettings = await getCoinSettings(c.env);


  // Consolidate duplicate cart lines first. This prevents reserving the same
  // product twice in one checkout and makes the transaction deterministic.
  const quantities = new Map();
  for (const line of items) {
    const id = String(line?.id || "").trim();
    const size = String(line?.size || "").trim();
    const qty = Math.max(1, Math.floor(Number(line?.qty) || 1));
    if (!id) return c.json({ error: "Invalid product in cart" }, 400);
    const key = `${id}::${size}`;
    quantities.set(key, { id, size, qty: (quantities.get(key)?.qty || 0) + qty });
  }

  try {
    const now = new Date().toISOString();
    const orderId = crypto.randomUUID();
    const result = await fsRunTransaction(c.env, async ({ transaction, get }) => {
      const orderItems = [];
      const stockWrites = [];
      let total = 0;
      let subtotal = 0;

      for (const { id, size, qty } of quantities.values()) {
        const product = await get(`products/${id}`);
        if (!product) throw Object.assign(new Error(`Product ${id} not found`), { status: 404 });

        const currentStock = Math.max(0, Math.floor(Number(product.stock) || 0));
        const currentSold = Number.isFinite(product.sold) ? product.sold : 0;
        const sizes = Array.isArray(product.sizes) ? product.sizes.map((x) => ({ size: String(x?.size || ""), stock: Math.max(0, Math.floor(Number(x?.stock) || 0)) })) : [];
        if (sizes.length) {
          if (!size) throw Object.assign(new Error(`Please select a size for "${product.name}"`), { status: 400 });
          const selected = sizes.find((x) => x.size === size);
          if (!selected) throw Object.assign(new Error(`Size ${size} is not available for "${product.name}"`), { status: 400 });
          if (selected.stock < qty) throw Object.assign(new Error(`"${product.name}" size ${size} is out of stock. Available: ${selected.stock}`), { status: 409 });
          selected.stock -= qty;
        }
        const pricing = getProductPricing(product, new Date(now));
        const price = Number(pricing.price);
        if (!Number.isFinite(price) || price < 0) {
          throw Object.assign(new Error(`Product "${product.name}" has an invalid price`), { status: 400 });
        }
        if (currentStock < qty) {
          throw Object.assign(new Error(`"${product.name}" is out of stock. Available: ${currentStock}`), { status: 409 });
        }

        stockWrites.push({
          update: {
            name: product.name ? `${product.name}` : `products/${id}`,
            fields: {},
          },
        });
        // Firestore document names must be full resource names. The tx GET
        // helper exposes the exact name so renamed/project-specific paths are safe.
        stockWrites[stockWrites.length - 1].update.name = product.resourceName || `projects/${c.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/products/${id}`;
        stockWrites[stockWrites.length - 1].update.fields = {
          stock: { integerValue: String(sizes.length ? sizes.reduce((sum, x) => sum + x.stock, 0) : currentStock - qty) },
          sold: { doubleValue: currentSold + qty },
          ...(sizes.length ? { sizes: { arrayValue: { values: sizes.map((x) => ({ mapValue: { fields: { size: { stringValue: x.size }, stock: { integerValue: String(x.stock) } } } })) } } } : {}),
        };
        stockWrites[stockWrites.length - 1].updateMask = { fieldPaths: sizes.length ? ["stock", "sold", "sizes"] : ["stock", "sold"] };

        orderItems.push({
          id: product.id,
          productCode: product.productCode || product.id,
          name: product.name,
          price,
          originalPrice: pricing.originalPrice,
          offerActive: pricing.offerActive,
          image: product.image || "",
          size: size || "",
          qty,
        });
        subtotal += price * qty;
      }

      // Reward coins are redeemed inside the same Firestore transaction as the
      // order, so two checkout requests cannot spend the same balance. The
      // balance is read server-side and is never returned to the customer.
      let membershipTx = null;
      if (membership?.status === "active") {
        membershipTx = await get(`memberships/${user.uid}`);
        if (membershipTx?.status === "active" && useCoins && coinSettings.enabled) {
          const balance = Math.max(0, Math.floor(Number(membershipTx.coinBalance) || 0));
          const maxDiscount = subtotal * (Math.max(1, Math.min(100, Number(coinSettings.maxRedeemPercent) || 30)) / 100);
          const valuePerCoin = Math.max(0.01, Number(coinSettings.coinValue) || 1);
          coinsUsed = Math.min(balance, Math.floor(maxDiscount / valuePerCoin));
          if (coinsUsed >= Math.max(1, Math.floor(Number(coinSettings.minRedeemCoins) || 1))) coinDiscount = Math.round(coinsUsed * valuePerCoin * 100) / 100;
          else coinsUsed = 0;
          if (coinsUsed > 0) {
            stockWrites.push({
              update: {
                name: membershipTx.resourceName || `projects/${c.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/memberships/${user.uid}`,
                fields: { coinBalance: { integerValue: String(Math.max(0, balance - coinsUsed)) }, updatedAt: { timestampValue: now } },
              },
              updateMask: { fieldPaths: ["coinBalance", "updatedAt"] },
            });
          }
        }
      }
      const discount = Math.round(subtotal * membershipDiscountPercent) / 100;
      total = Math.max(0, subtotal - discount - coinDiscount + deliveryCharge);
      const orderData = {
        uid: user.uid,
        email: user.email || "",
        customerName: shipping.fullName,
        phone: shipping.phone,
        items: orderItems,
        subtotal,
        discount,
        coinDiscount,
        coinsUsed,
        membershipDiscountPercent,
        membershipPlan: membership?.planName || null,
        deliveryZone,
        deliveryCharge,
        deliveryFree,
        returnCharge,
        total,
        status: "placed",
        statusHistory: [{ status: "placed", at: now }],
        createdAt: now,
        shipping,
        paymentMethod,
        paymentRef,
        paymentPayerName,
        paymentProductCodes,
        paymentStatus: paymentMethod === "cod" ? "not_required" : "pending",
        paymentVerifiedAt: null,
        paymentVerifiedBy: null,
        paymentNote: "",
      };

      const orderName = `projects/${c.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/orders/${orderId}`;
      stockWrites.push({
        update: { name: orderName, fields: toFirestoreFieldsForOrder(orderData) },
        currentDocument: { exists: false },
      });

      return { writes: stockWrites, value: { id: orderId, ...orderData } };
    });

    // The transaction already returned the exact order payload that was committed.
    // Avoid an immediate follow-up Firestore GET here; it was an unnecessary
    // extra document read on every successful checkout.
    const saved = result;
    // Do not expose coin balance or coin earning details in the customer response.
    if (saved) { delete saved.coinsUsed; delete saved.coinsEarned; delete saved.coinBalance; }
    return c.json(saved, 201);
  } catch (e) {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    return c.json({ error: e?.message || "Could not place order" }, status);
  }
});

// Keep the checkout route independent from Firestore's private encoder.
// The transaction helper expects already-encoded Firestore fields.
function toFirestoreFieldsForOrder(obj) {
  const encode = (v) => {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "string") return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
    if (typeof v === "object") {
      const fields = {};
      for (const [k, value] of Object.entries(v)) fields[k] = encode(value);
      return { mapValue: { fields } };
    }
    return { stringValue: String(v) };
  };
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encode(v);
  return fields;
}

app.get("/api/orders/me", requireAuth, async (c) => {
  const user = c.get("user");
  // Query only this customer's orders instead of reading the entire orders
  // collection and filtering it in the Worker. This is a major read reduction
  // as the store grows.
  const mine = await fsQueryEquals(c.env, "orders", "uid", user.uid);
  mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return c.json(mine);
});

app.get("/api/admin/notification-state", requireAdminAnyPermission(["manageProducts","manageCategories","manageOrders","manageMessages","manageHomepage","managePayments"]), async (c) => {
  let state = await fsGetAdminNotificationState(c.env, { ttlMs: 15_000 });
  if (!state) {
    // First installation establishes a clean baseline without reading every collection.
    const now = new Date().toISOString();
    const created = await fsCreate(c.env, "adminNotificationState", {
      products: now, categories: now, subcategories: now, orders: now,
      messages: now, homepage: now, payments: now,
    }, "adminNotificationState");
    state = created;
  }
  return c.json(state);
});

app.get("/api/admin/analytics", requireAdminAnyPermission(["manageOrders","managePayments"]), async (c) => {
  const year = Math.min(2100, Math.max(2000, Number(c.req.query("year") || new Date().getUTCFullYear())));
  const months = [];
  for (let month = 0; month < 12; month += 1) {
    const start = new Date(Date.UTC(year, month, 1)).toISOString();
    const end = new Date(Date.UTC(year, month + 1, 1)).toISOString();
    const base = [
      { field: "createdAt", op: "GREATER_THAN_OR_EQUAL", value: start },
      { field: "createdAt", op: "LESS_THAN", value: end },
    ];
    const [delivered, sales] = await Promise.all([
      fsAggregate(c.env, "orders", [
        { alias: "income", type: "sum", field: "total" },
        { alias: "deliveredOrders", type: "count" },
      ], { filters: [...base, { field: "status", op: "EQUAL", value: "delivered" }], ttlMs: 300_000 }),
      fsAggregate(c.env, "orders", [
        { alias: "sales", type: "sum", field: "total" },
        { alias: "salesOrders", type: "count" },
      ], { filters: [...base, { field: "status", op: "NOT_EQUAL", value: "cancelled" }], ttlMs: 300_000 }),
    ]);
    months.push({
      month: new Date(Date.UTC(year, month, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      income: Number(delivered.income || 0),
      sales: Number(sales.sales || 0),
      orders: Number(sales.salesOrders || 0),
      deliveredOrders: Number(delivered.deliveredOrders || 0),
    });
  }
  const statusFilters = [
    ["placed", "pending"], ["confirmed", "confirmed"], ["processing", "processing"],
    ["shipped", "shipped"], ["delivered", "delivered"], ["cancelled", "cancelled"],
  ];
  const statusCounts = await Promise.all(statusFilters.map(async ([status, key]) => ({
    key,
    count: Number((await fsAggregate(c.env, "orders", [{ alias: "count", type: "count" }], { filters: [{ field: "status", op: "EQUAL", value: status }], ttlMs: 300_000 })).count || 0),
  })));
  const paymentMethods = ["cod", "bkash", "nagad", "card"];
  const paymentData = [];
  for (const method of paymentMethods) {
    const result = await fsAggregate(c.env, "orders", [{ alias: "revenue", type: "sum", field: "total" }], {
      filters: [{ field: "status", op: "EQUAL", value: "delivered" }, { field: "paymentMethod", op: "EQUAL", value: method }],
      ttlMs: 300_000,
    });
    paymentData.push({ method: method === "cod" ? "Cash on delivery" : method, revenue: Number(result.revenue || 0) });
  }
  const [productCount, unreadMessages] = await Promise.all([
    fsAggregate(c.env, "products", [{ alias: "count", type: "count" }], { ttlMs: 300_000 }),
    fsAggregate(c.env, "messages", [{ alias: "count", type: "count" }], { filters: [
      { field: "from", op: "EQUAL", value: "user" },
      { field: "seenByAdmin", op: "EQUAL", value: false },
    ], ttlMs: 60_000 }),
  ]);
  return c.json({
    year,
    months,
    statusCounts,
    paymentData,
    productCount: Number(productCount.count || 0),
    unreadMessages: Number(unreadMessages.count || 0),
  });
});

app.get("/api/admin/orders/page", requireAdminAnyPermission(["manageOrders","managePayments"]), async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") || 25)));
  const status = String(c.req.query("status") || "all");
  const validStatuses = new Set(["placed","confirmed","processing","shipped","delivered","cancelled"]);
  const result = status !== "all" && validStatuses.has(status)
    ? await fsQueryPageEquals(c.env, "orders", "status", status, { limit, cursor: c.req.query("cursor") || "", orderField: "createdAt" })
    : await fsListPage(c.env, "orders", { pageSize: limit, pageToken: c.req.query("cursor") || "", orderBy: "createdAt desc, __name__ desc" });
  const statusCounts = await Promise.all([...validStatuses].map(async (value) => ({
    status: value,
    count: Number((await fsAggregate(c.env, "orders", [{ alias: "count", type: "count" }], { filters: [{ field: "status", op: "EQUAL", value }], ttlMs: 60_000 })).count || 0),
  })));
  return c.json({ items: result.items || [], nextCursor: result.nextCursor || result.nextPageToken || null, statusCounts });
});

app.get("/api/admin/orders", requireAdminAnyPermission(["manageOrders","managePayments"]), async (c) => {
  const all = await fsList(c.env, "orders");
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return c.json(all);
});

// Restore stock for an order that is being cancelled.
// Use a Firestore transaction instead of updateTime preconditions. Product
// documents can be touched by another admin/client request while the order
// cancellation is being processed; the transaction retries atomically and
// avoids the recurring 409 "Could not restore stock" failure.
async function restoreOrderStock(env, order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const grouped = new Map();
  for (const item of items) {
    const id = String(item?.id || '').trim();
    const size = String(item?.size || '').trim();
    const qty = Math.max(0, Math.floor(Number(item?.qty) || 0));
    if (!id || qty === 0) continue;
    const key = `${id}::${size}`;
    grouped.set(key, { id, size, qty: (grouped.get(key)?.qty || 0) + qty });
  }
  if (!grouped.size) return { restored: true, method: 'none' };

  // Primary path: atomic Firestore transaction. This is the same transaction
  // mechanism already used successfully by checkout.
  try {
    await fsRunTransaction(env, async ({ get }) => {
      const writes = [];
      const perProduct = new Map();
      for (const { id, size, qty } of grouped.values()) {
        let entry = perProduct.get(id);
        if (!entry) {
          const product = await get(`products/${id}`);
          if (!product) continue;
          entry = { product, sizeDeltas: new Map() };
          perProduct.set(id, entry);
        }
        entry.sizeDeltas.set(size, (entry.sizeDeltas.get(size) || 0) + qty);
      }

      for (const { product, sizeDeltas } of perProduct.values()) {
        const sizes = Array.isArray(product.sizes)
          ? product.sizes.map((x) => ({ size: String(x?.size || ''), stock: Math.max(0, Math.floor(Number(x?.stock) || 0)) }))
          : [];
        const sold = Math.max(0, Number(product.sold) || 0);
        let totalRestore = 0;

        if (sizes.length) {
          for (const [size, qty] of sizeDeltas.entries()) {
            const selected = size ? sizes.find((x) => x.size === size) : null;
            if (selected) {
              selected.stock += qty;
              totalRestore += qty;
            } else if (!size) {
              totalRestore += qty;
            } else {
              // The catalog size was removed after the order. Keep the order
              // cancellation successful without inventing a new size.
              totalRestore += qty;
            }
          }
          const restoredStock = sizes.reduce((sum, x) => sum + x.stock, 0);
          writes.push({
            update: {
              name: product.resourceName || `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/products/${product.id}`,
              fields: {
                stock: { integerValue: String(Math.max(0, Math.floor(restoredStock))) },
                sold: { doubleValue: Math.max(0, sold - totalRestore) },
                sizes: { arrayValue: { values: sizes.map((x) => ({ mapValue: { fields: {
                  size: { stringValue: x.size },
                  stock: { integerValue: String(Math.max(0, Math.floor(x.stock))) }
                } } })) } }
              },
              updateMask: { fieldPaths: ['stock', 'sold', 'sizes'] },
            }
          });
        } else {
          const totalQty = [...sizeDeltas.values()].reduce((sum, qty) => sum + qty, 0);
          writes.push({
            update: {
              name: product.resourceName || `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/products/${product.id}`,
              fields: {
                stock: { integerValue: String(Math.max(0, Math.floor(Number(product.stock) || 0) + totalQty)) },
                sold: { doubleValue: Math.max(0, sold - totalQty) },
              },
              updateMask: { fieldPaths: ['stock', 'sold'] },
            }
          });
        }
      }
      return { writes, value: true };
    }, 5);
    return { restored: true, method: 'transaction' };
  } catch (transactionError) {
    // Fallback for local/emulator or Firestore REST transaction edge cases.
    // Cancellation/payment rejection must never be turned into a 500 just
    // because inventory restoration encountered a transient conflict.
    let lastError = transactionError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const perProduct = new Map();
        for (const { id, size, qty } of grouped.values()) {
          let entry = perProduct.get(id);
          if (!entry) {
            const product = await fsGet(env, `products/${id}`);
            if (!product) continue;
            entry = { product, sizeDeltas: new Map() };
            perProduct.set(id, entry);
          }
          entry.sizeDeltas.set(size, (entry.sizeDeltas.get(size) || 0) + qty);
        }

        for (const { product, sizeDeltas } of perProduct.values()) {
          const sizes = Array.isArray(product.sizes)
            ? product.sizes.map((x) => ({ size: String(x?.size || ''), stock: Math.max(0, Math.floor(Number(x?.stock) || 0)) }))
            : [];
          const sold = Math.max(0, Number(product.sold) || 0);
          let totalRestore = 0;
          if (sizes.length) {
            for (const [size, qty] of sizeDeltas.entries()) {
              const selected = size ? sizes.find((x) => x.size === size) : null;
              if (selected) { selected.stock += qty; totalRestore += qty; }
              else if (!size) totalRestore += qty;
            }
            await fsPatch(env, `products/${product.id}`, {
              stock: Math.max(0, Math.floor(sizes.reduce((sum, x) => sum + x.stock, 0))),
              sold: Math.max(0, sold - totalRestore),
              sizes,
            }, product.updateTime);
          } else {
            const totalQty = [...sizeDeltas.values()].reduce((sum, qty) => sum + qty, 0);
            await fsPatch(env, `products/${product.id}`, {
              stock: Math.max(0, Math.floor(Number(product.stock) || 0) + totalQty),
              sold: Math.max(0, sold - totalQty),
            }, product.updateTime);
          }
        }
        return { restored: true, method: 'fallback' };
      } catch (e) {
        lastError = e;
        if (Number(e?.status) !== 409) break;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    const err = new Error(`Stock restoration failed after cancellation/payment rejection: ${lastError?.message || 'unknown error'}`);
    err.status = Number(lastError?.status) || 500;
    err.cause = lastError;
    throw err;
  }
}

// Admin order workflow. Cancelling an order restores the purchased quantities
// exactly once; changing away from cancelled does not reserve them again.
app.patch("/api/admin/orders/:id", requireAdminPermission("manageOrders"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const allowed = new Set(["placed", "confirmed", "processing", "shipped", "delivered", "cancelled"]);
  const status = body?.status;
  if (!allowed.has(status)) return c.json({ error: "Invalid order status" }, 400);

  const order = await fsGet(c.env, `orders/${id}`);
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.status === status) return c.json(order);

  // Only the transition INTO cancelled restores stock. This makes repeated
  // clicks/retries safe and prevents double-restocking.
  let stockRestore = null;
  if (status === "cancelled" && order.status !== "cancelled") {
    try {
      stockRestore = await restoreOrderStock(c.env, order);
    } catch (e) {
      // Do not lose the customer-facing cancellation because inventory has a
      // transient Firestore problem. Save an explicit flag for admin follow-up.
      stockRestore = { restored: false, pending: true, error: String(e?.message || "Stock restoration failed").slice(0, 500) };
    }
  }
  const now = new Date().toISOString();
  const history = Array.isArray(order.statusHistory) ? order.statusHistory : [{ status: order.status, at: order.createdAt || now }];
  const nextHistory = history.length && history[history.length - 1]?.status === status ? history : [...history, { status, at: now }];
  const cancellationReason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : (order.cancellationReason || "");
  const saved = await fsPatch(c.env, `orders/${id}`, {
    status,
    statusHistory: nextHistory,
    ...(status === "cancelled" ? {
      cancellationReason,
      customerNotice: cancellationReason || "This order was cancelled by the studio.",
      ...(stockRestore?.restored ? { stockRestoreStatus: "restored", stockRestoredAt: now } : {}),
      ...(stockRestore?.pending ? { stockRestoreStatus: "pending", stockRestoreError: stockRestore.error || "Inventory restoration is pending." } : {}),
    } : {}),
    updatedAt: now,
  });

  let notification = null;
  if (status === "cancelled") {
    const customerMessage = `Order #${String(id).slice(-8)} was cancelled by ArtCanvas before delivery. ${cancellationReason || "No additional reason was provided."}`;
    try {
      notification = await notifyCustomerOrderEvent(c.env, { ...order, ...saved, id }, {
        subject: `ArtCanvas order #${String(id).slice(-8)} cancelled`,
        text: customerMessage,
        messageType: "order_cancellation",
      });
    } catch (e) {
      notification = { sent: false, emailSent: false, reason: String(e?.message || 'Could not notify customer').slice(0, 500) };
    }
  }

  await recordAudit(c.env,c.get("user"),"order_status_updated","order",id,order.customerName||order.email,`${order.status} → ${status}${stockRestore?.pending ? `; stock restore pending: ${stockRestore.error}` : ""}`);
  if (status === "delivered") await maybeAwardCoins(c.env, { ...saved, id }, "delivered_purchase");
  return c.json(notification ? { ...saved, notification } : saved);
});

app.patch("/api/admin/orders/:id/payment", requireAdminPermission("managePayments"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const paymentStatus = body?.paymentStatus;
  if (!["pending","verified","rejected","not_required"].includes(paymentStatus)) return c.json({ error: "Invalid payment status" }, 400);
  const order = await fsGet(c.env, `orders/${id}`);
  if (!order) return c.json({ error: "Order not found" }, 404);
  const now = new Date().toISOString();
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : (order.paymentNote || "");
  const rejectReason = paymentStatus === "rejected"
    ? (note || "Transaction could not be verified. The payment transaction ID did not match our records.")
    : "";

  // A rejected online payment also rejects/cancels the order before delivery,
  // restores stock once, and stores a customer-facing notice. This keeps the
  // client informed without exposing admin-only audit details.
  let nextStatus = order.status;
  let statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [{ status: order.status, at: order.createdAt || now }];
  let stockRestore = null;
  if (paymentStatus === "rejected" && order.status !== "delivered" && order.status !== "cancelled") {
    try {
      stockRestore = await restoreOrderStock(c.env, order);
    } catch (e) {
      stockRestore = { restored: false, pending: true, error: String(e?.message || "Stock restoration failed").slice(0, 500) };
    }
    nextStatus = "cancelled";
    statusHistory = [...statusHistory, { status: "cancelled", at: now, reason: rejectReason, source: "payment_rejected" }];
  }

  const saved = await fsPatch(c.env, `orders/${id}`, {
    paymentStatus,
    paymentVerifiedAt: paymentStatus === "verified" ? now : null,
    paymentVerifiedBy: typeof body?.verifiedBy === "string" ? body.verifiedBy.slice(0, 160) : "",
    paymentNote: note,
    paymentVerifiedByName: typeof body?.verifiedByName === "string" ? body.verifiedByName.slice(0, 160) : (order.paymentVerifiedByName || ""),
    ...(paymentStatus === "rejected" ? {
      status: nextStatus,
      statusHistory,
      cancellationReason: rejectReason,
      customerNotice: `Payment rejected. ${rejectReason} If money was deducted from your account, please contact ArtCanvas support so we can verify and arrange a refund/return of funds.`,
      paymentRefundStatus: "contact_required",
      ...(stockRestore?.restored ? { stockRestoreStatus: "restored", stockRestoredAt: now } : {}),
      ...(stockRestore?.pending ? { stockRestoreStatus: "pending", stockRestoreError: stockRestore.error || "Inventory restoration is pending." } : {}),
    } : {}),
    updatedAt: now,
  });

  let notification = null;
  if (paymentStatus === "rejected") {
    const customerMessage = `Payment for order #${String(id).slice(-8)} was rejected. ${rejectReason} If money was deducted from your account, please contact ArtCanvas support so we can verify the payment and arrange a refund/return of funds where applicable.`;
    try {
      notification = await notifyCustomerOrderEvent(c.env, { ...order, ...saved, id }, {
        subject: `ArtCanvas payment rejected for order #${String(id).slice(-8)}`,
        text: customerMessage,
        messageType: "payment_rejection",
      });
    } catch (e) {
      notification = { sent: false, emailSent: false, reason: String(e?.message || 'Could not notify customer').slice(0, 500) };
    }
  }

  await recordAudit(c.env,c.get("user"),paymentStatus==="verified"?"payment_verified":"payment_updated","order",id,order.customerName||order.email,`Payment ${paymentStatus}; transaction ${order.paymentRef||"—"}; note ${note||"—"}${stockRestore?.pending ? `; stock restore pending: ${stockRestore.error}` : ""}`);
  if (paymentStatus === "verified") await maybeAwardCoins(c.env, { ...saved, id }, "verified_payment");
  return c.json(notification ? { ...saved, notification } : saved);
});

// Remove transaction/payment details without deleting the customer's order.
// This is intentionally separate from order deletion so the client can keep the
// cancellation/rejection history while the admin can clear sensitive transaction data.
app.delete("/api/admin/orders/:id/payment", requireAdminPermission("managePayments"), async (c) => {
  const id = c.req.param("id");
  const order = await fsGet(c.env, `orders/${id}`);
  if (!order) return c.json({ error: "Order not found" }, 404);
  const now = new Date().toISOString();
  const saved = await fsPatch(c.env, `orders/${id}`, {
    paymentStatus: "not_required",
    paymentRef: "",
    paymentPayerName: "",
    paymentNote: "",
    paymentVerifiedAt: null,
    paymentVerifiedBy: "",
    paymentVerifiedByName: "",
    paymentDataDeletedAt: now,
    updatedAt: now,
  });
  await recordAudit(c.env,c.get("user"),"payment_data_deleted","order",id,order.customerName||order.email,`Payment transaction data cleared; order retained.`);
  return c.json(saved);
});

app.delete("/api/admin/orders/:id", requireAdminPermission("manageOrders"), async (c) => {
  const id = c.req.param("id");
  const order = await fsGet(c.env, `orders/${id}`);
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (!["delivered", "cancelled"].includes(order.status)) return c.json({ error: "Only completed or cancelled orders can be deleted." }, 409);
  await fsDelete(c.env, `orders/${id}`);
  return c.json({ ok: true });
});



async function recordAudit(env, user, action, targetType, targetId, targetName, details="") {
  try { await fsCreate(env, "auditLogs", { adminId:user?.uid||"", adminName:user?.name||user?.email||"Admin", adminEmail:user?.email||"", action, targetType, targetId:String(targetId||""), targetName:String(targetName||"").slice(0,180), details:String(details||"").slice(0,500), timestamp:new Date().toISOString() }); } catch {}
}

// ---------- admin management / requests / audit ----------
app.get("/api/admin/admins", requireAdminPermission("manageAdmins"), async (c)=>{
  const all=await fsList(c.env,"adminUsers");
  return c.json(all.filter(x=>!String(x.id||"").startsWith("temp_")&&x.status!=="deleted").sort((a,b)=>(a.createdAt||"")<(b.createdAt||"")?1:-1));
});
app.post("/api/admin/admins", requireAdminPermission("manageAdmins"), async (c)=>{
  const b=await c.req.json().catch(()=>null); if(!b?.email) return c.json({error:"Email is required"},400);
  const users=await fsQueryEquals(c.env,"users","email",String(b.email).trim().toLowerCase()); const user=users[0];
  const uid=user?.id || b.uid; if(!uid) return c.json({error:"Customer must sign in/create an ArtCanvas account first so the admin profile can be linked securely."},409);
  const current=await fsGet(c.env,`adminUsers/${uid}`); const now=new Date().toISOString();
  const record={id:uid,name:String(b.name||user?.name||b.email).slice(0,120),email:String(b.email).toLowerCase().slice(0,160),role:b.role||"Moderator",status:b.status||"active",permissions:b.permissions||{},createdAt:current?.createdAt||now,createdBy:b.createdBy||c.get("user")?.uid,updatedAt:now};
  const saved=current ? await fsPatch(c.env,`adminUsers/${uid}`,record) : await fsCreate(c.env,"adminUsers",record,uid);
  await recordAudit(c.env,c.get("user"),current?"admin_updated":"admin_created","admin",uid,record.name,`Role: ${record.role}`);
  return c.json(saved);
});
app.patch("/api/admin/admins/:id", requireAdminPermission("manageAdmins"), async(c)=>{const id=c.req.param("id"),b=await c.req.json().catch(()=>null),cur=await fsGet(c.env,`adminUsers/${id}`);if(!cur)return c.json({error:"Admin not found"},404);const patch={};for(const k of ["name","role","status","permissions","phone","location","bio","avatar","facebook","whatsapp","twitter","linkedin","instagram"])if(k in (b||{}))patch[k]=b[k];patch.updatedAt=new Date().toISOString();return c.json(await fsPatch(c.env,`adminUsers/${id}`,patch));});
app.delete("/api/admin/admins/:id", requireAdminPermission("manageAdmins"), async(c)=>{const id=c.req.param("id");if(id===c.get("user")?.uid)return c.json({error:"You cannot remove your own admin access."},409);await fsPatch(c.env,`adminUsers/${id}`,{status:"deleted",deletedAt:new Date().toISOString()});return c.json({ok:true});});
app.post("/api/admin/access-requests", async(c)=>{const b=await c.req.json().catch(()=>null);if(!b?.email||!b?.name)return c.json({error:"Name and email are required"},400);const email=String(b.email).trim().toLowerCase();const existing=(await fsList(c.env,"adminRequests")).find(x=>String(x.email||"").toLowerCase()===email&&x.status==="pending");if(existing)return c.json({error:"A pending request already exists"},409);return c.json(await fsCreate(c.env,"adminRequests",{name:String(b.name).slice(0,120),email,requestedRole:b.requestedRole||"Moderator",reason:String(b.reason||"").slice(0,500),status:"pending",createdAt:new Date().toISOString()}),201);});
app.get("/api/admin/access-requests", requireAdminPermission("manageAdmins"), async(c)=>{const all=await fsList(c.env,"adminRequests");return c.json(all.sort((a,b)=>(a.createdAt||"")<(b.createdAt||"")?1:-1));});
app.patch("/api/admin/access-requests/:id", requireAdminPermission("manageAdmins"), async(c)=>{const id=c.req.param("id"),b=await c.req.json().catch(()=>null),cur=await fsGet(c.env,`adminRequests/${id}`);if(!cur)return c.json({error:"Request not found"},404);const status=["approved","rejected","pending"].includes(b?.status)?b.status:cur.status;const now=new Date().toISOString();const saved=await fsPatch(c.env,`adminRequests/${id}`,{status,reviewedAt:now,reviewedBy:b?.reviewerId||c.get("user")?.uid||"",reviewerName:b?.reviewerName||c.get("user")?.name||"Admin",reviewerNotes:String(b?.reviewerNotes||"").slice(0,500),assignedRole:b?.assignedRole||cur.requestedRole||"Moderator",assignedPermissions:b?.assignedPermissions||{}});if(status==="approved"){const users=await fsList(c.env,"users");const u=users.find(x=>String(x.email||"").toLowerCase()===String(cur.email||"").toLowerCase());if(u?.id){const adminPayload={name:cur.name||u.name||cur.email,email:cur.email,role:b?.assignedRole||cur.requestedRole||"Moderator",permissions:b?.assignedPermissions||{},status:"active",createdAt:now,createdBy:c.get("user")?.uid||"admin"};const existingAdmin=await fsGet(c.env,`adminUsers/${u.id}`);if(existingAdmin)await fsPatch(c.env,`adminUsers/${u.id}`,adminPayload);else await fsCreate(c.env,"adminUsers",adminPayload,u.id);await recordAudit(c.env,c.get("user"),"admin_request_approved","adminRequest",id,cur.name||cur.email,`Role: ${adminPayload.role}`);}}return c.json(saved);});
app.get("/api/admin/audit", requireAdminPermission("viewAuditLogs"), async(c)=>{const all=await fsList(c.env,"auditLogs");const n=Math.min(500,Math.max(1,Number(c.req.query("limit")||200)));return c.json(all.sort((a,b)=>(a.timestamp||"")<(b.timestamp||"")?1:-1).slice(0,n));});

// ---------- payment + delivery settings ----------
const DEFAULT_PAYMENT_SETTINGS = {
  bkash: { number: "01820050464", label: "bKash", accountType: "Personal" },
  nagad: { number: "01820050464", label: "Nagad", accountType: "Personal" },
  cashOnDelivery: true,
  onlinePaymentEnabled: true,
  insideDhakaCharge: 75,
  outsideDhakaCharge: 150,
  // Kept for compatibility with older builds.
  deliveryCharge: 0,
  returnCharge: 0,
  freeDeliveryEnabled: false,
  freeDeliveryStartAt: "",
  freeDeliveryEndAt: "",
};

async function getPaymentSettings(env) {
  const saved = await fsGet(env, "storeSettings/payment").catch(() => null);
  const merged = {
    ...DEFAULT_PAYMENT_SETTINGS,
    ...(saved || {}),
    bkash: { ...DEFAULT_PAYMENT_SETTINGS.bkash, ...(saved?.bkash || {}) },
    nagad: { ...DEFAULT_PAYMENT_SETTINGS.nagad, ...(saved?.nagad || {}) },
  };
  return { ...merged, freeDeliveryActive: isFreeDeliveryActive(merged) };
}

function isFreeDeliveryActive(settings, now = new Date()) {
  return settings?.freeDeliveryEnabled === true &&
    isActiveDateWindow(true, settings?.freeDeliveryStartAt, settings?.freeDeliveryEndAt, now);
}

app.get("/api/payment-settings", async (c) => {
  return c.json(await getPaymentSettings(c.env));
});

app.get("/api/admin/payment-settings", requireAdminPermission("managePayments"), async (c) => {
  return c.json(await getPaymentSettings(c.env));
});

app.patch("/api/admin/payment-settings", requireAdminPermission("managePayments"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const current = await fsGet(c.env, "storeSettings/payment") || {};
  const cleanNumber = (v, fallback) => typeof v === "string" && v.trim() ? v.trim().slice(0, 30) : fallback;
  const cleanDate = (v, fallback = "") => typeof v === "string" ? v.trim().slice(0, 40) : fallback;
  const insideDhakaCharge = body?.insideDhakaCharge !== undefined
    ? Math.max(0, Number(body.insideDhakaCharge) || 0)
    : Math.max(0, Number(current.insideDhakaCharge ?? 75) || 0);
  const outsideDhakaCharge = body?.outsideDhakaCharge !== undefined
    ? Math.max(0, Number(body.outsideDhakaCharge) || 0)
    : Math.max(0, Number(current.outsideDhakaCharge ?? 150) || 0);
  const freeDeliveryEnabled = body?.freeDeliveryEnabled !== undefined
    ? body.freeDeliveryEnabled === true
    : current.freeDeliveryEnabled === true;
  const freeDeliveryStartAt = cleanDate(body?.freeDeliveryStartAt, current.freeDeliveryStartAt || "");
  const freeDeliveryEndAt = cleanDate(body?.freeDeliveryEndAt, current.freeDeliveryEndAt || "");

  if (freeDeliveryStartAt && freeDeliveryEndAt) {
    const start = Date.parse(freeDeliveryStartAt);
    const end = Date.parse(freeDeliveryEndAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
      return c.json({ error: "Free delivery end date/time must be after the start date/time." }, 400);
    }
  }

  const next = {
    ...DEFAULT_PAYMENT_SETTINGS,
    ...current,
    bkash: { ...DEFAULT_PAYMENT_SETTINGS.bkash, ...(current.bkash || {}), number: cleanNumber(body?.bkash?.number, current.bkash?.number || DEFAULT_PAYMENT_SETTINGS.bkash.number) },
    nagad: { ...DEFAULT_PAYMENT_SETTINGS.nagad, ...(current.nagad || {}), number: cleanNumber(body?.nagad?.number, current.nagad?.number || DEFAULT_PAYMENT_SETTINGS.nagad.number) },
    cashOnDelivery: body?.cashOnDelivery !== undefined ? body.cashOnDelivery === true : current.cashOnDelivery !== false,
    onlinePaymentEnabled: body?.onlinePaymentEnabled !== undefined ? body.onlinePaymentEnabled === true : current.onlinePaymentEnabled !== false,
    insideDhakaCharge,
    outsideDhakaCharge,
    deliveryCharge: 0,
    returnCharge: body?.returnCharge !== undefined ? Math.max(0, Number(body.returnCharge)||0) : Math.max(0, Number(current.returnCharge)||0),
    freeDeliveryEnabled,
    freeDeliveryStartAt,
    freeDeliveryEndAt,
    updatedAt: new Date().toISOString(),
  };
  const saved = await fsGet(c.env,"storeSettings/payment");
  return c.json(saved ? await fsPatch(c.env,"storeSettings/payment",next) : await fsCreate(c.env,"storeSettings",next,"payment"));
});

// ---------- ArtCanvas membership + reward coins ----------
// Membership is FREE. A customer requests membership and an admin approves it,
// or an admin can add an existing ArtCanvas account directly. Coin balances are
// intentionally NEVER returned by public/member endpoints.
const DEFAULT_COIN_SETTINGS = {
  enabled: true,
  earnPer100: 1,
  coinValue: 1,
  maxRedeemPercent: 30,
  minRedeemCoins: 1,
};

function safeMembership(record) {
  if (!record) return null;
  return {
    uid: record.uid,
    email: record.email || "",
    phone: record.phone || "",
    name: record.name || "",
    status: record.status || "pending",
    joinedAt: record.joinedAt || null,
    approvedAt: record.approvedAt || null,
    planName: "ArtCanvas Member",
  };
}

async function getCoinSettings(env) {
  const saved = await fsGet(env, "storeSettings/coins").catch(() => null);
  return { ...DEFAULT_COIN_SETTINGS, ...(saved || {}) };
}

async function getProductCoinRule(env, productId) {
  const rule = await fsGet(env, `coinRules/${productId}`).catch(() => null);
  return rule || null;
}

async function calculateEarnedCoins(env, orderItems) {
  const settings = await getCoinSettings(env);
  if (!settings.enabled) return 0;
  let coins = 0;
  for (const item of Array.isArray(orderItems) ? orderItems : []) {
    const rule = await getProductCoinRule(env, item.id);
    if (rule?.disabled === true) continue;
    const qty = Math.max(1, Math.floor(Number(item.qty) || 1));
    const rate = rule?.earnPer100 !== undefined ? Math.max(0, Number(rule.earnPer100) || 0) : Math.max(0, Number(settings.earnPer100) || 0);
    coins += Math.floor((Number(item.price) * qty / 100) * rate);
  }
  return Math.max(0, Math.floor(coins));
}

async function maybeAwardCoins(env, order, reason) {
  if (!order?.uid || order.coinsAwardedAt || order.status === "cancelled") return null;
  const paymentReady = order.paymentMethod === "cod" ? order.status === "delivered" : order.paymentStatus === "verified";
  if (!paymentReady) return null;
  const membership = await fsGet(env, `memberships/${order.uid}`).catch(() => null);
  if (!membership || membership.status !== "active") return null;
  const earned = await calculateEarnedCoins(env, order.items);
  const now = new Date().toISOString();
  const currentBalance = Math.max(0, Math.floor(Number(membership.coinBalance) || 0));
  const saved = await fsPatch(env, `memberships/${order.uid}`, {
    coinBalance: currentBalance + earned,
    lastCoinAward: earned,
    lastCoinAwardAt: now,
    updatedAt: now,
  });
  await fsPatch(env, `orders/${order.id}`, { coinsEarned: earned, coinsAwardedAt: now, coinsAwardReason: reason || "completed_purchase" }).catch(() => {});
  await fsCreate(env, "coinLedger", {
    uid: order.uid,
    orderId: order.id,
    type: "earn",
    coins: earned,
    reason: reason || "completed_purchase",
    createdAt: now,
  }).catch(() => {});
  return saved;
}

app.get("/api/membership-plans", async (c) => {
  return c.json([{ id: "member", name: "ArtCanvas Member", description: "Free membership with reward coins, member announcements and special offers.", price: 0, active: true }]);
});

app.get("/api/membership/me", requireAuth, async (c) => {
  const uid = c.get("user").uid;
  const membership = await fsGet(c.env, `memberships/${uid}`).catch(() => null);
  if (membership) return c.json(safeMembership(membership));
  const pending = (await fsQueryEquals(c.env, "membershipRequests", "uid", uid).catch(() => [])).find(x => x.status === "pending");
  return c.json(pending ? safeMembership({ ...pending, status: "pending" }) : null);
});

// Customer asks to become a FREE ArtCanvas member. Approval is required.
app.post("/api/membership/request", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name || user.name || "ArtCanvas Customer").trim().slice(0, 120);
  const phone = String(body?.phone || "").trim().slice(0, 40);
  const email = String(user.email || body?.email || "").trim().toLowerCase().slice(0, 160);
  if (!email && !phone) return c.json({ error: "Email or phone number is required for membership." }, 400);
  const existing = await fsGet(c.env, `memberships/${user.uid}`).catch(() => null);
  if (existing?.status === "active") return c.json(safeMembership(existing));
  const requests = await fsQueryEquals(c.env, "membershipRequests", "uid", user.uid).catch(() => []);
  const pending = requests.find(x => x.status === "pending");
  if (pending) return c.json(safeMembership({ ...pending, status: "pending" }));
  const now = new Date().toISOString();
  const request = await fsCreate(c.env, "membershipRequests", { uid:user.uid, name, email, phone, status:"pending", createdAt:now }, user.uid);
  return c.json(safeMembership({ ...request, status:"pending" }), 201);
});

app.get("/api/admin/members", requireAdminPermission("manageMembership"), async (c) => {
  const all = await fsList(c.env, "memberships");
  return c.json(all.filter(x => x.status === "active").map(x => ({ ...x, coinBalance: Math.max(0, Math.floor(Number(x.coinBalance)||0)) })).sort((a,b)=>(a.joinedAt||"")<(b.joinedAt||"")?1:-1));
});

app.get("/api/admin/membership-requests", requireAdminPermission("manageMembership"), async (c) => {
  const all = await fsList(c.env, "membershipRequests");
  return c.json(all.sort((a,b)=>(a.createdAt||"")<(b.createdAt||"")?1:-1));
});

app.patch("/api/admin/membership-requests/:id", requireAdminPermission("manageMembership"), async (c) => {
  const id=c.req.param("id"), b=await c.req.json().catch(()=>({}));
  const cur=await fsGet(c.env,`membershipRequests/${id}`);
  if(!cur) return c.json({error:"Membership request not found"},404);
  const status=["approved","rejected","pending"].includes(b?.status)?b.status:cur.status;
  const now=new Date().toISOString();
  const saved=await fsPatch(c.env,`membershipRequests/${id}`,{status,reviewedAt:now,reviewedBy:c.get("user")?.uid||"",reviewerName:c.get("user")?.name||c.get("user")?.email||"Admin"});
  if(status==="approved") {
    const existing=await fsGet(c.env,`memberships/${cur.uid}`).catch(()=>null);
    const membership={uid:cur.uid,name:cur.name||"Member",email:cur.email||"",phone:cur.phone||"",status:"active",coinBalance:Math.max(0,Math.floor(Number(existing?.coinBalance)||0)),joinedAt:existing?.joinedAt||now,approvedAt:now,updatedAt:now};
    const result=existing?await fsPatch(c.env,`memberships/${cur.uid}`,membership):await fsCreate(c.env,"memberships",membership,cur.uid);
    const approvalText="Your ArtCanvas membership request has been approved. Welcome to the ArtCanvas Member community.";
    await fsCreate(c.env,"messages",{uid:cur.uid,email:cur.email||"",from:"admin",text:approvalText,seenByAdmin:true,createdAt:now}).catch(()=>{});
    if (cur.email) await sendTransactionalEmail(c.env,{to:cur.email,subject:"Your ArtCanvas membership is approved",text:approvalText}).catch(()=>({sent:false}));
    await recordAudit(c.env,c.get("user"),"membership_approved","membership",cur.uid,cur.name||cur.email,"Membership approved");
    return c.json({ ...saved, membership:safeMembership(result) });
  }
  await recordAudit(c.env,c.get("user"),`membership_${status}`,"membershipRequest",id,cur.name||cur.email,`Membership request ${status}`);
  return c.json(saved);
});

// Admin can add an existing ArtCanvas account directly by email or phone.
app.post("/api/admin/members", requireAdminPermission("manageMembership"), async (c) => {
  const b=await c.req.json().catch(()=>({}));
  const email=String(b?.email||"").trim().toLowerCase();
  const phone=String(b?.phone||"").trim();
  if(!email && !phone) return c.json({error:"Email or phone is required"},400);
  const users=await fsList(c.env,"users");
  const u=users.find(x=>(email && String(x.email||"").toLowerCase()===email)||(phone && String(x.phone||"").trim()===phone));
  if(!u?.id) return c.json({error:"No ArtCanvas account found. The customer must sign in/register first."},404);
  const now=new Date().toISOString(); const existing=await fsGet(c.env,`memberships/${u.id}`).catch(()=>null);
  const membership={uid:u.id,name:String(b?.name||u.name||u.email||"Member").slice(0,120),email:u.email||email,phone:u.phone||phone,status:"active",coinBalance:Math.max(0,Math.floor(Number(b?.coinBalance ?? existing?.coinBalance)||0)),joinedAt:existing?.joinedAt||now,approvedAt:existing?.approvedAt||now,updatedAt:now};
  const saved=existing?await fsPatch(c.env,`memberships/${u.id}`,membership):await fsCreate(c.env,"memberships",membership,u.id);
  await recordAudit(c.env,c.get("user"),existing?"membership_updated":"membership_added","membership",u.id,membership.name,"Member added/updated by admin");
  return c.json({ ...saved, coinBalance:Math.max(0,Math.floor(Number(saved.coinBalance)||0)) },201);
});

app.patch("/api/admin/members/:uid", requireAdminPermission("manageMembership"), async (c) => {
  const uid=c.req.param("uid"), b=await c.req.json().catch(()=>({}));
  const cur=await fsGet(c.env,`memberships/${uid}`); if(!cur) return c.json({error:"Member not found"},404);
  const patch={updatedAt:new Date().toISOString()};
  if(b?.status && ["active","suspended"].includes(b.status)) patch.status=b.status;
  if(b?.name!==undefined) patch.name=String(b.name).slice(0,120);
  if(b?.phone!==undefined) patch.phone=String(b.phone).slice(0,40);
  if(b?.coinBalance!==undefined) patch.coinBalance=Math.max(0,Math.floor(Number(b.coinBalance)||0));
  const saved=await fsPatch(c.env,`memberships/${uid}`,patch);
  await recordAudit(c.env,c.get("user"),"membership_updated","membership",uid,cur.name||cur.email,"Member status/profile/coin balance updated");
  return c.json({ ...saved, coinBalance:Math.max(0,Math.floor(Number(saved.coinBalance)||0)) });
});

app.get("/api/admin/coin-settings", requireAdminPermission("manageMembership"), async (c) => c.json(await getCoinSettings(c.env)));
app.patch("/api/admin/coin-settings", requireAdminPermission("manageMembership"), async (c) => {
  const b=await c.req.json().catch(()=>({})); const cur=await getCoinSettings(c.env);
  const next={...cur,enabled:b.enabled!==undefined?b.enabled===true:cur.enabled,earnPer100:Math.max(0,Number(b.earnPer100??cur.earnPer100)||0),coinValue:Math.max(0.01,Number(b.coinValue??cur.coinValue)||1),maxRedeemPercent:Math.max(1,Math.min(100,Number(b.maxRedeemPercent??cur.maxRedeemPercent)||30)),minRedeemCoins:Math.max(1,Math.floor(Number(b.minRedeemCoins??cur.minRedeemCoins)||1)),updatedAt:new Date().toISOString()};
  const saved=await fsGet(c.env,"storeSettings/coins"); return c.json(saved?await fsPatch(c.env,"storeSettings/coins",next):await fsCreate(c.env,"storeSettings",next,"coins"));
});
app.get("/api/admin/coin-rules", requireAdminPermission("manageMembership"), async (c) => c.json(await fsList(c.env,"coinRules")));
app.patch("/api/admin/coin-rules/:productId", requireAdminPermission("manageMembership"), async (c) => {
  const id=c.req.param("productId"), b=await c.req.json().catch(()=>({})); const current=await fsGet(c.env,`coinRules/${id}`).catch(()=>null);
  const rule={productId:id,disabled:b.disabled===true,earnPer100:Math.max(0,Number(b.earnPer100)||0),updatedAt:new Date().toISOString()};
  return c.json(current?await fsPatch(c.env,`coinRules/${id}`,rule):await fsCreate(c.env,"coinRules",rule,id));
});

// Admin can privately notify a member without exposing their coin balance.
app.post("/api/admin/members/:uid/message", requireAdminPermission("manageMembership"), async (c) => {
  const uid=c.req.param("uid"), b=await c.req.json().catch(()=>({})); const text=String(b?.text||"").trim().slice(0,3000); if(!text)return c.json({error:"Message is required"},400);
  const member=await fsGet(c.env,`memberships/${uid}`); if(!member)return c.json({error:"Member not found"},404);
  if(!member.email) return c.json({error:"This member does not have an email address."},400);
  const emailResult=await sendTransactionalEmail(c.env,{to:member.email,subject:"A message from ArtCanvas",text});
  if(!emailResult.sent) return c.json({error: emailResult.reason || "Could not send email", emailSent:false},503);
  const msg=await fsCreate(c.env,"messages",{uid,email:member.email||"",from:"admin",text,seenByAdmin:true,emailSent:true,emailId:emailResult.id||null,createdAt:new Date().toISOString()});
  return c.json({...msg,emailSent:true},201);
});

// Broadcast an announcement to every active member by in-app message + email.
app.post("/api/admin/members/broadcast", requireAdminPermission("manageMembership"), async (c) => {
  const b=await c.req.json().catch(()=>({})); const text=String(b?.text||"").trim().slice(0,3000); if(!text)return c.json({error:"Announcement message is required"},400);
  const members=(await fsList(c.env,"memberships")).filter(x=>x.status==="active"); const now=new Date().toISOString(); let sent=0, emailSent=0, failed=0;
  for(const m of members){
    const emailResult=await sendTransactionalEmail(c.env,{to:m.email,subject:"ArtCanvas member announcement",text}).catch(e=>({sent:false,reason:String(e?.message||e)}));
    if(emailResult.sent) emailSent++; else failed++;
    await fsCreate(c.env,"messages",{uid:m.uid,email:m.email||"",from:"admin",text,seenByAdmin:true,emailSent:emailResult.sent===true,emailId:emailResult.id||null,createdAt:now});
    sent++;
  }
  await recordAudit(c.env,c.get("user"),"membership_broadcast","membership","all","All members",`Announcement sent to ${sent} active members; ${emailSent} emails sent`);
  return c.json({ok:true,sent,emailSent,failed});
});

// ---------- circulation ----------
const CIRCULATION_STATUSES = ["loaned","due_soon","overdue","returned","shipped","in_transit","delivered","cancelled"];
app.get("/api/circulation/me", requireAuth, async (c) => { const all=await fsQueryEquals(c.env,"circulation","uid",c.get("user").uid); return c.json(all.sort((a,b)=>a.dueDate<b.dueDate?1:-1)); });
app.get("/api/admin/circulation", requireAdminPermission("manageCirculation"), async (c) => { const all=await fsList(c.env,"circulation"); return c.json(all.sort((a,b)=>(a.dueDate||"")<(b.dueDate||"")?1:-1)); });
app.post("/api/admin/circulation", requireAdminPermission("manageCirculation"), async (c)=>{
  const b=await c.req.json().catch(()=>null); if(!b?.uid || !b?.productName) return c.json({error:"Customer and product are required"},400);
  const now=new Date().toISOString(); const rec={uid:String(b.uid), customerName:String(b.customerName||"Customer").slice(0,120), customerEmail:String(b.customerEmail||"").slice(0,160), productId:String(b.productId||""), productCode:String(b.productCode||b.productId||"").slice(0,80), productName:String(b.productName).slice(0,180), status:CIRCULATION_STATUSES.includes(b.status)?b.status:"loaned", loanDate:b.loanDate||now, dueDate:b.dueDate||null, returnedDate:b.returnedDate||null, shipmentStatus:String(b.shipmentStatus||"not_shipped"), trackingNumber:String(b.trackingNumber||"").slice(0,100), courierName:String(b.courierName||"").slice(0,100), notes:String(b.notes||"").slice(0,500), createdAt:now, updatedAt:now};
  return c.json(await fsCreate(c.env,"circulation",rec),201);
});
app.patch("/api/admin/circulation/:id", requireAdminPermission("manageCirculation"), async (c)=>{const id=c.req.param("id"),b=await c.req.json().catch(()=>null),cur=await fsGet(c.env,`circulation/${id}`);if(!cur)return c.json({error:"Circulation record not found"},404);const patch={};for(const k of ["customerName","customerEmail","productId","productCode","productName","status","loanDate","dueDate","returnedDate","shipmentStatus","trackingNumber","courierName","notes"])if(k in (b||{}))patch[k]=b[k];if(patch.status&&!CIRCULATION_STATUSES.includes(patch.status))return c.json({error:"Invalid circulation status"},400);patch.updatedAt=new Date().toISOString();return c.json(await fsPatch(c.env,`circulation/${id}`,patch));});
app.delete("/api/admin/circulation/:id", requireAdminPermission("manageCirculation"), async(c)=>{await fsDelete(c.env,`circulation/${c.req.param("id")}`);return c.json({ok:true});});

// ---------- contact / complaint / feedback ----------
app.post("/api/contact", async (c)=>{const b=await c.req.json().catch(()=>null);const email=String(b?.email||"").trim().toLowerCase();const name=String(b?.name||"").trim();const message=String(b?.message||"").trim();const type=["general","complaint","feedback"].includes(b?.type)?b.type:"general";if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!message)return c.json({error:"Name, valid email and message are required"},400);const rec={name:name.slice(0,120),email:email.slice(0,160),phone:String(b?.phone||"").slice(0,30),type,message:message.slice(0,3000),uid:c.get("user")?.uid||null,status:"new",createdAt:new Date().toISOString()};return c.json(await fsCreate(c.env,"contactSubmissions",rec),201);});
app.get("/api/admin/contact", requireAdminPermission("manageContact"), async(c)=>{const all=await fsList(c.env,"contactSubmissions");return c.json(all.sort((a,b)=>a.createdAt<b.createdAt?1:-1));});
app.patch("/api/admin/contact/:id", requireAdminPermission("manageContact"), async(c)=>{const id=c.req.param("id"),b=await c.req.json().catch(()=>null),cur=await fsGet(c.env,`contactSubmissions/${id}`);if(!cur)return c.json({error:"Message not found"},404);const status=["new","seen","in_progress","resolved","closed"].includes(b?.status)?b.status:cur.status;return c.json(await fsPatch(c.env,`contactSubmissions/${id}`,{status,adminNote:String(b?.adminNote||cur.adminNote||"").slice(0,1000),updatedAt:new Date().toISOString()}));});
app.delete("/api/admin/contact/:id", requireAdminPermission("manageContact"), async(c)=>{await fsDelete(c.env,`contactSubmissions/${c.req.param("id")}`);return c.json({ok:true});});

// ---------- messages (client <-> studio) ----------
// Every message document: { uid, email, from: "user" | "admin", text, createdAt }
// A "thread" is simply all messages sharing the same uid (the client's Firebase uid).

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendTransactionalEmail(env, { to, subject, text, preheader = "" }) {
  const recipient = String(to || "").trim().toLowerCase();
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.RESEND_FROM_EMAIL || "").trim();
  if (!recipient) return { sent: false, skipped: true, reason: "No recipient email" };
  if (!apiKey || !from) return { sent: false, skipped: true, reason: "Email provider is not configured" };

  const safeText = String(text || "").trim();
  const safeSubject = String(subject || "ArtCanvas message").trim().slice(0, 200);
  const htmlBody = escapeHtml(safeText).replace(/\n/g, "<br />");
  const html = `<!doctype html><html><body style="margin:0;background:#f7f4ee;font-family:Arial,Helvetica,sans-serif;color:#171717"><div style="max-width:620px;margin:32px auto;padding:0 18px"><div style="background:#fff;border:1px solid #e7e1d8;border-radius:18px;overflow:hidden"><div style="padding:24px 28px;border-bottom:1px solid #eee7de"><div style="font-size:24px;font-weight:700;letter-spacing:-.04em">ArtCanvas<span style="font-size:12px;font-weight:500;letter-spacing:.08em;color:#777"> GALLERY</span></div></div><div style="padding:28px"><div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8b857c;margin-bottom:12px">Message from ArtCanvas</div><div style="font-size:18px;font-weight:600;margin-bottom:18px">${escapeHtml(safeSubject)}</div><div style="font-size:15px;line-height:1.75;color:#444">${htmlBody}</div></div><div style="padding:18px 28px;border-top:1px solid #eee7de;font-size:12px;color:#888">This email was sent from your ArtCanvas member account.</div></div></div></body></html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject: safeSubject,
      text: safeText,
      html,
      ...(preheader ? { headers: { "X-Entity-Ref-ID": preheader.slice(0, 100) } } : {}),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.message || data?.error || `Email provider returned ${response.status}`;
    return { sent: false, skipped: false, reason: String(detail).slice(0, 500) };
  }
  return { sent: true, skipped: false, id: data?.id || null };
}

function cleanMessageText(body) {
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  return text.slice(0, 2000);
}

function sortByCreatedAt(list) {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// Reliable customer notification helper used by order cancellation and payment
// rejection. Older orders may not have uid, so email is used to recover the
// matching user profile before writing the in-app message. Email delivery is
// best-effort and never blocks the order state change.
async function notifyCustomerOrderEvent(env, order, { subject, text, messageType }) {
  const now = new Date().toISOString();
  let uid = String(order?.uid || '').trim();
  let email = String(order?.email || '').trim().toLowerCase();

  if (!uid && email) {
    try {
      const users = await fsList(env, 'users');
      const match = users.find((u) => String(u?.email || '').trim().toLowerCase() === email);
      if (match?.id) uid = match.id;
      if (!email && match?.email) email = String(match.email).trim().toLowerCase();
    } catch (_) {}
  }

  if (!uid) {
    return { sent: false, emailSent: false, reason: 'Customer account could not be matched to this order.' };
  }

  const message = await fsCreate(env, 'messages', {
    uid,
    email,
    from: 'admin',
    text: String(text || '').slice(0, 2000),
    seenByAdmin: true,
    orderId: String(order.id || ''),
    messageType: messageType || 'order_notice',
    createdAt: now,
  });

  let emailResult = { sent: false, skipped: true, reason: 'No email address' };
  if (email) {
    try {
      emailResult = await sendTransactionalEmail(env, {
        to: email,
        subject: subject || 'ArtCanvas order update',
        text: String(text || '').slice(0, 2000),
        preheader: String(order.id || '').slice(-8),
      });
      if (emailResult.sent) {
        await fsPatch(env, `messages/${message.id}`, {
          emailSent: true,
          emailId: emailResult.id || null,
        });
      }
    } catch (e) {
      emailResult = { sent: false, skipped: false, reason: String(e?.message || 'Email notification failed').slice(0, 500) };
    }
  }

  return { sent: true, emailSent: emailResult.sent === true, messageId: message.id, emailReason: emailResult.reason || '' };
}

// Client sends a message to the studio.
app.post("/api/messages", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const text = cleanMessageText(body);
  if (!text) return c.json({ error: "Message text is required" }, 400);

  const message = await fsCreate(c.env, "messages", {
    uid: user.uid,
    email: user.email || "",
    from: "user",
    text,
    seenByAdmin: false,
    createdAt: new Date().toISOString(),
  });
  return c.json(message, 201);
});

// Client reads their own conversation with the studio.
app.get("/api/messages/me", requireAuth, async (c) => {
  const user = c.get("user");
  try {
    const mine = await fsQueryEquals(c.env, "messages", "uid", user.uid);
    return c.json(sortByCreatedAt(mine));
  } catch (err) {
    // Preserve Firestore's quota status so the frontend can handle it as a
    // temporary rate-limit instead of turning every retry into a generic 500.
    const detail = String(err?.message || "");
    if (/429|Quota exceeded|RESOURCE_EXHAUSTED/i.test(detail)) {
      return c.json({ error: "Messages are temporarily rate-limited. Please try again shortly." }, 429);
    }
    throw err;
  }
});

// Admin: list every conversation, most recently active first.
app.get("/api/admin/messages/threads", requireAdminPermission("manageMessages"), async (c) => {
  const all = await fsList(c.env, "messages");
  const byUid = new Map();
  for (const m of all) {
    if (!m.uid) continue;
    const existing = byUid.get(m.uid);
    if (!existing || m.createdAt > existing.lastAt) {
      byUid.set(m.uid, {
        uid: m.uid,
        email: m.email || existing?.email || "",
        lastText: m.text || "",
        lastFrom: m.from || "user",
        lastAt: m.createdAt || "",
        unreadCount: m.from === "user" && m.seenByAdmin !== true ? 1 : 0,
      });
    } else if (!existing.email && m.email) {
      existing.email = m.email;
    }
    if (existing && m.from === "user" && m.seenByAdmin !== true) existing.unreadCount = (existing.unreadCount || 0) + 1;
  }
  const threads = [...byUid.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  return c.json(threads);
});

// Admin: find (or confirm) a client by email so a conversation can be opened
// even before that client has sent a first message.
app.post("/api/admin/messages/lookup", requireAdminPermission("manageMessages"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return c.json({ error: "Email is required" }, 400);

  const matches = await fsQueryEquals(c.env, "users", "email", email);
  const match = matches[0];
  if (!match) {
    return c.json({ error: "No ArtCanvas account found with that email. The customer needs to sign in at least once first." }, 404);
  }
  return c.json({ uid: match.id, email: match.email || email, name: match.name || "" });
});

// Admin: read one client's full conversation.
app.get("/api/admin/messages/:uid", requireAdminPermission("manageMessages"), async (c) => {
  const uid = c.req.param("uid");
  const thread = await fsQueryEquals(c.env, "messages", "uid", uid);
  return c.json(sortByCreatedAt(thread));
});

// Admin marks all customer messages in a thread as seen when opening it.
app.patch("/api/admin/messages/:uid/read", requireAdminPermission("manageMessages"), async (c) => {
  const uid = c.req.param("uid");
  const thread = await fsQueryEquals(c.env, "messages", "uid", uid);
  let updated = 0;
  for (const message of thread) {
    if (message.from === "user" && message.seenByAdmin !== true && message.id) {
      await fsPatch(c.env, `messages/${message.id}`, { seenByAdmin: true });
      updated += 1;
    }
  }
  return c.json({ ok: true, updated });
});

// Admin: reply into a specific client's conversation.
app.delete("/api/admin/messages/:uid/:messageId", requireAdminPermission("manageMessages"), async (c) => {
  const uid = c.req.param("uid");
  const messageId = c.req.param("messageId");
  const message = await fsGet(c.env, `messages/${messageId}`);
  if (!message || message.uid !== uid) return c.json({ error: "Message not found" }, 404);
  await fsDelete(c.env, `messages/${messageId}`);
  return c.json({ ok: true });
});

app.delete("/api/admin/messages/:uid", requireAdminPermission("manageMessages"), async (c) => {
  const uid = c.req.param("uid");
  const thread = await fsQueryEquals(c.env, "messages", "uid", uid);
  for (const message of thread) {
    if (message?.id) await fsDelete(c.env, `messages/${message.id}`);
  }
  return c.json({ ok: true, deleted: thread.length });
});

app.post("/api/admin/messages/:uid", requireAdminPermission("manageMessages"), async (c) => {
  const uid = c.req.param("uid");
  const body = await c.req.json().catch(() => null);
  const text = cleanMessageText(body);
  if (!text) return c.json({ error: "Message text is required" }, 400);

  const profile = await fsGet(c.env, `users/${uid}`);
  const email = profile?.email || (typeof body?.email === "string" ? body.email : "") || "";

  if (!email) return c.json({ error: "This client does not have an email address." }, 400);
  const emailResult = await sendTransactionalEmail(c.env, { to: email, subject: "A message from ArtCanvas", text });
  if (!emailResult.sent) return c.json({ error: emailResult.reason || "Could not send email", emailSent: false }, 503);
  const message = await fsCreate(c.env, "messages", {
    uid,
    email,
    from: "admin",
    text,
    seenByAdmin: true,
    emailSent: true,
    emailId: emailResult.id || null,
    createdAt: new Date().toISOString(),
  });
  return c.json({ ...message, emailSent: true }, 201);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error", detail: String(err.message || err) }, 500);
});

export default app;
