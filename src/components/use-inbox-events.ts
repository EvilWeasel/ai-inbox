"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type InboxConnectionStatus = "connected" | "reconnecting" | "unavailable";
export type InboxInvalidation = { revision: string; baseline: boolean; signal: AbortSignal };

/** Mount once above list/detail. A callback must invalidate BOTH and resolve only
 * after its refresh completes. Calls are serialized with one trailing refresh;
 * keep navigation and optimistic mutation guards inside the callback's loaders.
 */
export function useInboxEvents(invalidate: (event: InboxInvalidation) => void | Promise<void>) {
  const callback = useRef(invalidate);
  useLayoutEffect(() => { callback.current = invalidate; }, [invalidate]);
  const [status, setStatus] = useState<InboxConnectionStatus>("reconnecting");
  useEffect(() => {
    if (typeof EventSource === "undefined") { setStatus("unavailable"); return; }
    const source = new EventSource("/api/events");
    const controller = new AbortController();
    let active = true;
    let running = false;
    let pending: { revision: string; baseline: boolean } | undefined;
    let lastRevision: string | undefined;
    const drain = async () => {
      if (running) return;
      running = true;
      try {
        while (active && pending) {
          const event = pending;
          pending = undefined;
          // The caller presents loader errors and meaningful retry controls.
          try { await callback.current({ ...event, signal: controller.signal }); } catch { /* Caller owns recovery UI. */ }
        }
      } finally { running = false; }
    };
    const receive = (baseline: boolean) => (event: Event) => {
      if (!active) return;
      let revision: unknown;
      try { revision = JSON.parse((event as MessageEvent<string>).data).revision; } catch { return; }
      if (typeof revision !== "string" || !/^\d{1,19}$/.test(revision)) return;
      setStatus("connected");
      if (!baseline && revision === lastRevision) return;
      lastRevision = revision;
      pending = { revision, baseline: baseline || pending?.baseline === true };
      void drain();
    };
    const baseline = receive(true);
    const change = receive(false);
    source.addEventListener("baseline", baseline);
    source.addEventListener("change", change);
    // Native EventSource reconnects; every reopened stream supplies a baseline,
    // including when its revision equals the last one (restart/restore safe).
    source.onerror = () => { if (active) setStatus("reconnecting"); };
    return () => {
      active = false;
      pending = undefined;
      controller.abort();
      source.removeEventListener("baseline", baseline);
      source.removeEventListener("change", change);
      source.onerror = null;
      source.close();
    };
  }, []);
  return status;
}
