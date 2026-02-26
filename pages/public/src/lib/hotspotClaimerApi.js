export const API_BASE = import.meta.env.DEV
  ? "/api/hotspot-claimer"
  : "https://api.heliumtools.org/hotspot-claimer";

async function parseJson(res) {
  const contentType = res.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function lookupHotspot(entityKey) {
  const query = new URLSearchParams({ entityKey });
  const res = await fetch(`${API_BASE}/lookup?${query.toString()}`);
  const data = await parseJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "Unable to look up hotspot");
  }
  return data;
}

export async function fetchRewards(entityKey) {
  const query = new URLSearchParams({ entityKey });
  const res = await fetch(`${API_BASE}/rewards?${query.toString()}`);
  const data = await parseJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "Unable to fetch rewards");
  }
  return data;
}

export async function claimRewards(entityKey) {
  const res = await fetch(`${API_BASE}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entityKey }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "Claim failed");
  }
  return data;
}

export async function fetchWalletHotspots(address) {
  const query = new URLSearchParams({ address });
  const res = await fetch(`${API_BASE}/wallet?${query.toString()}`);
  const data = await parseJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "Unable to fetch wallet hotspots");
  }
  return data;
}
