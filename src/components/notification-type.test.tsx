import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NotificationType } from "./notification-type";

describe("notification types", () => {
  it.each([
    ["briefing", undefined, "Briefing", "Newspaper"],
    ["alert", undefined, "Release alert", "BellRing"],
    ["result", "research", "Research result", "FileSearch"],
    ["result", "implementation", "Implementation result", "Code2"],
    ["result", "report", "Report result", "ClipboardList"],
  ] as const)("shows the %s type with an accessible label and recognizable icon", (kind, resultType, label, icon) => {
    const { container } = render(<NotificationType kind={kind} resultType={resultType} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(container.querySelector(`[data-type-icon="${icon}"]`)).toBeTruthy();
  });

  it("keeps an audio badge separate from the notification type", () => {
    const { container } = render(<NotificationType kind="briefing" audioAvailable />);
    expect(screen.getByLabelText("Audio available")).toBeTruthy();
    expect(container.querySelector('[data-audio-icon="Headphones"]')).toBeTruthy();
    expect(screen.getAllByText("Briefing").length).toBeGreaterThan(0);
  });

  it("pairs alert and completed-result icons with their type glyphs", () => {
    const alert = render(<NotificationType kind="alert" />);
    expect(alert.container.querySelector('[data-type-accent="Zap"]')).toBeTruthy();
    alert.unmount();
    const result = render(<NotificationType kind="result" resultType="report" />);
    expect(result.container.querySelector('[data-type-accent="Check"]')).toBeTruthy();
  });
});
