# path2json-cloudflare-worker

A minimal Cloudflare Worker that decodes JSON directly from the URL path.

<https://path2json.olliejc.workers.dev/>

## Features
- Supports raw, URL-encoded, Base64, Base32, and hex JSON
- Deterministic: same path → same output
- 64 KB payload limit
- CORS-enabled (GET, HEAD, OPTIONS)
- Caching  
  - Root: 1 hour browser / 1 day edge  
  - JSON: 7 days immutable

# Examples

- <https://path2json.olliejc.workers.dev/7b22636c69656e745f6e616d65223a2274657374696e67227d/client.json>
