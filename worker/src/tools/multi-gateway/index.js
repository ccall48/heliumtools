import { corsHeaders, jsonResponse } from "../../lib/response.js";

const REGIONS = [
  { region: "US915", port: 4468 },
  { region: "EU868", port: 4469 },
];

function getHost(env) {
  return env.MULTI_GATEWAY_HOST || "hotspot.heliumtools.org";
}

async function fetchUpstream(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, data: { error: "Upstream returned non-JSON response" } };
  }
}

export async function handleMultiGatewayRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const apiKey = env.MULTI_GATEWAY_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "Multi-gateway API is not configured" }, 500);
  }

  const host = getHost(env);
  const headers = { "X-API-Key": apiKey };

  if (pathname === "/gateways" && request.method === "GET") {
    const results = await Promise.allSettled(
      REGIONS.map(({ port }) =>
        fetchUpstream(`http://${host}:${port}/gateways`, headers),
      ),
    );

    let gateways = [];
    let total = 0;
    let connected = 0;

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.ok) {
        const v = result.value.data;
        gateways = gateways.concat(v.gateways || []);
        total += v.total || 0;
        connected += v.connected || 0;
      }
    }

    return jsonResponse({ gateways, total, connected });
  }

  const packetsMatch = pathname.match(
    /^\/gateways\/([A-Fa-f0-9]{16})\/packets$/,
  );
  if (packetsMatch && request.method === "GET") {
    const mac = packetsMatch[1];
    for (const { port } of REGIONS) {
      const result = await fetchUpstream(
        `http://${host}:${port}/gateways/${mac}/packets`,
        headers,
      );
      if (result.ok) {
        return jsonResponse(result.data);
      }
    }
    return jsonResponse({ error: "Gateway not found" }, 404);
  }

  return jsonResponse({ error: "Not found" }, 404);
}
