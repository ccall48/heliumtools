import { jsonResponse } from "../../../lib/response.js";
import { resolveEntityKey } from "../services/entity.js";
import { checkIpRateLimit } from "../services/rateLimit.js";
import { MAX_LOOKUPS_PER_MINUTE } from "../config.js";

/**
 * Validate that a string looks like a plausible entity key (base58 encoded, reasonable length).
 */
function isValidEntityKey(key) {
  if (!key || typeof key !== "string") return false;
  if (key.length < 20 || key.length > 600) return false;
  // Base58 character set (no 0, O, I, l)
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(key);
}

/**
 * GET /lookup?entityKey=<base58-encoded-entity-key>
 *
 * Resolves a hotspot entity key to metadata including owner, name, network type, etc.
 */
export async function handleLookup(url, env, request) {
  // Rate limit check
  const rateLimitError = await checkIpRateLimit(env, request, {
    prefix: "rl:lookup",
    maxRequests: MAX_LOOKUPS_PER_MINUTE,
    windowSeconds: 60,
  });
  if (rateLimitError) return rateLimitError;

  const entityKey = url.searchParams.get("entityKey");

  if (!isValidEntityKey(entityKey)) {
    return jsonResponse(
      { error: "Invalid entity key. Must be a base58-encoded hotspot key." },
      400
    );
  }

  try {
    const result = await resolveEntityKey(env, entityKey);

    if (!result) {
      return jsonResponse(
        { error: "Hotspot not found for the given entity key." },
        404
      );
    }

    return jsonResponse(result);
  } catch (err) {
    console.error("Lookup error:", err.message);
    return jsonResponse({ error: "Failed to resolve hotspot." }, 500);
  }
}
