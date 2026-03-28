import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { jsonResponse } from "../../../lib/response.js";
import {
  HELIUM_ENTITY_MANAGER_PROGRAM_ID,
  HELIUM_SUB_DAOS_PROGRAM_ID,
  HNT_MINT,
} from "../../hotspot-claimer/config.js";
import { fetchAccount } from "../../hotspot-claimer/services/common.js";

async function sha256(data) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

function deriveDAO() {
  const [dao] = PublicKey.findProgramAddressSync(
    [Buffer.from("dao"), new PublicKey(HNT_MINT).toBuffer()],
    new PublicKey(HELIUM_SUB_DAOS_PROGRAM_ID),
  );
  return dao;
}

async function deriveKeyToAssetPDA(entityKey) {
  const entityKeyBytes = bs58.decode(entityKey);
  const hash = await sha256(entityKeyBytes);
  const dao = deriveDAO();
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("key_to_asset"), dao.toBuffer(), Buffer.from(hash)],
    new PublicKey(HELIUM_ENTITY_MANAGER_PROGRAM_ID),
  );
  return pda;
}

/**
 * Check on-chain status for a gateway's public key.
 * Returns { onchain, entity_url? }
 */
export async function handleOnchainStatus(pubkey, env) {
  if (!pubkey) {
    return jsonResponse({ error: "Missing pubkey parameter" }, 400);
  }

  try {
    const pda = await deriveKeyToAssetPDA(pubkey);
    const account = await fetchAccount(env, pda);

    if (account) {
      return jsonResponse({
        onchain: true,
        entity_url: `https://world.helium.com/network/iot/hotspot/${pubkey}`,
      });
    }

    return jsonResponse({ onchain: false });
  } catch (err) {
    return jsonResponse({ error: `Failed to check on-chain status: ${err.message}` }, 500);
  }
}

/**
 * Batch check on-chain status for multiple public keys.
 * Accepts POST { pubkeys: string[] }
 */
export async function handleBatchOnchainStatus(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { pubkeys } = body;
  if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
    return jsonResponse({ error: "pubkeys must be a non-empty array" }, 400);
  }

  if (pubkeys.length > 50) {
    return jsonResponse({ error: "Maximum 50 pubkeys per request" }, 400);
  }

  const results = {};
  const checks = pubkeys.map(async (pubkey) => {
    try {
      const pda = await deriveKeyToAssetPDA(pubkey);
      const account = await fetchAccount(env, pda);
      results[pubkey] = {
        onchain: !!account,
        entity_url: account
          ? `https://world.helium.com/network/iot/hotspot/${pubkey}`
          : undefined,
      };
    } catch {
      results[pubkey] = { onchain: false };
    }
  });

  await Promise.allSettled(checks);
  return jsonResponse({ results });
}
