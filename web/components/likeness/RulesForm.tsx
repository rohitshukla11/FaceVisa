"use client";

/**
 * A creator's rules: their price per ad, the longest licence they allow, and the categories they refuse.
 * There is no creator agent: a request that fits these rules still waits for the creator's own decision.
 */
import { useEffect, useState } from "react";
import { btnClass, ErrorCard } from "@/components/ds";
import { Field, inputClass } from "@/components/ui";
import { getJson, postJson, usd, type Listing, type Meta } from "@/lib/likeness";

export function RulesForm({ listing, onSaved, listLabel = "List me for brands" }: { listing: Listing | null; onSaved: () => Promise<unknown>; listLabel?: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [price, setPrice] = useState(listing ? (listing.rules.minPrice / 1e6).toString() : "0.05");
  const [maxDays, setMaxDays] = useState(listing?.rules.maxDays ?? 30);
  const [banned, setBanned] = useState<string[]>(listing?.rules.bannedCategories ?? ["Alcohol", "Gambling"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getJson<Meta>("/api/likeness").then(setMeta, () => undefined);
  }, []);

  const micro = Math.round(Number(price) * 1e6);
  const priceOk = /^\d{1,4}(\.\d{1,6})?$/.test(price) && micro > 0;
  const toggle = (c: string) => setBanned((b) => (b.includes(c) ? b.filter((x) => x !== c) : [...b, c]));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/likeness/creator/listing", { minPrice: price, maxDays, bannedCategories: banned });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Your price per image (USD)" hint={priceOk && meta ? `A video is ${meta.videoMultiplier}× this: ${usd(micro * meta.videoMultiplier)}. Nobody pays less.` : "Above $0, at most $5.00"}>
          <input className={inputClass} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.trim())} />
        </Field>
        <Field label="Longest licence you allow (days)" hint={`How long a brand may use one approved ad: 1 to ${meta?.maxDays ?? 180}`}>
          <input className={inputClass} type="number" min={1} max={meta?.maxDays ?? 180} value={maxDays} onChange={(e) => setMaxDays(Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Categories you refuse" hint="Brands' agents never send you a request in these. Political, adult, minors, impersonation and deception are refused for everyone." group>
        <div className="flex flex-wrap gap-2">
          {(meta?.categories ?? []).map((c) => (
            <label key={c} className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[14px] ${banned.includes(c) ? "border-bad bg-bad-bg text-bad" : "border-field bg-white"}`}>
              <input type="checkbox" className="h-4 w-4" checked={banned.includes(c)} onChange={() => toggle(c)} />
              {c}
            </label>
          ))}
        </div>
      </Field>
      <p className="m-0 text-[13px] text-grey">
        Every request that fits these rules still waits for you: the agent makes the ad, and nothing is released until you see the finished ad and approve it.
      </p>
      <button type="submit" disabled={busy || !priceOk || maxDays < 1 || maxDays > (meta?.maxDays ?? 180)} className={btnClass("lime", "self-start")}>
        {busy ? "Saving…" : listing ? "Save my rules" : listLabel}
      </button>
      {error && <ErrorCard>{error}</ErrorCard>}
    </form>
  );
}
