// Serve a bundled HTML file (e.g., via Wrangler's module import)
import html from './index.html';

export default {
  async fetch(request, env) {
    // Preflight: allow CORS pre-checks to return quickly
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    // Reject non-read methods early (simple API surface)
    if (request.method !== "GET" && request.method !== "HEAD")
      return json({ error: "Method not allowed" }, 405);

    const url = new URL(request.url);

    // Split path into clean segments, trimming leading/trailing slashes
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    // Serve the landing page for root or explicit /index.html
    if (["/", "/index.html"].includes(url.pathname)) {
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600, s-maxage=86400'
        }
      });
    }

    // Any path segment that *might* begin a payload we can decode/parse
    // - "{" or URL-encoded variants for JSON
    // - "pm"/"ey" for common base32/base64url JSON prefixes
    // - "7b" for hex-encoded '{'
    const START_PREFIXES = ["{", "%7b", "7b", "pm", "ey"];

    // Find the first segment that looks like the start of an encoded JSON blob
    let startIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].toLowerCase();
      if (START_PREFIXES.some(prefix => p.startsWith(prefix))) {
        startIdx = i;
        break;
      }
    }

    // No plausible start → fail fast with a helpful message
    if (startIdx === -1) return json({ error: "No JSON-like segment found" }, 400);

    // Accumulate segments progressively to allow payloads that span multiple path parts
    // e.g. /eyJ/.../rest → try "eyJ", then "eyJ/...", etc.
    let accumulated = "";
    for (let endIdx = startIdx; endIdx < parts.length; endIdx++) {
      accumulated = accumulated ? `${accumulated}/${parts[endIdx]}` : parts[endIdx];

      const parsed = tryParseJson(accumulated);
      if (parsed.ok) {
        // Upper bound to prevent abuse / excessive memory CPU
        if (parsed.rawText.length > 64_000)
          return json({ error: "Payload too large" }, 413);

        // Success: echo parsed JSON
        return json(parsed.value);
      }
    }

    // Exhausted all accumulations without success
    return json({ error: "Could not parse a valid JSON document from the path" }, 400);
  },
};

// --- Utilities ---

// Uniform failure shape for parser attempts
function fail() { return { ok: false }; }

// Try a series of decoding strategies, first hit wins.
// Order matters: cheap/likely decodes first.
function tryParseJson(input) {
  const attempts = [];

  // 1) URL-decoded → JSON
  attempts.push(() => {
    const text = safeDecodeURIComponent(input);
    return text ? parseJson(text, text) : fail();
  });

  // 2) Raw JSON as-is
  attempts.push(() => parseJson(input, input));

  // 3) base64url (common for compact URL-safe payloads)
  attempts.push(() => {
    const raw = stripNonB64Url(input);
    if (!looksLikeB64Prefix(raw)) return fail();
    const text = b64urlToUtf8(raw);
    return text ? parseJson(text, text) : fail();
  });

  // 4) Standard base64
  attempts.push(() => {
    const raw = stripNonB64Std(input);
    if (!looksLikeB64Prefix(raw)) return fail();
    const text = b64StdToUtf8(raw);
    return text ? parseJson(text, text) : fail();
  });

  // 5) Base32 (seen in some URL-safe encodings)
  attempts.push(() => {
    const raw = stripNonBase32(input);
    if (!looksLikeBase32Prefix(raw)) return fail();
    const text = base32ToUtf8(raw);
    return text ? parseJson(text, text) : fail();
  });

  // 6) Hex-encoded UTF-8 (e.g., "7b..." for '{')
  attempts.push(() => {
    const raw = stripNonHex(input);
    if (!looksLikeHexPrefix(raw)) return fail();
    const text = hexToUtf8(raw);
    return text ? parseJson(text, text) : fail();
  });

  // Run attempts in order; return first success
  for (const f of attempts) {
    const r = f();
    if (r.ok) return r;
  }
  return fail();
}

// Parse JSON and ensure an object/array (ignore primitives)
function parseJson(text, rawText) {
  try {
    const val = JSON.parse(text);
    if (val && typeof val === "object") return { ok: true, value: val, rawText };
  } catch (_) {}
  return fail();
}

// Decode but don't throw on malformed escapes
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch (_) { return null; }
}

// Heuristic: base64url/standard payloads for JSON often start with "ey" ("{": 0x7B → "ey...")
function looksLikeB64Prefix(s) {
  const lower = s.slice(0, 2).toLowerCase();
  return ["ey"].includes(lower);
}

// Base32 encodings of "{" commonly start with "pm"/"on"/"em" (heuristic, not exhaustive)
function looksLikeBase32Prefix(s) {
  const lower = s.slice(0, 2).toLowerCase();
  return ["pm", "on", "em"].includes(lower);
}

// Hex string for '{' begins with "7b"
function looksLikeHexPrefix(s) {
  const lower = s.slice(0, 2).toLowerCase();
  return lower === "7b";
}

// --- Decoders ---

// Keep only characters valid for each alphabet; tolerate separators/junk
function stripNonB64Url(s) { return (s.match(/[A-Za-z0-9\-_]/g) || []).join(""); }
function stripNonB64Std(s) { return (s.match(/[A-Za-z0-9+/=]/g) || []).join(""); }
function stripNonBase32(s) { return (s.match(/[A-Z2-7=]/gi) || []).join(""); }
function stripNonHex(s) { return (s.match(/[A-Fa-f0-9]/g) || []).join(""); }

// Base64 padding helper (length multiple of 4)
function padBase64(s) {
  const rem = s.length % 4;
  return rem ? s + "=".repeat(4 - rem) : s;
}

// base64url → UTF-8 text
function b64urlToUtf8(s) {
  try {
    const padded = padBase64(s.replace(/-/g, "+").replace(/_/g, "/"));
    return utf8FromBytes(atob(padded));
  } catch (_) { return null; }
}

// standard base64 → UTF-8 text
function b64StdToUtf8(s) {
  try {
    const padded = padBase64(s);
    return utf8FromBytes(atob(padded));
  } catch (_) { return null; }
}

// Base32 (RFC 4648) → UTF-8 text (drops partial trailing bits)
function base32ToUtf8(s) {
  try {
    const cleaned = s.toUpperCase().replace(/=+$/, "");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const ch of cleaned) {
      const val = alphabet.indexOf(ch);
      if (val === -1) continue; // skip non-alphabet after strip (defensive)
      bits += val.toString(2).padStart(5, "0");
    }
    const bytes = bits.match(/.{8}/g)?.map(b => parseInt(b, 2)) || [];
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch (_) { return null; }
}

// Hex string → UTF-8 text (truncate odd nibble)
function hexToUtf8(s) {
  try {
    if (s.length % 2 !== 0) s = s.slice(0, s.length - 1);
    const bytes = new Uint8Array(s.match(/.{2}/g).map(h => parseInt(h, 16)));
    return new TextDecoder().decode(bytes);
  } catch (_) { return null; }
}

// Convert binary string or Uint8Array into UTF-8 text
function utf8FromBytes(binStr) {
  if (typeof binStr === "string") {
    const arr = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) arr[i] = binStr.charCodeAt(i);
    return new TextDecoder("utf-8").decode(arr);
  }
  return new TextDecoder("utf-8").decode(binStr);
}

// JSON response helper with consistent headers, pretty-printed body
function json(body, status = 200) {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        'cache-control': "public, immutable, max-age=86400, s-maxage=86400",
        ...corsHeaders(),
      },
    },
  );
}

// Permissive CORS: suitable for public GET endpoints; tighten for auth’d APIs
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
}
