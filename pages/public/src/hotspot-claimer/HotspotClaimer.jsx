import { useState, useEffect, useRef } from "react";
import {
  SignalIcon,
  WifiIcon,
  MapPinIcon,
  WalletIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import Header from "../components/Header.jsx";
import CopyButton from "../components/CopyButton.jsx";
import {
  lookupHotspot,
  fetchRewards,
  claimRewards,
} from "../lib/hotspotClaimerApi.js";

const inputClassName =
  "block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20";

function isValidEntityKey(key) {
  if (!key || key.length < 20) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(key);
}

function Spinner({ className = "h-4 w-4" }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function NetworkBadge({ network }) {
  if (!network) return null;
  const isIot = network === "iot";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        isIot
          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
          : "bg-violet-50 text-violet-700 ring-1 ring-violet-100"
      }`}
    >
      {isIot ? (
        <SignalIcon className="h-3 w-3" />
      ) : (
        <WifiIcon className="h-3 w-3" />
      )}
      {network.toUpperCase()}
    </span>
  );
}

function truncateAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTokenAmount(raw, decimals) {
  if (!raw || raw === "0") return "0";
  const num = Number(raw) / Math.pow(10, decimals);
  if (num < 0.01) return "<0.01";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function RewardRow({ tokenKey, reward, initsAvailable }) {
  const label = reward.label || tokenKey.toUpperCase();
  const amount = formatTokenAmount(reward.pending, reward.decimals || 6);
  const hasPending = reward.pending && reward.pending !== "0";

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className={`text-sm font-mono ${
            hasPending ? "text-slate-900" : "text-slate-400"
          }`}
        >
          {amount}
        </span>
        {hasPending && !reward.claimable && reward.reason === "no_ata" && (
          <span className="text-xs text-amber-600 bg-amber-50 rounded px-1.5 py-0.5">
            No token account
          </span>
        )}
        {hasPending && reward.claimable && reward.recipientExists === false && !initsAvailable && (
          <span className="text-xs text-sky-600 bg-sky-50 rounded px-1.5 py-0.5">
            Needs setup
          </span>
        )}
        {hasPending && reward.claimable && (reward.recipientExists !== false || initsAvailable) && (
          <span className="text-xs text-emerald-600 bg-emerald-50 rounded px-1.5 py-0.5">
            Claimable
          </span>
        )}
      </div>
    </div>
  );
}

function ClaimResult({ claim }) {
  if (claim.error) {
    return (
      <div className="flex items-start gap-2 py-2 text-sm">
        <ExclamationTriangleIcon className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
        <div>
          <span className="font-medium text-slate-700">{claim.token}</span>
          <span className="text-red-600 ml-2">{claim.error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <CheckCircleIcon className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <span className="font-medium text-slate-700">{claim.token}</span>
          <span className="font-mono text-slate-900">
            {formatTokenAmount(claim.amount, claim.decimals || 6)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1">
          <span className="text-xs text-slate-500 font-mono truncate">
            {truncateAddress(claim.recipient)}
          </span>
          <a
            href={claim.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-xs text-sky-600 hover:text-sky-500"
          >
            View tx
            <ArrowTopRightOnSquareIcon className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

function LastClaimCard({ lastClaim }) {
  const claimedAt = new Date(lastClaim.claimedAt);
  const successClaims = lastClaim.claims.filter((c) => c.txSignature);

  if (successClaims.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 mt-4">
      <h3 className="text-sm font-semibold text-slate-900 mb-1">
        Recently Claimed
      </h3>
      <p className="text-xs text-slate-500 mb-3">
        {claimedAt.toLocaleString()} — next claim available in{" "}
        {Math.max(
          0,
          Math.ceil(
            (lastClaim.cooldownHours * 3600000 -
              (Date.now() - claimedAt.getTime())) /
              3600000
          )
        )}h
      </p>
      <div className="divide-y divide-slate-100">
        {successClaims.map((claim, i) => (
          <ClaimResult key={i} claim={claim} />
        ))}
      </div>
    </div>
  );
}

function RewardsCard({
  rewards,
  loading,
  onClaim,
  claiming,
  claimResult,
  claimError,
  lastClaim,
  initsAvailable,
}) {
  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 mt-4">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner />
          Querying oracles for pending rewards...
        </div>
      </div>
    );
  }

  if (!rewards) return null;

  const anyClaimable = Object.values(rewards).some((r) => r.claimable);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 mt-4">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">
        Pending Rewards
      </h3>
      <div className="divide-y divide-slate-100">
        {Object.entries(rewards).map(([key, reward]) => (
          <RewardRow key={key} tokenKey={key} reward={reward} initsAvailable={initsAvailable} />
        ))}
      </div>

      {/* Setup notice — only shown when inits are exhausted */}
      {anyClaimable && !claimResult && !initsAvailable && Object.values(rewards).some(
        (r) => r.claimable && r.recipientExists === false
      ) && (
        <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-2.5">
          Some rewards need a one-time on-chain setup before they can be claimed here.
          You can set this up by claiming once via the{" "}
          <a
            href="https://wallet.helium.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-amber-800"
          >
            Helium wallet app
          </a>.
        </p>
      )}

      {/* Last claim results */}
      {lastClaim && !claimResult && (
        <LastClaimCard lastClaim={lastClaim} />
      )}

      {/* Claim button */}
      {anyClaimable && !claimResult && !lastClaim && (
        <button
          onClick={onClaim}
          disabled={claiming}
          className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {claiming ? (
            <>
              <Spinner />
              Claiming rewards...
            </>
          ) : (
            "Claim Rewards"
          )}
        </button>
      )}

      {/* Claim results */}
      {claimResult && (
        <div className="mt-4 pt-4 border-t border-slate-200">
          <h4 className="text-sm font-semibold text-slate-900 mb-2">
            {claimResult.success ? "Claim Successful" : "Claim Results"}
          </h4>
          <div className="divide-y divide-slate-100">
            {claimResult.claims.map((claim, i) => (
              <ClaimResult key={i} claim={claim} />
            ))}
          </div>
        </div>
      )}

      {/* Claim error */}
      {claimError && !claimResult && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {claimError}
        </div>
      )}

      {!anyClaimable && !claimResult && (() => {
        const hasNoAta = Object.values(rewards).some(
          (r) => r.pending && r.pending !== "0" && r.reason === "no_ata"
        );
        return (
          <div className="mt-3 text-xs text-slate-500 space-y-1.5">
            {hasNoAta && (
              <p className="text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-2.5">
                The reward recipient does not have a token account for one or more reward types.
                Create the token account in your wallet before claiming.
              </p>
            )}
            {!hasNoAta && (
              <p>No claimable rewards at this time.</p>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function SolanaAddress({ address }) {
  return (
    <dd className="flex items-center gap-1 min-w-0">
      <a
        href={`https://orbmarkets.io/address/${address}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-sky-600 hover:text-sky-500 truncate"
      >
        {truncateAddress(address)}
      </a>
      <CopyButton text={address} size="h-3.5 w-3.5" />
    </dd>
  );
}

function HotspotCard({ hotspot, destination, rewardsLoaded }) {
  const locationParts = [hotspot.city, hotspot.state, hotspot.country].filter(Boolean);
  const hasCustomRecipient = destination && destination !== hotspot.owner;
  const recipientAddress = hasCustomRecipient ? destination : hotspot.owner;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900 truncate">
            {hotspot.name || "Unknown Hotspot"}
          </h3>
          <p className="text-xs text-slate-500 font-mono mt-0.5 truncate">
            Asset: {truncateAddress(hotspot.assetId)}
          </p>
        </div>
        <NetworkBadge network={hotspot.network} />
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div className="flex items-start gap-2">
          <WalletIcon className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">Owner</dt>
            <SolanaAddress address={hotspot.owner} />
          </div>
        </div>
        <div className="flex items-start gap-2">
          <WalletIcon className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">Rewards Recipient</dt>
            {rewardsLoaded ? (
              <dd className="flex items-center gap-1 min-w-0">
                <a
                  href={`https://orbmarkets.io/address/${recipientAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sky-600 hover:text-sky-500 truncate"
                >
                  {truncateAddress(recipientAddress)}
                </a>
                <CopyButton text={recipientAddress} size="h-3.5 w-3.5" />
                {!hasCustomRecipient && (
                  <span className="text-xs text-slate-400 font-sans">(owner)</span>
                )}
              </dd>
            ) : (
              <dd className="text-slate-400 text-xs">Loading...</dd>
            )}
          </div>
        </div>
        {locationParts.length > 0 && (
          <div className="flex items-start gap-2">
            <MapPinIcon className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <dt className="text-xs text-slate-500">Location</dt>
              <dd className="text-slate-900 truncate">
                {locationParts.join(", ")}
              </dd>
            </div>
          </div>
        )}
      </dl>
    </div>
  );
}

export default function HotspotClaimer() {
  const [entityKey, setEntityKey] = useState("");
  const [hotspot, setHotspot] = useState(null);
  const [rewards, setRewards] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingRewards, setLoadingRewards] = useState(false);
  const [error, setError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState(null);
  const [claimError, setClaimError] = useState("");
  const [lastClaim, setLastClaim] = useState(null);
  const [initsAvailable, setInitsAvailable] = useState(true);
  const debounceRef = useRef(null);

  // Auto-lookup when entity key passes validation
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const key = entityKey.trim();

    if (!isValidEntityKey(key)) {
      if (hotspot) {
        setHotspot(null);
        setRewards(null);
        setClaimResult(null);
        setClaimError("");
        setLastClaim(null);
        setInitsAvailable(true);
        setError("");
      }
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError("");
      setHotspot(null);
      setRewards(null);
      setClaimResult(null);
      setClaimError("");
      setLastClaim(null);
      setInitsAvailable(true);

      try {
        const result = await lookupHotspot(key);
        // Guard against stale response
        if (key !== entityKey.trim()) return;
        setHotspot(result);

        // Auto-fetch rewards
        setLoadingRewards(true);
        try {
          const rewardsResult = await fetchRewards(key);
          if (key !== entityKey.trim()) return;
          setRewards(rewardsResult.rewards);
          if (rewardsResult.initsAvailable !== undefined) {
            setInitsAvailable(rewardsResult.initsAvailable);
          }
          if (rewardsResult.lastClaim) {
            setLastClaim(rewardsResult.lastClaim);
          }
        } catch (err) {
          console.error("Rewards fetch failed:", err.message);
        } finally {
          setLoadingRewards(false);
        }
      } catch (err) {
        if (key === entityKey.trim()) {
          setError(err.message);
        }
      } finally {
        setLoading(false);
      }
    }, 800);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [entityKey]);

  async function handleClaim() {
    setClaiming(true);
    setClaimError("");
    setClaimResult(null);

    try {
      const result = await claimRewards(entityKey.trim());
      setClaimResult(result);
    } catch (err) {
      setClaimError(err.message);
    } finally {
      setClaiming(false);
    }
  }

  // Derive destination from rewards (first non-null across tokens)
  const destination = rewards
    ? Object.values(rewards).find((r) => r.destination)?.destination || null
    : null;

  return (
    <div className="min-h-screen bg-white">
      <Header />
      <main className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-12">
        {/* Page Header */}
        <div className="mb-8">
          <p className="text-sm font-mono uppercase tracking-widest text-sky-600 mb-2">
            Hotspot Tools
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight mb-2">
            Claim Hotspot Rewards
          </h1>
          <p className="text-sm text-slate-600">
            Enter a Hotspot entity key to view metadata and claim pending
            rewards. Works for both IOT and MOBILE Hotspots.
          </p>
        </div>

        {/* Lookup Input */}
        <div className="mb-6">
          <label
            htmlFor="entityKey"
            className="block text-sm font-medium text-slate-700 mb-1.5"
          >
            Hotspot Entity Key
          </label>
          <div className="relative">
            <input
              id="entityKey"
              type="text"
              value={entityKey}
              onChange={(e) => setEntityKey(e.target.value)}
              placeholder="Enter ECC compact key or entity key..."
              className={`${inputClassName} font-mono text-xs pr-10`}
            />
            {loading && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <Spinner className="h-4 w-4 text-slate-400" />
              </div>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-6">
            {error}
          </div>
        )}

        {/* Hotspot Card */}
        {hotspot && (
          <HotspotCard
            hotspot={hotspot}
            destination={destination}
            rewardsLoaded={rewards !== null}
          />
        )}

        {/* Rewards Card */}
        {hotspot && (
          <RewardsCard
            rewards={rewards}
            loading={loadingRewards}
            onClaim={handleClaim}
            claiming={claiming}
            claimResult={claimResult}
            claimError={claimError}
            lastClaim={lastClaim}
            initsAvailable={initsAvailable}
          />
        )}
      </main>
    </div>
  );
}
