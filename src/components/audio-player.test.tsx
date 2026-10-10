import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AudioPlayerProvider, DetailPlayControl } from "./audio-player";
import type { InboxItem } from "@/lib/contracts";
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
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
    fireEvent.keyDown(screen.getByRole("slider", { name: "Audio position" }), { key: "ArrowRight" });
    expect(audio().currentTime).toBe(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Playback speed, 1 times" }));
    await user.click(screen.getByRole("menuitemradio", { name: "1.5×" }));
    expect(audio().playbackRate).toBe(1.5);
    expect(localStorage.getItem("ai-inbox-playback-speed")).toBe("1.5");
    duration = Infinity; fireEvent.durationChange(audio());
    expect(screen.getByRole("slider", { name: "Audio position" }).getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByText(/0:01/)).toBeTruthy();
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
  it("refresh remount starts silent and restores speed, volume and mute preferences to the same single node", async () => {
    const view = mount(); await start(); audio().currentTime = 62;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Playback speed, 1 times" }));
    await user.click(screen.getByRole("menuitemradio", { name: "2×" }));
    fireEvent.click(screen.getByRole("button", { name: "Mute audio" }));
    view.unmount(); mount();
    expect(audio().getAttribute("src")).toBeNull();
    expect(audio().playbackRate).toBe(2);
    expect(audio().volume).toBe(0.8);
    expect(audio().muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
  });
  it("title navigation preserves current filters and does not invoke playback", async () => {
    window.history.replaceState(null, "", "/?view=archive&q=query&kind=alert&item=second");
    mount(); await start(); audio().currentTime = 20;
    fireEvent.click(screen.getByRole("button", { name: "Open playing item: First recording" }));
    expect(window.location.search).toBe("?view=archive&q=query&kind=alert&item=first");
    expect(play).toHaveBeenCalledTimes(1); expect(audio().currentTime).toBe(20);
  });
  it("sets real media volume, restores the last audible level after mute, and persists device preferences", () => {
    mount();
    const volume = screen.getByRole("slider", { name: "Volume" });
    fireEvent.keyDown(volume, { key: "ArrowLeft" });
    expect(audio().volume).toBeCloseTo(0.79);
    expect(localStorage.getItem("ai-inbox-audio-volume")).toBe("0.79");
    fireEvent.click(screen.getByRole("button", { name: "Mute audio" }));
    expect(audio().muted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute audio" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Unmute audio" }));
    expect(audio().muted).toBe(false);
    expect(audio().volume).toBeCloseTo(0.79);
    expect(localStorage.getItem("ai-inbox-audio-muted")).toBe("false");
  });
  it("unmuting a zero level restores a useful last nonzero volume", () => {
    localStorage.setItem("ai-inbox-audio-volume", "0");
    localStorage.setItem("ai-inbox-audio-last-volume", "0.42");
    localStorage.setItem("ai-inbox-audio-muted", "true");
    mount();
    expect(audio().volume).toBe(0);
    expect(audio().muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Unmute audio" }));
    expect(audio().muted).toBe(false);
    expect(audio().volume).toBe(0.42);
  });
  it("rejects malformed stored preferences and clamps out of range stored volumes", () => {
    localStorage.setItem("ai-inbox-audio-volume", "nope");
    localStorage.setItem("ai-inbox-audio-last-volume", "NaN");
    localStorage.setItem("ai-inbox-audio-muted", "possibly");
    mount();
    expect(audio().volume).toBe(0.8);
    expect(audio().muted).toBe(false);
    cleanup();
    localStorage.setItem("ai-inbox-audio-volume", "1.8");
    mount();
    expect(audio().volume).toBe(1);
  });
  it("opens compact volume controls without muting and provides a keyboard-operable speed menu", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Adjust volume" }));
    expect(screen.getByRole("dialog", { name: "Volume controls" })).toBeTruthy();
    expect(audio().muted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Mute recording" }));
    expect(audio().muted).toBe(true);
    await user.keyboard("{Escape}");
    const speedTrigger = screen.getByRole("button", { name: "Playback speed, 1 times" });
    fireEvent.keyDown(speedTrigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    expect(menu).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "1×" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "1.25×" }), { key: "Enter" });
    expect(audio().playbackRate).toBe(1.25);
  });
});
