import { PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage, Connection } from "@solana/web3.js";
import { jsonResponse } from "../../../lib/response.js";
import {
  DATA_ONLY_CONFIG_KEY,
  CONFIG_MERKLE_OFFSET,
  KTA_ASSET_OFFSET,
  keyToAssetKey,
  iotInfoKey,
  buildOnboardInstruction,
  buildFullOnboardInstruction,
  fetchAsset,
  fetchAssetProof,
  getCanopyDepth,
} from "../../../lib/helium-solana.js";

/**
 * POST /onboard
 * Body: { owner, gateway_pubkey, location, elevation, gain, mode }
 *   location: H3 resolution-12 cell index as hex string
 *   elevation: altitude in meters (integer)
 *   gain: antenna gain in dBi × 10 (integer)
 *   mode: "full" | "data_only"
 */
export async function handleOnboard(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { owner: ownerStr, gateway_pubkey, location, elevation, gain, mode } = body;
  if (!ownerStr) return jsonResponse({ error: "Missing owner address" }, 400);
  if (!gateway_pubkey) return jsonResponse({ error: "Missing gateway_pubkey" }, 400);
  if (!location) return jsonResponse({ error: "Missing location" }, 400);
  if (elevation === null || elevation === undefined) return jsonResponse({ error: "Missing elevation" }, 400);
  if (gain === null || gain === undefined) return jsonResponse({ error: "Missing gain" }, 400);
  if (mode && mode !== "full" && mode !== "data_only") {
    return jsonResponse({ error: "Invalid mode, must be 'full' or 'data_only'" }, 400);
  }

  let ownerPubkey;
  try {
    ownerPubkey = new PublicKey(ownerStr);
  } catch {
    return jsonResponse({ error: "Invalid owner address" }, 400);
  }

  try {
    const rpcUrl = env.SOLANA_RPC_URL;
    const connection = new Connection(rpcUrl);

    const ktaKey = keyToAssetKey(gateway_pubkey);
    const [ktaAccount, iotInfoAccount, configAccount] = await Promise.all([
      connection.getAccountInfo(ktaKey),
      connection.getAccountInfo(iotInfoKey(gateway_pubkey)),
      connection.getAccountInfo(DATA_ONLY_CONFIG_KEY),
    ]);

    if (!ktaAccount) {
      return jsonResponse({ error: "Gateway not yet issued on-chain. Run issue step first." }, 400);
    }
    if (iotInfoAccount) {
      return jsonResponse({ already_onboarded: true });
    }

    const assetId = new PublicKey(ktaAccount.data.slice(KTA_ASSET_OFFSET, KTA_ASSET_OFFSET + 32)).toBase58();
    const merkleTree = new PublicKey(configAccount.data.slice(CONFIG_MERKLE_OFFSET, CONFIG_MERKLE_OFFSET + 32));

    const [asset, proof, { blockhash }, treeAccount] = await Promise.all([
      fetchAsset(rpcUrl, assetId),
      fetchAssetProof(rpcUrl, assetId),
      connection.getLatestBlockhash(),
      connection.getAccountInfo(merkleTree),
    ]);

    if (!treeAccount) {
      return jsonResponse({ error: "Merkle tree account not found" }, 500);
    }
    const canopyDepth = getCanopyDepth(treeAccount.data);

    const buildFn = mode === "full" ? buildFullOnboardInstruction : buildOnboardInstruction;
    const onboardIx = buildFn(
      ownerPubkey, gateway_pubkey, merkleTree, asset, proof, canopyDepth,
      { location, elevation, gain },
    );

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });

    const message = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, computePriceIx, onboardIx],
    }).compileToLegacyMessage();

    const vtx = new VersionedTransaction(message);

    return jsonResponse({
      already_onboarded: false,
      transaction: Buffer.from(vtx.serialize()).toString("base64"),
    });
  } catch (err) {
    return jsonResponse({ error: `Failed to build onboard transaction: ${err.message}` }, 500);
  }
}
