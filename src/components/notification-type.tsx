import {
  BellRing,
  Check,
  ClipboardList,
  Code2,
  FileSearch,
  Headphones,
  Newspaper,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { InboxItem } from "@/lib/contracts";
export type NotificationKind = InboxItem["kind"];
export type ResultType = NonNullable<InboxItem["resultType"]>;

type IconComponent = LucideIcon;

const typeIcons: Record<NotificationKind, IconComponent> = {
  briefing: Newspaper,
  alert: BellRing,
  result: FileSearch,
};

const resultIcons: Record<ResultType, IconComponent> = {
  research: FileSearch,
  implementation: Code2,
  report: ClipboardList,
};

export function notificationTypeLabel(
  kind: NotificationKind,
  resultType?: ResultType | null,
) {
  if (kind === "briefing") return "Briefing";
  if (kind === "alert") return "Release alert";
  if (resultType === "implementation") return "Implementation result";
  if (resultType === "report") return "Report result";
  if (resultType === "research") return "Research result";
  return "Agent result";
}

export function NotificationType({
  kind,
  resultType,
  audioAvailable = false,
  className = "",
}: {
  kind: NotificationKind;
  resultType?: ResultType | null;
  audioAvailable?: boolean;
  className?: string;
}) {
  const Icon = kind === "result" && resultType ? resultIcons[resultType] : typeIcons[kind];
  const iconName = kind === "result"
    ? resultType === "implementation" ? "Code2" : resultType === "report" ? "ClipboardList" : "FileSearch"
    : kind === "briefing" ? "Newspaper" : "BellRing";
  const label = notificationTypeLabel(kind, resultType);
  return (
    <span className={`notification-type ${className}`.trim()}>
      <span className={`kind-icon ${kind}`}>
        <Icon size={15} aria-hidden="true" data-type-icon={iconName} />
        {kind === "alert" && <Zap size={9} aria-hidden="true" data-type-accent="Zap" />}
        {kind === "result" && <Check size={9} aria-hidden="true" data-type-accent="Check" />}
      </span>
      <span className="notification-type-label">{label}</span>
      {audioAvailable && (
        <span className="audio-indicator" aria-label="Audio available" title="Audio available">
          <Headphones size={14} aria-hidden="true" data-audio-icon="Headphones" />
        </span>
      )}
    </span>
  );
}
