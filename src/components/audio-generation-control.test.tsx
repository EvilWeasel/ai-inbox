import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InboxItem } from "@/lib/contracts";
import { AudioGenerationControl } from "./audio-generation-control";

const item = { id: "missing/audio", title: "A report", kind: "result", audioAvailable: false, audioStatus: null } as InboxItem;
function response(item: InboxItem, status = 202) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ item }) } as Response;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("on-demand audio", () => {
  it("only requests from a gesture and prevents repeated requests while confirming and queued", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const onRequested = vi.fn();
    const view = render(<AudioGenerationControl item={item} onRequested={onRequested} />);
    view.rerender(<AudioGenerationControl item={{ ...item }} onRequested={onRequested} />);
    expect(fetch).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Generate audio for A report" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/items/missing%2Faudio/audio-request", { method: "POST" });
    const queued = { ...item, audioStatus: "queued" as const };
    finish(response(queued));
    await waitFor(() => expect(onRequested).toHaveBeenCalledWith(queued));
    fireEvent.click(screen.getByRole("button", { name: "Audio queued for A report" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Audio queued for A report" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<AudioGenerationControl item={{ ...item, audioStatus: "generating" }} onRequested={onRequested} />);
    expect((screen.getByRole("button", { name: "Preparing audio for A report" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers an explicit retry after a network error but never retries by itself", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(response({ ...item, audioStatus: "queued" }));
    vi.stubGlobal("fetch", fetch);
    render(<AudioGenerationControl item={item} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate audio for A report" }));
    await screen.findByRole("alert");
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry audio request for A report" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(2);
    await screen.findByRole("button", { name: "Audio queued for A report" });
  });

  it("does not expose a paid retry for a recording that requires review", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<AudioGenerationControl item={{ ...item, audioStatus: "needs_review" }} />);
    expect(screen.getByText("Audio needs attention")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can request a current recording when the previous version is superseded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...item, audioStatus: "queued" })));
    render(<AudioGenerationControl item={{ ...item, audioStatus: "superseded" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate audio for A report" }));
    await screen.findByRole("button", { name: "Audio queued for A report" });
  });
});
