import { PublicKey } from "@solana/web3.js";
import {
  LAZY_DISTRIBUTOR_PROGRAM_ID,
  IOT_MINT,
  MOBILE_MINT,
  HNT_MINT,
  TOKENS,
} from "../config.js";

/**
 * Derive the lazy distributor PDA for a given rewards mint.
 * Seeds: ["lazy_distributor", mint]
 */
function deriveLazyDistributor(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lazy_distributor"), new PublicKey(mint).toBuffer()],
    new PublicKey(LAZY_DISTRIBUTOR_PROGRAM_ID)
  );
  return pda;
}

/**
 * Derive the recipient PDA for a hotspot asset under a lazy distributor.
 * Seeds: ["recipient", lazyDistributor, asset]
 */
function deriveRecipient(lazyDistributor, asset) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("recipient"),
      lazyDistributor.toBuffer(),
      new PublicKey(asset).toBuffer(),
    ],
    new PublicKey(LAZY_DISTRIBUTOR_PROGRAM_ID)
  );
  return pda;
}

/**
 * Parse the LazyDistributorV0 account data.
 *
 * Layout (after 8-byte Anchor discriminator):
 *   version:         u16    (2 bytes, LE)
 *   rewards_mint:    Pubkey (32 bytes)
 *   rewards_escrow:  Pubkey (32 bytes)
 *   authority:       Pubkey (32 bytes)
 *   oracles:         Vec<OracleConfigV0> (4-byte LE length + items)
 *     each item:
 *       oracle:      Pubkey (32 bytes)
 *       url:         String (4-byte LE length + UTF-8 data)
 *   bump_seed:       u8
 *   approver:        Option<Pubkey> (1 byte tag + 32 bytes if Some)
 */
function parseLazyDistributor(data) {
  let offset = 8; // skip discriminator

  // version: u16
  const version = data.readUInt16LE(offset);
  offset += 2;

  // rewards_mint: Pubkey
  const rewardsMint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  // rewards_escrow: Pubkey
  offset += 32; // skip

  // authority: Pubkey
  offset += 32; // skip

  // oracles: Vec<OracleConfigV0>
  const oracleCount = data.readUInt32LE(offset);
  offset += 4;

  const oracles = [];
  for (let i = 0; i < oracleCount; i++) {
    const oracle = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    const urlLen = data.readUInt32LE(offset);
    offset += 4;
    const url = data.slice(offset, offset + urlLen).toString("utf-8");
    offset += urlLen;

    oracles.push({ oracle, url });
  }

  return { version, rewardsMint, oracles };
}

/**
 * Parse the RecipientV0 account data.
 *
 * Layout (after 8-byte discriminator):
 *   lazy_distributor:      Pubkey (32 bytes)
 *   asset:                 Pubkey (32 bytes)
 *   total_rewards:         u64    (8 bytes, LE)
 *   current_config_version: u16   (2 bytes, LE)
 *   current_rewards:       Vec<Option<u64>> (4-byte len + items)
 *   bump_seed:             u8
 *   reserved:              u64    (8 bytes)
 *   destination:           Pubkey (32 bytes)
 */
function parseRecipient(data) {
  let offset = 8; // skip discriminator

  offset += 32; // lazy_distributor
  offset += 32; // asset

  const totalRewards = data.readBigUInt64LE(offset);
  offset += 8;

  // current_config_version: u16
  offset += 2;

  // current_rewards: Vec<Option<u64>>
  const vecLen = data.readUInt32LE(offset);
  offset += 4;
  for (let i = 0; i < vecLen; i++) {
    const tag = data.readUInt8(offset);
    offset += 1;
    if (tag === 1) {
      offset += 8; // skip u64 value for Some variant
    }
  }

  // bump_seed: u8
  offset += 1;

  // reserved: u64
  offset += 8;

  // destination: Pubkey (32 bytes)
  let destination = null;
  if (offset + 32 <= data.length) {
    const destBytes = data.slice(offset, offset + 32);
    // Check if it's the zero/default pubkey (all zeros = no custom recipient)
    const isZero = destBytes.every((b) => b === 0);
    if (!isZero) {
      destination = new PublicKey(destBytes).toBase58();
    }
  }

  return { totalRewards, destination };
}

/**
 * Fetch and parse a Solana account.
 */
async function fetchAccount(env, pubkey) {
  const response = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pubkey.toBase58(), { encoding: "base64" }],
    }),
  });
  const result = await response.json();
  if (!result.result?.value) return null;
  return Buffer.from(result.result.value.data[0], "base64");
}

/**
 * Check if an ATA (Associated Token Account) exists.
 */
async function checkATAExists(env, owner, mint) {
  // Derive ATA address
  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
  );

  const [ata] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const response = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [ata.toBase58(), { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const result = await response.json();
  return result.result?.value !== null;
}

/**
 * Query an oracle for the current lifetime rewards of an asset.
 */
async function queryOracle(oracleUrl, assetId) {
  const url = `${oracleUrl}?assetId=${assetId}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Oracle ${oracleUrl} returned ${response.status}`);
  }
  const data = await response.json();
  return data.currentRewards;
}

/**
 * Get pending rewards for a single token type.
 */
async function getTokenRewards(env, tokenKey, assetId, owner) {
  const tokenConfig = TOKENS[tokenKey];
  const lazyDistPDA = deriveLazyDistributor(tokenConfig.mint);

  // Fetch the lazy distributor account to get oracle URLs
  const ldData = await fetchAccount(env, lazyDistPDA);
  if (!ldData) {
    return { pending: "0", claimable: false, reason: "no_distributor" };
  }

  const ld = parseLazyDistributor(ldData);

  // Query each oracle for lifetime rewards
  const oracleRewards = await Promise.all(
    ld.oracles.map(async (o) => {
      try {
        const rewards = await queryOracle(o.url, assetId);
        return { oracleKey: o.oracle, currentRewards: rewards };
      } catch {
        return null;
      }
    })
  );
  const validRewards = oracleRewards.filter(Boolean);

  if (validRewards.length === 0) {
    return { pending: "0", claimable: false, reason: "no_oracle_response" };
  }

  // Take the median of oracle responses
  const sorted = validRewards
    .map((r) => BigInt(r.currentRewards))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const medianLifetime = sorted[Math.floor(sorted.length / 2)];

  // Fetch the recipient account to see how much has already been claimed
  const recipientPDA = deriveRecipient(lazyDistPDA, assetId);
  const recipientData = await fetchAccount(env, recipientPDA);
  let totalClaimed = 0n;
  let destination = null;
  if (recipientData) {
    const recipient = parseRecipient(recipientData);
    totalClaimed = recipient.totalRewards;
    destination = recipient.destination;
  }

  const pending = medianLifetime - totalClaimed;
  if (pending <= 0n) {
    return {
      pending: "0",
      claimable: false,
      reason: "no_pending",
      decimals: tokenConfig.decimals,
      label: tokenConfig.label,
      destination,
    };
  }

  // Check ATA for the actual reward recipient (destination if set, else owner)
  const ataOwner = destination || owner;
  const ataExists = await checkATAExists(env, ataOwner, tokenConfig.mint);
  if (!ataExists) {
    return {
      pending: pending.toString(),
      claimable: false,
      reason: "no_ata",
      decimals: tokenConfig.decimals,
      label: tokenConfig.label,
      destination,
    };
  }

  return {
    pending: pending.toString(),
    claimable: true,
    recipientExists: !!recipientData,
    decimals: tokenConfig.decimals,
    label: tokenConfig.label,
    destination,
    oracleRewards: validRewards.map((r) => ({
      oracleKey: r.oracleKey.toBase58(),
      currentRewards: r.currentRewards,
    })),
    lazyDistributor: lazyDistPDA.toBase58(),
    recipientKey: recipientPDA.toBase58(),
  };
}

/**
 * Get pending rewards across all token types for a hotspot.
 */
export async function getPendingRewards(env, assetId, owner) {
  const results = {};

  // Query rewards for all token types in parallel
  const [iot, mobile, hnt] = await Promise.all([
    getTokenRewards(env, "iot", assetId, owner).catch((err) => ({
      pending: "0",
      claimable: false,
      reason: "error",
      error: err.message,
    })),
    getTokenRewards(env, "mobile", assetId, owner).catch((err) => ({
      pending: "0",
      claimable: false,
      reason: "error",
      error: err.message,
    })),
    getTokenRewards(env, "hnt", assetId, owner).catch((err) => ({
      pending: "0",
      claimable: false,
      reason: "error",
      error: err.message,
    })),
  ]);

  results.iot = iot;
  results.mobile = mobile;
  results.hnt = hnt;

  return results;
}
