"use client";

import { useRef, useState } from "react";
import { Headphones, LoaderCircle } from "lucide-react";
import type { InboxItem } from "@/lib/contracts";
import { AudioJobStatus } from "./audio-job-status";

export function AudioGenerationControl({ item, onRequested }: {
  item: InboxItem;
  onRequested?: (item: InboxItem) => void;
}) {
  const [requesting, setRequesting] = useState(false);
  const [submitted, setSubmitted] = useState<{ source: InboxItem["audioStatus"]; status: InboxItem["audioStatus"] } | null>(null);
  const [error, setError] = useState("");
  // React state is not synchronous: guard repeated gestures before rerender too.
  const inFlight = useRef(false);
  const status = submitted && submitted.source === item.audioStatus ? submitted.status : item.audioStatus;
  const pending = requesting || status === "queued" || status === "generating";
  const needsReview = status === "needs_review";

  async function generate() {
    if (inFlight.current || pending || needsReview) return;
    inFlight.current = true;
    setRequesting(true);
    setError("");
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(item.id)}/audio-request`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) {
        const messages: Record<number, string> = {
          400: "The server rejected the audio request. Reload the page and try again.",
          403: "The server rejected this page's origin. Open Inbox at its configured address and reload.",
          404: "This item is no longer available. Refresh your inbox.",
          415: "The server rejected the audio request format. Reload the page to get the latest version.",
          503: "The Inbox service is temporarily unavailable. Try again later.",
        };
        setError(`${messages[response.status] ?? "The server could not accept the audio request."} (HTTP ${response.status})`);
        return;
      }
      const payload = await response.json() as { item?: InboxItem };
      if (!payload.item || payload.item.id !== item.id) {
        setError("The server returned an unexpected response. Reload the item to check its audio status before retrying.");
        return;
      }
      setSubmitted({ source: item.audioStatus, status: payload.item.audioStatus });
      onRequested?.(payload.item);
    } catch {
      setError("The audio request could not be confirmed because the connection failed. Reload the item to check its audio status before retrying.");
    } finally {
      inFlight.current = false;
      setRequesting(false);
    }
  }

  const label = requesting ? "Requesting audio" : status === "queued" ? "Audio queued"
    : status === "generating" ? "Preparing audio" : error ? "Retry audio request" : "Generate audio";
  return <div className="audio-generation-control">
    {!needsReview && <section className="audio-player enhanced-audio-detail" aria-label="Audio recording">
      <button className="detail-play-control" disabled={pending} onClick={() => void generate()}
        aria-label={`${label} for ${item.title}`}>
        {pending ? <LoaderCircle size={17} aria-hidden="true" className="motion-safe:animate-spin" />
          : <Headphones size={17} aria-hidden="true" />} {label}
      </button>
      <span className="audio-duration">{pending ? "You can keep reading while audio is prepared." : "Create a spoken version of this item."}</span>
    </section>}
    {error && !pending && !needsReview && <p className="audio-request-error" role="alert">{error}</p>}
    <AudioJobStatus status={status} />
  </div>;
}
