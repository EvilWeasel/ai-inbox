import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AudioPlayerProvider, DetailPlayControl } from "./audio-player";
import type { InboxItem } from "@/lib/contracts";
const first = { id: "first", title: "First recording", audioAvailable: true } as InboxItem;
const second = { id: "second", title: "Second recording", audioAvailable: true } as InboxItem;
let paused = true;
let ended = false;
let currentSrc = "";
let duration = 120;
let readyState = 1;
let mediaError: MediaError | null = null;
let play: ReturnType<typeof vi.spyOn>;
let load: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
function audio() { return screen.getByLabelText("Inbox audio") as HTMLAudioElement; }
function mount(item = first) { return render(<AudioPlayerProvider><DetailPlayControl item={item} /></AudioPlayerProvider>); }
async function start(name = first.title) {
  fireEvent.click(screen.getByRole("button", { name: `Play ${name}` }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Pause audio" })).toBeTruthy());
}
beforeEach(() => {
  localStorage.clear();
  paused = true; ended = false; currentSrc = ""; duration = 120; readyState = 1; mediaError = null;
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
  vi.spyOn(HTMLMediaElement.prototype, "ended", "get").mockImplementation(() => ended);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockImplementation(() => duration);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(() => readyState);
  Object.defineProperty(HTMLMediaElement.prototype, "error", { configurable: true, get: () => mediaError });
  vi.spyOn(HTMLMediaElement.prototype, "currentSrc", "get").mockImplementation(() => currentSrc);
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => { paused = false; });
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => { paused = true; });
  load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function(this: HTMLMediaElement) { currentSrc = this.src; this.currentTime = 0; ended = false; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (HTMLMediaElement.prototype as unknown as { error?: MediaError }).error; });
describe("persistent audio", () => {
  it("has one stable empty audio node, and selection/metadata rerenders never change source or position", async () => {
    const view = mount();
    const node = audio();
    expect(document.querySelectorAll("audio").length).toBe(1);
    expect(node.getAttribute("src")).toBeNull();
    expect(play).not.toHaveBeenCalled();
    await start();
    node.currentTime = 37;
    const pauses = pause.mock.calls.length;
    view.rerender(<AudioPlayerProvider><DetailPlayControl item={second} /></AudioPlayerProvider>);
    expect(audio()).toBe(node);
    expect(node.getAttribute("src")).toBe("/api/items/first/audio");
    expect(node.currentTime).toBe(37);
    expect(pause.mock.calls.length).toBe(pauses);
    expect(screen.getByRole("button", { name: "Open playing item: First recording" })).toBeTruthy();
    view.rerender(<AudioPlayerProvider><DetailPlayControl item={{ ...first, title: "Updated metadata" }} /></AudioPlayerProvider>);
    expect(node.currentTime).toBe(37);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("resumes the same track and switches only after explicit Play on another recording", async () => {
    const view = mount(); await start();
    audio().currentTime = 48;
    fireEvent.click(screen.getByRole("button", { name: "Pause First recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume First recording" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause audio" })).toBeTruthy());
    expect(audio().currentTime).toBe(48);
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<AudioPlayerProvider><DetailPlayControl item={second} /></AudioPlayerProvider>);
    await start(second.title);
    expect(audio().getAttribute("src")).toBe("/api/items/second/audio");
    expect(audio().currentTime).toBe(0);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("scrubs and applies globally persisted speed; guards nonfinite duration", async () => {
    mount(); await start();
    fireEvent.loadedMetadata(audio());
    fireEvent.change(screen.getByRole("slider", { name: "Audio position" }), { target: { value: "73" } });
    expect(audio().currentTime).toBe(73);
    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "1.5" } });
    expect(audio().playbackRate).toBe(1.5);
    expect(localStorage.getItem("ai-inbox-playback-speed")).toBe("1.5");
    duration = Infinity; fireEvent.durationChange(audio());
    expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("1:13 / –:––")).toBeTruthy();
  });
  it("reports rejected play without optimistic playing and recovers on explicit Retry", async () => {
    play.mockRejectedValueOnce(new Error("blocked")); mount();
    fireEvent.click(screen.getByRole("button", { name: "Play First recording" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Pause audio" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry audio" }));
    await screen.findByRole("button", { name: "Pause audio" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("handles media errors and reloads the same node only for retry", async () => {
    mount(); await start(); const node = audio();
    mediaError = { code: 2 } as MediaError;
    fireEvent.error(node);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry audio" }));
    await screen.findByRole("button", { name: "Pause audio" });
    expect(audio()).toBe(node); expect(load).toHaveBeenCalledTimes(2);
  });
  it("finishes and replays from zero without changing the recording", async () => {
    mount(); await start(); audio().currentTime = 120; ended = true; paused = true;
    fireEvent.ended(audio());
    fireEvent.click(screen.getByRole("button", { name: "Replay audio" }));
    await screen.findByRole("button", { name: "Pause audio" });
    expect(audio().currentTime).toBe(0); expect(load).toHaveBeenCalledTimes(1);
  });
  it("ignores stale play rejection and old-source events during rapid switches", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    let resolveSecond: () => void = () => {};
    play.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectFirst = reject; }));
    play.mockImplementationOnce(() => new Promise<void>(resolve => { resolveSecond = () => { paused = false; resolve(); }; }));
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Play First recording" }));
    expect(screen.queryByRole("button", { name: "Pause audio" })).toBeNull();
    view.rerender(<AudioPlayerProvider><DetailPlayControl item={second} /></AudioPlayerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Play Second recording" }));
    currentSrc = new URL("/api/items/first/audio", window.location.href).href;
    ended = true; mediaError = { code: 2 } as MediaError;
    fireEvent.ended(audio()); fireEvent.error(audio()); fireEvent.timeUpdate(audio());
    await act(async () => rejectFirst(new Error("stale")));
    expect(screen.queryByRole("alert")).toBeNull();
    currentSrc = audio().src; ended = false; mediaError = null;
    await act(async () => resolveSecond());
    expect(screen.getByRole("button", { name: "Pause audio" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open playing item: Second recording" })).toBeTruthy();
  });
  it("cancels a pending request and ignores its later resolution", async () => {
    let resolve: () => void = () => {};
    play.mockImplementationOnce(() => new Promise<void>(finish => { resolve = finish; })); mount();
    fireEvent.click(screen.getByRole("button", { name: "Play First recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel playback" }));
    await act(async () => resolve());
    expect(screen.getByRole("button", { name: "Play audio" })).toBeTruthy();
  });
  it("refresh remount starts silent and retains only the speed preference", async () => {
    const view = mount(); await start(); audio().currentTime = 62;
    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "2" } });
    view.unmount(); mount();
    expect(audio().getAttribute("src")).toBeNull();
    expect(audio().playbackRate).toBe(2);
    expect(play).toHaveBeenCalledTimes(1);
  });
  it("title navigation preserves current filters and does not invoke playback", async () => {
    window.history.replaceState(null, "", "/?view=archive&q=query&kind=alert&item=second");
    mount(); await start(); audio().currentTime = 20;
    fireEvent.click(screen.getByRole("button", { name: "Open playing item: First recording" }));
    expect(window.location.search).toBe("?view=archive&q=query&kind=alert&item=first");
    expect(play).toHaveBeenCalledTimes(1); expect(audio().currentTime).toBe(20);
  });
});
