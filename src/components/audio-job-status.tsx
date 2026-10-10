import { AlertCircle, Clock3, Headphones, LoaderCircle, Radio } from "lucide-react";
import type { InboxItem } from "@/lib/contracts";

type AudioStatus = InboxItem["audioStatus"];

const compactLabels: Partial<Record<Exclude<AudioStatus, null | undefined>, string>> = {
  queued: "Audio queued",
  generating: "Preparing audio",
  needs_review: "Audio needs attention",
  superseded: "Audio unavailable for this version",
};

export function AudioJobStatus({
  status,
  variant = "detail",
}: {
  status: AudioStatus;
  variant?: "compact" | "detail";
}) {
  if (!status || status === "ready") return null;

  const pending = status === "queued" || status === "generating";
  const review = status === "needs_review";
  const Icon = status === "queued"
    ? Clock3
    : status === "generating"
      ? LoaderCircle
      : review
        ? AlertCircle
        : Headphones;

  if (variant === "compact") {
    return (
      <span
        className={`inline-flex max-w-full items-center gap-1.5 truncate text-[11px] leading-4 ${pending ? "text-violet-700 dark:text-violet-300" : review ? "text-amber-700 dark:text-amber-300" : "text-zinc-500 dark:text-zinc-400"}`}
        aria-label={compactLabels[status]}
        title={compactLabels[status]}
      >
        <Icon size={13} aria-hidden="true" className={status === "generating" ? "motion-safe:animate-spin" : ""} />
        <span>{compactLabels[status]}</span>
      </span>
    );
  }

  const title = pending
    ? status === "queued" ? "Audio queued" : "Preparing audio"
    : review
      ? "Audio needs attention"
      : "Audio unavailable for this version";
  const description = pending
    ? "Your written result is ready to read while audio is prepared."
    : review
      ? "The recording is not ready. Your written result is available to read."
      : "This recording does not match the current version. Your written result is available to read.";

  return (
    <section
      className={`mb-7 flex items-start gap-3 rounded-xl border px-4 py-3.5 ${pending ? "border-violet-200 bg-violet-50/80 text-violet-950 dark:border-violet-900/70 dark:bg-zinc-900 dark:text-violet-100" : review ? "border-amber-200 bg-amber-50/70 text-amber-950 dark:border-amber-900/70 dark:bg-zinc-900 dark:text-amber-100" : "border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${pending ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" : review ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" : "bg-zinc-200/70 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}>
        {status === "queued" ? <Clock3 size={17} aria-hidden="true" />
          : status === "generating" ? <Radio size={17} aria-hidden="true" className="motion-safe:animate-pulse" />
            : <Icon size={17} aria-hidden="true" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-5">{title}</span>
        <span className={`mt-0.5 block text-xs leading-5 ${pending ? "text-violet-800/80 dark:text-violet-200/80" : review ? "text-amber-900/80 dark:text-amber-200/80" : "text-zinc-600 dark:text-zinc-400"}`}>
          {description}
        </span>
      </span>
    </section>
  );
}
