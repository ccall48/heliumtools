/**
 * Convert a Solana VersionedTransaction from wire format to Rust bincode format.
 *
 * Wire format uses compact_u16 for array lengths.
 * Bincode uses u64_le for Vec lengths and u32_le for enum variants.
 *
 * Layout comparison:
 *   Wire:    compact_u16(num_sigs) + sigs + message
 *   Bincode: u64_le(num_sigs) + sigs + u32_le(variant) + message
 *
 * Within legacy message:
 *   Wire:    header(3 bytes) + compact_u16(num_keys) + keys + blockhash + compact_u16(num_ixs) + instructions
 *   Bincode: header(3 bytes) + u64_le(num_keys) + keys + blockhash + u64_le(num_ixs) + instructions
 *
 * Within each compiled instruction:
 *   Wire:    u8(prog_idx) + compact_u16(num_accts) + accts + compact_u16(data_len) + data
 *   Bincode: u8(prog_idx) + u64_le(num_accts) + accts + u64_le(data_len) + data
 */

function readCompactU16(buf, pos) {
  let val = buf[pos];
  pos++;
  if (val < 0x80) return [val, pos];
  val = (val & 0x7f) | (buf[pos] << 7);
  pos++;
  if (val < 0x4000) return [val, pos];
  val = (val & 0x3fff) | (buf[pos] << 14);
  pos++;
  return [val, pos];
}

function writeU64LE(val) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(val, 0);
  return buf;
}

function writeU32LE(val) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(val, 0);
  return buf;
}

/**
 * Convert VersionedTransaction.serialize() wire bytes to bincode format.
 * Only supports legacy messages (no version prefix / v0).
 */
export function wireToBincode(wireBytes) {
  const parts = [];
  let pos = 0;

  // 1. Signatures: compact_u16(count) + count * 64 bytes
  const [numSigs, p1] = readCompactU16(wireBytes, pos);
  pos = p1;
  parts.push(writeU64LE(numSigs));
  parts.push(Buffer.from(wireBytes.slice(pos, pos + numSigs * 64)));
  pos += numSigs * 64;

  // 2. Variant discriminant for VersionedMessage::Legacy
  parts.push(writeU32LE(0));

  // 3. Message header (3 bytes, copied as-is)
  parts.push(Buffer.from(wireBytes.slice(pos, pos + 3)));
  pos += 3;

  // 4. Account keys: compact_u16(count) + count * 32 bytes
  const [numKeys, p2] = readCompactU16(wireBytes, pos);
  pos = p2;
  parts.push(writeU64LE(numKeys));
  parts.push(Buffer.from(wireBytes.slice(pos, pos + numKeys * 32)));
  pos += numKeys * 32;

  // 5. Recent blockhash (32 bytes, copied as-is)
  parts.push(Buffer.from(wireBytes.slice(pos, pos + 32)));
  pos += 32;

  // 6. Instructions: compact_u16(count) + instructions
  const [numIxs, p3] = readCompactU16(wireBytes, pos);
  pos = p3;
  parts.push(writeU64LE(numIxs));

  for (let i = 0; i < numIxs; i++) {
    // program_id_index: u8
    parts.push(Buffer.from([wireBytes[pos]]));
    pos++;

    // accounts: compact_u16(count) + count bytes
    const [numAccts, p4] = readCompactU16(wireBytes, pos);
    pos = p4;
    parts.push(writeU64LE(numAccts));
    parts.push(Buffer.from(wireBytes.slice(pos, pos + numAccts)));
    pos += numAccts;

    // data: compact_u16(len) + len bytes
    const [dataLen, p5] = readCompactU16(wireBytes, pos);
    pos = p5;
    parts.push(writeU64LE(dataLen));
    parts.push(Buffer.from(wireBytes.slice(pos, pos + dataLen)));
    pos += dataLen;
  }

  return Buffer.concat(parts);
}

/**
 * Convert bincode format back to wire format.
 */
export function bincodeToWire(bincodeBytes) {
  const parts = [];
  let pos = 0;

  // 1. Signatures: u64_le(count) + count * 64 bytes
  const numSigs = bincodeBytes.readUInt32LE(pos);
  pos += 8;
  parts.push(Buffer.from([numSigs])); // compact_u16 for < 128
  parts.push(Buffer.from(bincodeBytes.slice(pos, pos + numSigs * 64)));
  pos += numSigs * 64;

  // 2. Skip variant u32 (legacy = 0)
  pos += 4;

  // 3. Message header (3 bytes)
  parts.push(Buffer.from(bincodeBytes.slice(pos, pos + 3)));
  pos += 3;

  // 4. Account keys: u64_le(count) + count * 32 bytes
  const numKeys = bincodeBytes.readUInt32LE(pos);
  pos += 8;
  parts.push(Buffer.from([numKeys])); // compact_u16
  parts.push(Buffer.from(bincodeBytes.slice(pos, pos + numKeys * 32)));
  pos += numKeys * 32;

  // 5. Recent blockhash (32 bytes)
  parts.push(Buffer.from(bincodeBytes.slice(pos, pos + 32)));
  pos += 32;

  // 6. Instructions: u64_le(count) + instructions
  const numIxs = bincodeBytes.readUInt32LE(pos);
  pos += 8;
  parts.push(Buffer.from([numIxs])); // compact_u16

  for (let i = 0; i < numIxs; i++) {
    // program_id_index: u8
    parts.push(Buffer.from([bincodeBytes[pos]]));
    pos++;

    // accounts: u64_le(count) + count bytes
    const numAccts = bincodeBytes.readUInt32LE(pos);
    pos += 8;
    parts.push(Buffer.from([numAccts])); // compact_u16
    parts.push(Buffer.from(bincodeBytes.slice(pos, pos + numAccts)));
    pos += numAccts;

    // data: u64_le(len) + len bytes
    const dataLen = bincodeBytes.readUInt32LE(pos);
    pos += 8;
    parts.push(Buffer.from([dataLen])); // compact_u16
    parts.push(Buffer.from(bincodeBytes.slice(pos, pos + dataLen)));
    pos += dataLen;
  }

  return Buffer.concat(parts);
}
