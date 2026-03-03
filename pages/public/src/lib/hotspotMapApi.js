import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { parseJson } from "./api.js";

export const API_BASE = import.meta.env.DEV
  ? "/api/hotspot-map"
  : "https://api.heliumtools.org/hotspot-map";

const ENTITY_MANAGER_PID = new PublicKey("hemjuPXBpNvggtaUnN1MwT3wrdhttKEfosTcc2P9Pg8");
const SUB_DAOS_PID = new PublicKey("hdaoVTCqhfHHo75XdAMxBKdUqvq1i5bF23sisBqVgGR");
const HNT_MINT = new PublicKey("hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux");

const [DAO] = PublicKey.findProgramAddressSync(
  [Buffer.from("dao"), HNT_MINT.toBuffer()],
  SUB_DAOS_PID
);

/**
 * Derive the keyToAsset PDA for an entity key.
 * Seeds: ["key_to_asset", dao, sha256(bs58decode(entityKey))]
 */
async function deriveKeyToAssetKey(entityKey) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bs58.decode(entityKey))
  );
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("key_to_asset"), DAO.toBuffer(), Buffer.from(hash)],
    ENTITY_MANAGER_PID
  );
  return pda.toBase58();
}

/**
 * POST /resolve — batch resolve entity keys to on-chain locations.
 */
export async function resolveLocations(entityKeys) {
  const res = await fetch(`${API_BASE}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entityKeys }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "Failed to resolve hotspot locations");
  }
  return data;
}

/**
 * Fetch onboarding dates from the Helium Entity API.
 * Derives the keyToAsset PDA and queries the v2 endpoint, which works
 * for both short IoT and long Mobile entity keys.
 * Returns { iot: "ISO string", mobile: "ISO string" } or subset.
 */
const entityDatesCache = new Map();
const DATES_CACHE_MAX = 500;

export async function fetchEntityDates(entityKey) {
  if (entityDatesCache.has(entityKey)) return entityDatesCache.get(entityKey);

  const keyToAssetKey = await deriveKeyToAssetKey(entityKey);
  const res = await fetch(`https://entities.nft.helium.io/v2/hotspot/${keyToAssetKey}`);
  if (!res.ok) return null;

  const data = await res.json();
  const dates = {};
  if (data.hotspot_infos?.iot?.created_at) dates.iot = data.hotspot_infos.iot.created_at;
  if (data.hotspot_infos?.mobile?.created_at) dates.mobile = data.hotspot_infos.mobile.created_at;

  if (entityDatesCache.size >= DATES_CACHE_MAX) {
    entityDatesCache.delete(entityDatesCache.keys().next().value);
  }
  entityDatesCache.set(entityKey, dates);
  return dates;
}

/**
 * GET /wallet — fetch entity keys for a wallet address.
 */
export async function fetchWalletHotspots(address) {
  const query = new URLSearchParams({ address });
  const res = await fetch(`${API_BASE}/wallet?${query.toString()}`);
  const data = await parseJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "Failed to look up wallet");
  }
  return data;
}
