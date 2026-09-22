# Art-Canvas-backend

Cloudflare Worker API (built with [Hono](https://hono.dev)) for the ArtCanvas store.

- **Database:** Firebase Firestore, accessed over the REST API using a Google
  service-account (signed with Web Crypto — no Node SDK, so it runs on
  Workers).
- **Auth:** Firebase Authentication. The frontend signs users in with the
  Firebase client SDK and sends the ID token as `Authorization: Bearer <token>`.
  This Worker verifies that token itself (also with Web Crypto).
- **Images:** Cloudinary. This Worker only hands the frontend a *signed
  upload signature* — the actual image bytes go straight from the browser to
  Cloudinary, so the Worker stays fast and your Cloudinary secret never
  leaves the server.
- **Admin:** a Firebase custom claim `admin: true` on the user's account.
  Set with `scripts/setAdmin.js`.

## 1. Firebase project

1. Create a project at https://console.firebase.google.com.
2. **Build → Authentication → Get started** → enable **Email/Password** (and
   **Google**, optional) sign-in providers.
3. **Build → Firestore Database → Create database** (production mode is
   fine — this Worker talks to Firestore as an admin via a service account,
   so it bypasses security rules; you can leave the default rules as
   "deny all" since the browser never talks to Firestore directly).
4. **Project settings (gear icon) → Service accounts → Generate new private
   key**. This downloads a JSON file — you'll need three values out of it:
   `project_id`, `client_email`, `private_key`.
5. **Project settings → General → Your apps → Add app → Web**. Copy the
   `firebaseConfig` object — you'll paste this into the *frontend* `.env`.

## 2. Cloudinary

1. Create a free account at https://cloudinary.com.
2. From the Dashboard, copy **Cloud name**, **API Key**, and **API Secret**.
   No upload preset needed — signed uploads use the signature this Worker
   generates.

## 3. Configure this Worker

```bash
cd Art-Canvas-backend
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with the Firebase service-account `client_email` /
`private_key`, and the Cloudinary API key/secret.

Edit `wrangler.toml` → `[vars]`:

- `FIREBASE_PROJECT_ID` — your Firebase project ID
- `ALLOWED_ORIGINS` — comma-separated list of frontend origins allowed to
  call this API (your Cloudflare Pages URL + `http://localhost:5173` for dev)
- `CLOUDINARY_CLOUD_NAME` — your Cloudinary cloud name

## 3.5 Configure member email delivery (Resend)

Admin messages to members are sent through Resend from the backend, so the Resend API key never reaches the browser. The Worker calls Resend's email API directly.

Add these values to `.dev.vars` for local development:

```bash
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
RESEND_FROM_EMAIL=ArtCanvas <noreply@your-verified-domain.com>
```

For production, set them as Cloudflare Worker secrets:

```bash
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_FROM_EMAIL
```

The sender address/domain must be allowed by your Resend account. Resend documents direct REST email sending and Cloudflare Workers integration.

## 4. Run locally

```bash
npm run dev
```

The API comes up on `http://localhost:8787`.

## 5. Make yourself an admin

```bash
# Save the service account JSON (step 1.4) as ./serviceAccountKey.json
npm run set-admin -- you@example.com
```

Sign out and back in on the frontend afterwards so your browser picks up the
new `admin` claim on your ID token.

## 6. Deploy to Cloudflare Workers

```bash
npx wrangler login
wrangler secret put FIREBASE_CLIENT_EMAIL
wrangler secret put FIREBASE_PRIVATE_KEY     # paste the whole key, including BEGIN/END lines
wrangler secret put CLOUDINARY_API_KEY
wrangler secret put CLOUDINARY_API_SECRET
npm run deploy
```

Wrangler prints your live URL, e.g. `https://art-canvas-backend.<you>.workers.dev`.
Put that URL in the frontend's `VITE_API_BASE_URL` env var.

## Troubleshooting

**`Cloud Firestore API has not been used in project your-firebase-project-id...` / `FIREBASE_PROJECT_ID is not set...`**
This means `wrangler.toml` still has the placeholder project ID. This
happens most often when you replace this whole folder with a newer version
of the code — `wrangler.toml` gets reset to its defaults, wiping out the
real project ID/Cloudinary cloud name you had set before. **Every time you
replace this folder, re-open `wrangler.toml` and re-enter your real
`FIREBASE_PROJECT_ID`, `CLOUDINARY_CLOUD_NAME`, and `ALLOWED_ORIGINS`
under `[vars]`, then restart `wrangler dev`.** (`.dev.vars` isn't affected
by this — only `wrangler.toml`.)

**`Cannot read properties of undefined (reading 'replace')` / 500 on `/api/products`**
This means the Worker can't see `FIREBASE_PRIVATE_KEY` (and usually
`FIREBASE_CLIENT_EMAIL`). Almost always the cause is one of:
1. There's no `.dev.vars` file yet — run `cp .dev.vars.example .dev.vars`
   inside `Art-Canvas-backend`, then **fill in the real values**.
2. The file is misnamed (must be exactly `.dev.vars`, not
   `.dev.vars.example` or `.dev.vars.txt`) and must sit in the
   `Art-Canvas-backend` root, next to `wrangler.toml`.
3. `wrangler dev` was already running when you created/edited `.dev.vars`
   — stop it (Ctrl+C) and start it again; env vars are only loaded at
   startup.

You can sanity-check what the Worker sees (without exposing secret
values) by opening `http://localhost:8787/` — it reports which vars it
detected as `true`/`false`.

**Deployed on Cloudflare but getting the same error**
Production Workers don't read `.dev.vars` — you must set each secret with
`wrangler secret put NAME` (see step 6 above) and then `npm run deploy`
again.

**CORS errors in the browser console**
Make sure your frontend's actual origin (e.g.
`http://localhost:5173` or your Pages URL) is listed in
`ALLOWED_ORIGINS` in `wrangler.toml`, then restart/redeploy the Worker.

## About payments

Checkout collects a shipping address and a payment method: **Cash on
Delivery**, or **bKash / Nagad** (the customer enters the transaction ID
from their manual send-money, which you verify yourself before shipping).
This backend does not process card payments — wiring up a real card
gateway (Stripe, SSLCommerz, etc.) needs your own merchant account and API
keys, which weren't part of this build. If you want that added later, the
order-creation endpoint (`POST /api/orders`) is the place to plug it in.

## API reference

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/products` | public | List products (stock hidden, `inStock` boolean instead) |
| GET | `/api/products/:id` | public | One product |
| GET | `/api/categories` | public | List all categories (5 built-in + any admin-added ones) |
| POST | `/api/admin/categories` | admin | Add a new category (`{name}` — id is auto-slugged from the name) |
| DELETE | `/api/admin/categories/:id` | admin | Delete a category. Built-in categories can't be deleted; a custom one can't be deleted while products still use it |
| GET | `/api/subcategories` | public | List Women/Men/Kids clothing sub-categories (built-in + admin-added) |
| POST | `/api/admin/subcategories` | admin | Add a sub-category (`{gender, name}`, gender is `women`/`men`/`kids`) |
| DELETE | `/api/admin/subcategories` | admin | Remove a sub-category (`{gender, name}`). Built-in ones can't be removed; a custom one can't be removed while products still use it |
| GET | `/api/admin/products` | admin | List products with real stock counts |
| POST | `/api/admin/products` | admin | Create a product (`isFeatured` puts it on the homepage rail) |
| PATCH | `/api/admin/products/:id` | admin | Update a product (price, stock, category, image, featured, ...) |
| DELETE | `/api/admin/products/:id` | admin | Delete a product |
| POST | `/api/admin/cloudinary-signature` | admin | Signed upload for a product photo (`{context:"product"}`) or the homepage hero image (`{context:"site"}`) |
| POST | `/api/cloudinary-signature` | user | Signed upload for the current user's own profile photo |
| GET | `/api/site-content` | public | Homepage hero image/headline/tagline |
| PATCH | `/api/admin/site-content` | admin | Update the homepage hero image/headline/tagline |
| GET | `/api/me` | user | Current user's profile (name, phone, address, photo, admin flag) |
| PATCH | `/api/me` | user | Update the current user's own profile |
| POST | `/api/orders` | user | Place an order: `{ items: [{id, qty}], shipping: {fullName, phone, line1, line2?, city, state?, zip?, country?}, paymentMethod: "cod"\|"bkash"\|"nagad", paymentRef? }`. Validates & decrements real stock. |
| GET | `/api/orders/me` | user | Current user's purchase history |
| GET | `/api/admin/orders` | admin | All orders |
#   D e m o - a r t - b a c k e n d  
 