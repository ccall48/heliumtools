/**
 * LoRaWAN DevAddr → NetID parsing.
 *
 * DevAddr is a 32-bit value with a type prefix encoded as leading 1-bits.
 * The prefix determines how many bits are allocated to NwkID vs NwkAddr.
 * NetID is a 24-bit value constructed from the type and NwkID.
 *
 * Reference: LoRaWAN specification, bit_looker (github.com/michaeldjeffrey/bit_looker)
 */

// NwkID bit widths per type (Type 0-7)
const NWK_ID_BITS = [6, 6, 9, 11, 12, 13, 15, 17];

/**
 * Parse a DevAddr hex string into its NetID (hex) and type.
 * @param {string} devAddr - 8-character hex string (e.g. "480002C7")
 * @returns {{ netId: string, type: number } | null}
 */
export function devAddrToNetId(devAddr) {
  if (!devAddr || devAddr.length !== 8) return null;

  const num = parseInt(devAddr, 16) >>> 0; // unsigned 32-bit

  // Count leading 1-bits to determine type
  let type = 0;
  for (let i = 31; i >= 0; i--) {
    if ((num >>> i) & 1) type++;
    else break;
  }
  if (type > 7) return null;

  // Extract NwkID: starts after the prefix (type + 1 bits), length from table
  const nwkIdBits = NWK_ID_BITS[type];
  const nwkIdShift = 32 - (type + 1) - nwkIdBits;
  const nwkIdMask = (1 << nwkIdBits) - 1;
  const nwkId = (num >>> nwkIdShift) & nwkIdMask;

  // NetID is 24 bits: type in bits 23-21, NwkID in remaining bits
  const netId = ((type & 0x07) << 21) | nwkId;

  return {
    netId: netId.toString(16).toUpperCase().padStart(6, "0"),
    type,
  };
}

/** Known NetID → operator name mappings */
const KNOWN_NET_IDS = {
  "00003C": "Helium",
  "000024": "Helium",
  C00053: "Helium",
  "600053": "Helium",
  "000002": "Proximus",
  "000003": "Swisscom",
  "000009": "SoftBank",
  "00000A": "Comcast",
  "00000D": "SK Telecom",
  "000010": "Orange",
  "000013": "KPN",
  "000016": "Bouygues",
  "00001A": "Tata Comm",
  "00001D": "NTT",
  "000022": "Senet",
  "000037": "Everynet",
};

/**
 * Look up the operator name for a NetID hex string.
 * @param {string} netIdHex - 6-character hex string (e.g. "00003C")
 * @returns {string | null}
 */
export function netIdToOperator(netIdHex) {
  if (!netIdHex) return null;
  return KNOWN_NET_IDS[netIdHex.toUpperCase()] || null;
}
