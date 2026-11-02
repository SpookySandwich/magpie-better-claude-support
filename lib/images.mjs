import { BridgeError } from "./context.mjs";

const MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function imageBlock(part) {
  let source = part.type === "image" ? part.source : undefined;
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
  if (!source && typeof url === "string") {
    if (url.startsWith("data:")) {
      const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
      if (!match) throw new BridgeError("Invalid inline image.");
      source = { type: "base64", media_type: match[1], data: match[2].replace(/\s/g, "") };
    } else source = { type: "url", url };
  }
  if (source?.type === "base64") {
    if (!MIME.has(source.media_type) || typeof source.data !== "string")
      throw new BridgeError("Unsupported image format; use PNG, JPEG, GIF, or WebP.");
    const data = source.data.replace(/\s/g, "");
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > 28 * 1024 * 1024)
      throw new BridgeError("Invalid or oversized base64 image.");
    return { type: "image", source: { type: "base64", media_type: source.media_type, data } };
  }
  if (source?.type === "url") {
    let parsed;
    try {
      parsed = new URL(source.url);
    } catch {}
    if (
      !parsed ||
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new BridgeError("Expected an HTTP image URL or inline image data.");
    return { type: "image", source: { type: "url", url: parsed.href } };
  }
  throw new BridgeError("Invalid image content.");
}
