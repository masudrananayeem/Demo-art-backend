// One-off local script to make a user an admin.
// Run: node scripts/setAdmin.js someone@example.com
//
// Uses firebase-admin (Node only — this script never runs inside the Worker).
// Needs the SAME service account JSON as your Worker secrets. Download it from
// Firebase Console -> Project settings -> Service accounts -> Generate new
// private key, and save it as ./serviceAccountKey.json (already gitignored).

import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "node:fs";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/setAdmin.js <email>");
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(new URL("../serviceAccountKey.json", import.meta.url)));

initializeApp({ credential: cert(serviceAccount) });

const user = await getAuth().getUserByEmail(email);
await getAuth().setCustomUserClaims(user.uid, { admin: true });

console.log(`✔ ${email} (uid: ${user.uid}) is now an admin.`);
console.log("They must sign out and sign back in (or refresh their ID token) for it to take effect.");
