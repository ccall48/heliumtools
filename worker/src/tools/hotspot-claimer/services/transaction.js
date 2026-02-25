import {
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
  Keypair,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  LAZY_DISTRIBUTOR_PROGRAM_ID,
  REWARDS_ORACLE_PROGRAM_ID,
  HELIUM_COMMON_LUT,
  TOKENS,
} from "../config.js";

// Well-known program IDs
const SPL_TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const SPL_ACCOUNT_COMPRESSION = new PublicKey(
  "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK"
);
const SPL_NOOP_PROGRAM = new PublicKey(
  "noopb9bkMVfRPU8AsBRBV2dZiiXcnXBrEPs4auQs1Q6"
);
const CIRCUIT_BREAKER_PROGRAM = new PublicKey(
  "circAbx64bbsscPbQzZAUvuXpHqrCe6fLMzc2uKXz9g"
);

const LAZY_DIST_PID = new PublicKey(LAZY_DISTRIBUTOR_PROGRAM_ID);
const REWARDS_ORACLE_PID = new PublicKey(REWARDS_ORACLE_PROGRAM_ID);

/**
 * Compute Anchor 8-byte discriminator: sha256("global:<name>")[0..8]
 */
async function anchorDiscriminator(name) {
  const data = new TextEncoder().encode(`global:${name}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash).slice(0, 8);
}

/**
 * Encode setCurrentRewardsWrapperV1 args.
 * Args: { oracle_index: u16, current_rewards: u64 }
 */
function encodeSetRewardsArgs(oracleIndex, currentRewards) {
  const buf = Buffer.alloc(10); // 2 + 8
  buf.writeUInt16LE(oracleIndex, 0);
  buf.writeBigUInt64LE(BigInt(currentRewards), 2);
  return buf;
}

/**
 * Encode distributeCompressionRewardsV0 args.
 * Args: { data_hash: [u8;32], creator_hash: [u8;32], root: [u8;32], index: u32 }
 */
function encodeDistributeArgs(dataHash, creatorHash, root, index) {
  const buf = Buffer.alloc(100); // 32 + 32 + 32 + 4
  Buffer.from(dataHash).copy(buf, 0);
  Buffer.from(creatorHash).copy(buf, 32);
  Buffer.from(root).copy(buf, 64);
  buf.writeUInt32LE(index, 96);
  return buf;
}

/**
 * Derive ATA address.
 */
function deriveATA(owner, mint) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  );
  return ata;
}

/**
 * Derive the oracle signer PDA (from rewards oracle program).
 */
function deriveOracleSigner() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_signer")],
    REWARDS_ORACLE_PID
  );
  return pda;
}

/**
 * Derive lazy distributor PDA.
 */
function deriveLazyDistributor(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lazy_distributor"), mint.toBuffer()],
    LAZY_DIST_PID
  );
  return pda;
}

/**
 * Derive recipient PDA.
 */
function deriveRecipient(lazyDistributor, asset) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("recipient"),
      lazyDistributor.toBuffer(),
      asset.toBuffer(),
    ],
    LAZY_DIST_PID
  );
  return pda;
}

/**
 * Derive circuit breaker PDA.
 */
function deriveCircuitBreaker(tokenAccount) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("account_windowed_breaker"), tokenAccount.toBuffer()],
    CIRCUIT_BREAKER_PROGRAM
  );
  return pda;
}

/**
 * Fetch asset proof from DAS API (Helius).
 */
async function fetchAssetProof(env, assetId) {
  const resp = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAssetProof",
      params: { id: assetId },
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`getAssetProof: ${data.error.message}`);
  return data.result;
}

/**
 * Fetch asset metadata from DAS API.
 */
async function fetchAsset(env, assetId) {
  const resp = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAsset",
      params: { id: assetId },
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`getAsset: ${data.error.message}`);
  return data.result;
}

/**
 * Fetch Merkle tree canopy depth by reading the account header.
 *
 * SPL Concurrent Merkle Tree account layout:
 *   Application header:   2 bytes (version + padding)
 *   max_buffer_size:       4 bytes (u32 LE)
 *   max_depth:             4 bytes (u32 LE)
 *   authority:            32 bytes
 *   creation_slot:         8 bytes
 *   padding:               6 bytes
 *   -------- total header: 56 bytes --------
 *   changelog:             maxBufferSize * (32 + 4 + maxDepth * 32) bytes
 *   rightmost_proof:       maxDepth * 32 bytes
 *   canopy:                remaining bytes
 *
 * Note: the CMT does NOT store all tree node hashes. Only changelog,
 * rightmost proof, and canopy are stored in the account.
 */
async function fetchCanopyDepth(env, merkleTreePubkey) {
  // Fetch header bytes (first 16 bytes) + account length via dataSlice
  const resp = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [
        merkleTreePubkey,
        { encoding: "base64", dataSlice: { offset: 0, length: 16 } },
      ],
    }),
  });
  const data = await resp.json();
  if (!data.result?.value) return 0;

  const buf = Buffer.from(data.result.value.data[0], "base64");
  const accountLength = data.result.value.data[1] === "base64"
    ? data.result.value.data[0].length * 3 / 4 // approximate, but we need exact
    : 0;

  // We need the full account length. dataSlice doesn't tell us total size,
  // so use the account lamports / rent relationship or fetch metadata.
  // Simpler: use getAccountInfo without dataSlice but only read header.
  const fullResp = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [merkleTreePubkey, { encoding: "base64" }],
    }),
  });
  const fullData = await fullResp.json();
  if (!fullData.result?.value) return 0;
  const fullBuf = Buffer.from(fullData.result.value.data[0], "base64");

  // Parse header
  const headerOffset = 2; // application header
  const maxBufferSize = fullBuf.readUInt32LE(headerOffset);
  const maxDepth = fullBuf.readUInt32LE(headerOffset + 4);

  // Compute canopy from remaining space after header + changelog + rightmost proof
  const CMT_HEADER = 56;
  const changelogEntrySize = 32 + 4 + maxDepth * 32;
  const changelog = maxBufferSize * changelogEntrySize;
  const rightmostProof = maxDepth * 32;
  const totalBeforeCanopy = CMT_HEADER + changelog + rightmostProof;

  if (fullBuf.length <= totalBeforeCanopy) return 0;
  const canopyBytes = fullBuf.length - totalBeforeCanopy;
  const canopyNodes = Math.floor(canopyBytes / 32);
  if (canopyNodes <= 0) return 0;
  // A canopy of depth d stores 2^(d+1) - 2 nodes
  const canopyDepth = Math.floor(Math.log2(canopyNodes + 2)) - 1;
  return Math.max(0, canopyDepth);
}

/**
 * Fetch the Helium Address Lookup Table for V0 transaction compression.
 */
async function fetchLookupTable(env) {
  try {
    const resp = await fetch(env.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [HELIUM_COMMON_LUT, { encoding: "base64" }],
      }),
    });
    const data = await resp.json();
    if (!data.result?.value) return null;

    const accountData = Buffer.from(data.result.value.data[0], "base64");
    const state = AddressLookupTableAccount.deserialize(accountData);
    return new AddressLookupTableAccount({
      key: new PublicKey(HELIUM_COMMON_LUT),
      state,
    });
  } catch (err) {
    console.error("LUT fetch/deserialize failed:", err.message);
    return null;
  }
}

/**
 * Fetch a recent blockhash.
 */
async function getRecentBlockhash(env) {
  const resp = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestBlockhash",
      params: [{ commitment: "confirmed" }],
    }),
  });
  const data = await resp.json();
  return data.result.value.blockhash;
}

/**
 * Parse the LazyDistributorV0 to get rewards_escrow.
 */
function parseRewardsEscrow(accountData) {
  let offset = 8; // discriminator
  offset += 2; // version
  offset += 32; // rewards_mint
  const escrow = new PublicKey(accountData.slice(offset, offset + 32));
  return escrow;
}

/**
 * Build and broadcast a claim transaction for a single token.
 * Returns { txSignature, amount } on success.
 */
export async function claimRewardsForToken(
  env,
  tokenKey,
  assetId,
  owner,
  keyToAssetKey,
  oracleRewards,
  destination,
  recipientExists = true
) {
  const tokenConfig = TOKENS[tokenKey];
  const mint = new PublicKey(tokenConfig.mint);
  const assetPk = new PublicKey(assetId);
  const ownerPk = new PublicKey(owner);
  const keyToAssetPk = new PublicKey(keyToAssetKey);

  // When destination is set, rewards go to destination address, not owner
  const rewardRecipientPk = destination
    ? new PublicKey(destination)
    : ownerPk;

  const lazyDistributor = deriveLazyDistributor(mint);
  const recipient = deriveRecipient(lazyDistributor, assetPk);
  const oracleSigner = deriveOracleSigner();

  // Fetch the lazy distributor account to get rewards_escrow
  const ldResp = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [lazyDistributor.toBase58(), { encoding: "base64" }],
    }),
  });
  const ldData = await ldResp.json();
  const ldBuf = Buffer.from(ldData.result.value.data[0], "base64");
  const rewardsEscrow = parseRewardsEscrow(ldBuf);
  const circuitBreaker = deriveCircuitBreaker(rewardsEscrow);
  const destinationATA = deriveATA(rewardRecipientPk, mint);

  // Get payer keypair from env (supports both JSON byte array and base58 formats)
  const rawKey = env.HOTSPOT_CLAIM_PAYER_WALLET_PRIVATE_KEY;
  let secretKey;
  if (rawKey.startsWith("[")) {
    secretKey = Uint8Array.from(JSON.parse(rawKey));
  } else {
    secretKey = bs58.decode(rawKey);
  }
  const payerKeypair = Keypair.fromSecretKey(secretKey);

  // Build setCurrentRewardsWrapperV1 instructions (one per oracle)
  const setRewardsDiscriminator = await anchorDiscriminator(
    "set_current_rewards_wrapper_v1"
  );

  const setRewardsIxs = oracleRewards.map((oracleReward, idx) => {
    const oracleKey = new PublicKey(oracleReward.oracleKey);
    const args = encodeSetRewardsArgs(idx, oracleReward.currentRewards);

    return new TransactionInstruction({
      programId: REWARDS_ORACLE_PID,
      keys: [
        { pubkey: oracleKey, isSigner: true, isWritable: true },
        { pubkey: lazyDistributor, isSigner: false, isWritable: false },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: keyToAssetPk, isSigner: false, isWritable: false },
        { pubkey: oracleSigner, isSigner: false, isWritable: false },
        { pubkey: LAZY_DIST_PID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([setRewardsDiscriminator, args]),
    });
  });

  // Fetch compression data (needed for both init and distribute in standard path)
  let asset, assetProof, merkleTree, canopyDepth, trimmedProof;
  let dataHash, creatorHash, root, leafIndex, proofAccounts;

  const needsCompressionData = !destination;
  if (needsCompressionData) {
    [asset, assetProof] = await Promise.all([
      fetchAsset(env, assetId),
      fetchAssetProof(env, assetId),
    ]);

    merkleTree = new PublicKey(assetProof.tree_id);
    canopyDepth = await fetchCanopyDepth(env, merkleTree.toBase58());
    const proof = assetProof.proof || [];
    trimmedProof = proof.slice(0, Math.max(0, proof.length - canopyDepth));

    dataHash = Buffer.from(
      asset.compression.data_hash.startsWith("0x")
        ? asset.compression.data_hash.slice(2)
        : bs58.decode(asset.compression.data_hash)
    );
    creatorHash = Buffer.from(
      asset.compression.creator_hash.startsWith("0x")
        ? asset.compression.creator_hash.slice(2)
        : bs58.decode(asset.compression.creator_hash)
    );
    root = Buffer.from(bs58.decode(assetProof.root));
    leafIndex = asset.compression.leaf_id;
    proofAccounts = trimmedProof.map((p) => ({
      pubkey: new PublicKey(p),
      isSigner: false,
      isWritable: false,
    }));
  }

  // Build initializeCompressionRecipientV0 if recipient PDA doesn't exist
  let initIx = null;
  if (!recipientExists && needsCompressionData) {
    const initDiscriminator = await anchorDiscriminator(
      "initialize_compression_recipient_v0"
    );
    const initArgs = encodeDistributeArgs(dataHash, creatorHash, root, leafIndex);

    initIx = new TransactionInstruction({
      programId: LAZY_DIST_PID,
      keys: [
        { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: lazyDistributor, isSigner: false, isWritable: false },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: merkleTree, isSigner: false, isWritable: false },
        { pubkey: ownerPk, isSigner: false, isWritable: false },
        { pubkey: ownerPk, isSigner: false, isWritable: false }, // delegate = owner
        { pubkey: SPL_ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        ...proofAccounts,
      ],
      data: Buffer.concat([initDiscriminator, initArgs]),
    });
  }

  // Build the distribute instruction based on whether a custom destination is set
  let distributeIx;

  if (destination) {
    // Custom destination path: no Merkle proof needed
    const customDestDiscriminator = await anchorDiscriminator(
      "distribute_custom_destination_v0"
    );

    distributeIx = new TransactionInstruction({
      programId: LAZY_DIST_PID,
      keys: [
        // common accounts (DistributeRewardsCommonV0)
        { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: lazyDistributor, isSigner: false, isWritable: false },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: rewardsEscrow, isSigner: false, isWritable: true },
        { pubkey: circuitBreaker, isSigner: false, isWritable: true },
        { pubkey: rewardRecipientPk, isSigner: false, isWritable: true },
        { pubkey: destinationATA, isSigner: false, isWritable: true },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: CIRCUIT_BREAKER_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ],
      // No args after discriminator for custom destination
      data: Buffer.from(customDestDiscriminator),
    });
  } else {
    const distributeDiscriminator = await anchorDiscriminator(
      "distribute_compression_rewards_v0"
    );
    const distributeArgs = encodeDistributeArgs(
      dataHash, creatorHash, root, leafIndex
    );

    distributeIx = new TransactionInstruction({
      programId: LAZY_DIST_PID,
      keys: [
        // common accounts (DistributeRewardsCommonV0)
        { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: lazyDistributor, isSigner: false, isWritable: false },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: rewardsEscrow, isSigner: false, isWritable: true },
        { pubkey: circuitBreaker, isSigner: false, isWritable: true },
        { pubkey: ownerPk, isSigner: false, isWritable: true },
        { pubkey: destinationATA, isSigner: false, isWritable: true },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: CIRCUIT_BREAKER_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        // compression-specific accounts
        { pubkey: merkleTree, isSigner: false, isWritable: false },
        { pubkey: SPL_ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
        // merkle proof remaining accounts
        ...proofAccounts,
      ],
      data: Buffer.concat([distributeDiscriminator, distributeArgs]),
    });
  }

  // Build the transaction with Address Lookup Table for size reduction
  const [blockhash, lookupTable] = await Promise.all([
    getRecentBlockhash(env),
    fetchLookupTable(env),
  ]);
  const allInstructions = [
    ...(initIx ? [initIx] : []),
    ...setRewardsIxs,
    distributeIx,
  ];
  const lookupTables = lookupTable ? [lookupTable] : [];

  const messageV0 = new TransactionMessage({
    payerKey: payerKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: allInstructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);

  // Get oracle URLs from the lazy distributor data
  // We already parsed oracle configs in the rewards step, but the oracle
  // URLs were passed through oracleRewards. Let's re-fetch them.
  let offset = 8 + 2 + 32 + 32 + 32; // disc + version + mints + escrow + authority
  const oracleCount = ldBuf.readUInt32LE(offset);
  offset += 4;
  const oracleUrls = [];
  for (let i = 0; i < oracleCount; i++) {
    offset += 32; // oracle pubkey
    const urlLen = ldBuf.readUInt32LE(offset);
    offset += 4;
    const url = ldBuf.slice(offset, offset + urlLen).toString("utf-8");
    offset += urlLen;
    oracleUrls.push(url);
  }

  // Send to each oracle for signing
  let serializedTx = Buffer.from(tx.serialize());

  for (const oracleUrl of oracleUrls) {
    const resp = await fetch(oracleUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transaction: serializedTx.toJSON(),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Oracle signing failed (${oracleUrl}): ${errText}`);
    }

    const result = await resp.json();
    serializedTx = Buffer.from(result.transaction);
  }

  // Deserialize the oracle-signed transaction
  const signedTx = VersionedTransaction.deserialize(serializedTx);

  // Verify oracle didn't inject extra instructions
  if (
    signedTx.message.compiledInstructions.length !==
    tx.message.compiledInstructions.length
  ) {
    throw new Error("Oracle tampered with transaction instructions");
  }

  // Add our payer signature
  signedTx.sign([payerKeypair]);

  // Broadcast the transaction.
  // Helius staked endpoints are read-only; derive the standard endpoint for sends.
  const sendRpcUrl = env.SOLANA_RPC_URL.replace(
    "staked.helius-rpc.com",
    "mainnet.helius-rpc.com"
  );
  const sendResp = await fetch(sendRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        Buffer.from(signedTx.serialize()).toString("base64"),
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
        },
      ],
    }),
  });

  const sendData = await sendResp.json();
  if (sendData.error) {
    // Try to get simulation logs for more detail
    // Simulate to get detailed error logs
    try {
      const simResp = await fetch(sendRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "simulateTransaction",
          params: [
            Buffer.from(signedTx.serialize()).toString("base64"),
            {
              encoding: "base64",
              commitment: "confirmed",
              replaceRecentBlockhash: true,
              sigVerify: false,
            },
          ],
        }),
      });
      const simData = await simResp.json();
      const logs = simData.result?.value?.logs || [];
      const errorLog = logs.find((l) => l.includes("Error") || l.includes("failed"));
      if (errorLog) console.error("Sim detail:", errorLog);
    } catch {
      // Simulation is best-effort for debugging
    }
    throw new Error(
      `Transaction failed: ${sendData.error.message || JSON.stringify(sendData.error)}`
    );
  }

  return {
    txSignature: sendData.result,
    token: tokenConfig.label,
    decimals: tokenConfig.decimals,
  };
}
