// Generates a signature for a *signed* Cloudinary upload so the API secret
// never has to live in the frontend. The browser then uploads the file
// directly to Cloudinary using this signature (backend never touches the
// image bytes, keeping the Worker fast and cheap).

async function sha1Hex(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildCloudinarySignature(env, folderOverride) {
  if (!env.CLOUDINARY_API_SECRET || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME === "your-cloudinary-cloud-name") {
    throw new Error(
      "Missing/placeholder Cloudinary config. Set CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET (in .dev.vars for local dev, or via `wrangler secret put` for production) and set CLOUDINARY_CLOUD_NAME in wrangler.toml [vars] to your real cloud name."
    );
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = folderOverride || env.CLOUDINARY_FOLDER || "artcanvas/products";
  const params = { timestamp, folder };

  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  const signature = await sha1Hex(toSign + env.CLOUDINARY_API_SECRET);

  return {
    signature,
    timestamp,
    folder,
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  };
}
