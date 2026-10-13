import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { Profiler, useSyncExternalStore } from "react";
import userEvent from "@testing-library/user-event";
import { AudioPlayerProvider } from "./audio-player";
import { Inbox, type InboxItem } from "./inbox";

function render(ui: React.ReactNode) { return testingRender(<AudioPlayerProvider>{ui}</AudioPlayerProvider>); }

const navigation = vi.hoisted(() => ({
  url: "",
  listeners: new Set<() => void>(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => {
    const url = useSyncExternalStore(
      (callback) => {
        navigation.listeners.add(callback);
        return () => navigation.listeners.delete(callback);
      },
      () => navigation.url,
    );
    return new URLSearchParams(url);
  },
}));
function route(url: string) {
  const query = url.replace(/^\/\?/, "");
  window.history.replaceState(null, "", query ? `/?${query}` : "/");
  navigation.url = query;
  navigation.listeners.forEach((fn) => fn());
}
const fixture: InboxItem = {
  id: "test-item",
  title: "Test release",
  kind: "alert",
  resultType: null,
  origin: null,
  edition: null,
  publishedAt: "2026-10-10T12:00:00Z",
  body: "## Release details\nRead the [official source](https://example.org/release).",
  summary: "A test-only summary.",
  sources: [{ title: "Official source", url: "https://example.org/release" }],
  audioAvailable: true,
  audioDuration: 125,
  audioStatus: "ready",
  readAt: null,
  archivedAt: null,
  tags: ["test"],
};
const resultFixture: InboxItem = {
  ...fixture,
  id: "agent-result",
  title: "Implemented cache invalidation",
  kind: "result",
  resultType: "implementation",
  origin: {
    host: "hephaestus",
    project: "ai-inbox",
    model: "gpt-6-codex",
    threadId: "thread-123",
    threadUrl: "t3-thread://v1/thread-123",
  },
};
const result = (item = fixture) => ({
  items: [item],
  nextCursor: null,
  counts: { inbox: 1, unread: item.readAt ? 0 : 1, archive: 0 },
  total: 1,
});
function response(value: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}
class InboxEventSource extends EventTarget {
  static current: InboxEventSource;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() { super(); InboxEventSource.current = this; }
}
let eventRevision = 0;
function serverChange(baseline = false) {
  InboxEventSource.current.dispatchEvent(new MessageEvent(baseline ? "baseline" : "change", {
    data: JSON.stringify({ revision: String(++eventRevision) }),
  }));
}
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  eventRevision = 0;
  vi.stubGlobal("EventSource", InboxEventSource);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("max-width"), media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  route("");
  navigation.push.mockReset();
  // Emulate Next's documented native-history integration, without a router push.
  const pushState = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, "pushState").mockImplementation((data, unused, url) => {
    pushState(data, unused, url);
    navigation.url = window.location.search.slice(1);
    navigation.listeners.forEach(fn => fn());
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function api(item = fixture) {
  fetchMock.mockImplementation(async (url, options) =>
    options?.method === "PATCH"
      ? response({ item })
      : String(url).startsWith("/api/items?")
        ? response(result(item))
        : response({ item }),
  );
}

describe("inbox API interactions", () => {
  it("loads real counts and selected detail, keeps deep links and supports returning through history", async () => {
    const user = userEvent.setup();
    api();
    render(<Inbox />);
    await screen.findByRole("button", { name: /Test release/ });
    expect(screen.getByLabelText("1 unread items").textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: /Test release/ }));
    expect(navigation.url).toContain("item=test-item");
    await screen.findByRole("heading", { name: "Test release" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/items/test-item",
      expect.anything(),
    );
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);
    const audio = screen.getByLabelText("Inbox audio");
    expect(audio.getAttribute("src")).toBeNull();
    expect(screen.getByRole("button", { name: "Play Test release" })).toBeTruthy();
    expect(audio.getAttribute("autoplay")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Playback speed, 1 times" }));
    await user.click(screen.getByRole("menuitemradio", { name: "1.5×" }));
    expect((audio as HTMLAudioElement).playbackRate).toBe(1.5);
    act(() => route(""));
    await screen.findByRole("heading", { name: "Select an item to read" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Test release/ }),
    );
  });
  it("persists search and kind filters in the query state", async () => {
    api();
    render(<Inbox />);
    await screen.findByRole("button", { name: /Test release/ });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search items" }), {
      target: { value: "model update" },
    });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(navigation.url).toContain("q=model+update"));
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("q=model+update&kind=alert"),
        ),
      ).toBe(true),
    );
    act(() => route("view=unread&q=earlier"));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Search items") as HTMLInputElement).value,
      ).toBe("earlier"),
    );
  });
  it("requests agent results with kind=result when the type filter changes", async () => {
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response(result(resultFixture)) : response({ item: resultFixture }));
    render(<Inbox />);
    await screen.findByRole("button", { name: /Implemented cache invalidation/ });
    fireEvent.click(screen.getByRole("button", { name: "Agent results" }));
    await waitFor(() => {
      expect(window.location.search).toContain("kind=result");
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("kind=result"))).toBe(true);
    });
  });
  it("exposes the type chips as keyboard-operable pressed filters and clears kind from the URL", async () => {
    const user = userEvent.setup();
    api();
    route("q=morning&kind=alert");
    render(<Inbox />);
    await screen.findByRole("button", { name: /Test release/ });
    const alerts = screen.getByRole("button", { name: "Alerts" });
    expect(alerts.getAttribute("aria-pressed")).toBe("true");
    const briefings = screen.getByRole("button", { name: "Briefings" });
    briefings.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.search).toContain("kind=briefing"));
    expect(window.location.search).toContain("q=morning");
    expect(briefings.getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(window.location.search).not.toContain("kind="));
    expect(window.location.search).toContain("q=morning");
  });
  it("shows result origin and only links validated HTTP(S) or strict T3 thread URLs", async () => {
    const item = { ...resultFixture, origin: { ...resultFixture.origin!, threadUrl: "t3-thread://v1/thread-123" } };
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response(result(item)) : response({ item }));
    route("item=agent-result");
    render(<Inbox />);
    await screen.findByRole("heading", { name: item.title });
    expect(screen.getAllByText("hephaestus").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ai-inbox").length).toBeGreaterThan(0);
    expect(screen.getAllByText("gpt-6-codex").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Open source thread/ }).getAttribute("href"))
      .toBe("t3-thread://v1/thread-123");

    const httpItem = { ...item, origin: { ...item.origin!, threadUrl: "https://example.org/thread/123" } };
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response(result(httpItem)) : response({ item: httpItem }));
    act(() => route(""));
    act(() => route("item=agent-result"));
    await waitFor(() => expect(screen.getByRole("link", { name: /Open source thread/ }).getAttribute("href"))
      .toBe("https://example.org/thread/123"));

    for (const threadUrl of ["javascript:alert(1)", "file:///etc/passwd", "t3-thread://v1/thread-123?run=1", "t3-thread://other/thread-123"]) {
      const invalid = { ...item, origin: { ...item.origin!, threadUrl } };
      fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
        ? response(result(invalid)) : response({ item: invalid }));
      act(() => route(""));
      act(() => route("item=agent-result"));
      await screen.findByRole("heading", { name: item.title });
      await waitFor(() => expect(screen.queryByRole("link", { name: /Open source thread/ })).toBeNull());
    }
  });
  it("renders an agent result without inventing origin metadata", async () => {
    const item = { ...resultFixture, resultType: null, origin: null };
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response(result(item)) : response({ item }));
    route("item=agent-result");
    render(<Inbox />);
    await screen.findByRole("heading", { name: item.title });
    expect(screen.getAllByText("Agent result").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Result origin")).toBeNull();
    expect(screen.queryByRole("link", { name: /Open source thread/ })).toBeNull();
  });
  it("shows truthful unavailable states and keeps legacy results readable", async () => {
    const needsReview = {
      ...resultFixture,
      audioAvailable: false,
      audioDuration: null,
      audioStatus: "needs_review" as const,
      body: "The full written result remains available while its recording is reviewed.",
    };
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response(result(needsReview)) : response({ item: needsReview }));
    route("item=agent-result");
    render(<Inbox />);
    await screen.findByRole("heading", { name: needsReview.title });
    expect(screen.getAllByLabelText("Audio needs attention").length).toBeGreaterThan(0);
    expect(screen.getByText("The recording is not ready. Your written result is available to read.")).toBeTruthy();
    expect(screen.getByText(needsReview.body)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Play .*cache invalidation/ })).toBeNull();

    const superseded = { ...needsReview, audioStatus: "superseded" as const };
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response(result(superseded)) : response({ item: superseded }));
    await act(async () => serverChange());
    await screen.findAllByText("Audio unavailable for this version");
    expect(screen.queryByRole("button", { name: /Play .*cache invalidation/ })).toBeNull();

    const legacy = { ...needsReview, audioStatus: undefined };
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response(result(legacy)) : response({ item: legacy }));
    await act(async () => serverChange());
    await screen.findByRole("button", { name: `Generate audio for ${legacy.title}` });
    expect(screen.queryAllByText(/Audio queued|Preparing audio|Audio needs attention|Audio unavailable for this version/)).toHaveLength(0);
    expect(screen.getByText(legacy.body)).toBeTruthy();
  });
  it("keeps result audio loaded while opening another item", async () => {
    let paused = true;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => { paused = false; });
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
    const other = { ...fixture, id: "other-item", title: "Another item" };
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response({ ...result(resultFixture), items: [resultFixture, other], total: 2 })
      : response({ item: String(url).includes("other-item") ? other : resultFixture }));
    render(<Inbox />);
    fireEvent.click(await screen.findByRole("button", { name: /Implemented cache invalidation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Play Implemented cache invalidation" }));
    await screen.findByRole("button", { name: "Pause audio" });
    const player = screen.getByLabelText("Inbox audio") as HTMLAudioElement;
    expect(player.getAttribute("src")).toBe("/api/items/agent-result/audio");
    fireEvent.click(screen.getByRole("button", { name: /Another item/ }));
    await screen.findByRole("heading", { name: "Another item" });
    expect(screen.getByLabelText("Inbox audio")).toBe(player);
    expect(player.getAttribute("src")).toBe("/api/items/agent-result/audio");
    expect(play).toHaveBeenCalledTimes(1);
  });
  it("rolls back a failed optimistic PATCH and refetches the list", async () => {
    navigation.url = "item=test-item";
    let finish: (response: Response) => void = () => {};
    fetchMock.mockImplementation(async (url, options) =>
      options?.method === "PATCH"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : String(url).startsWith("/api/items?")
          ? response(result())
          : response({ item: fixture }),
    );
    render(<Inbox />);
    await screen.findByRole("heading", { name: "Test release" });
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    expect(
      screen
        .getByRole("button", { name: "Mark unread" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByLabelText("0 unread items").textContent).toBe("0");
    await act(async () => finish(response({}, 500)));
    await screen.findByText(/Change could not be saved/);
    expect(
      screen
        .getByRole("button", { name: "Mark read" })
        .hasAttribute("disabled"),
    ).toBe(false);
    await waitFor(() =>
      expect(screen.getByLabelText("1 unread items").textContent).toBe("1"),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/items?"),
      ).length,
    ).toBe(2);
  });
  it("archives and restores with API-backed counts", async () => {
    navigation.url = "item=test-item";
    let item = { ...fixture };
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") {
        const patch = JSON.parse(options.body as string);
        item = {
          ...item,
          archivedAt: patch.archived ? "2026-10-10T13:00:00Z" : null,
        };
        return response({ item });
      }
      if (String(url).startsWith("/api/items?"))
        return response({
          items: item.archivedAt ? [] : [item],
          counts: {
            inbox: item.archivedAt ? 0 : 1,
            unread: item.archivedAt ? 0 : 1,
            archive: item.archivedAt ? 1 : 0,
          },
          total: item.archivedAt ? 0 : 1,
          nextCursor: null,
        });
      return response({ item });
    });
    render(<Inbox />);
    await screen.findByRole("heading", { name: "Test release" });
    fireEvent.click(screen.getByRole("button", { name: "Archive item" }));
    await waitFor(() =>
      expect(screen.getByLabelText("1 archive items").textContent).toBe("1"),
    );
    const restore = screen.getByRole("button", { name: "Restore to inbox" });
    await waitFor(() => expect(restore.hasAttribute("disabled")).toBe(false));
    fireEvent.click(restore);
    await waitFor(() =>
      expect(screen.getByLabelText("1 inbox items").textContent).toBe("1"),
    );
    expect(
      fetchMock.mock.calls
        .filter(([, options]) => options?.method === "PATCH")
        .map(([, options]) => JSON.parse(options!.body as string)),
    ).toEqual([{ archived: true }, { archived: false }]);
  });
  it("shows retry after an API error, then an honest empty state", async () => {
    fetchMock.mockResolvedValueOnce(response({}, 503)).mockResolvedValue(
      response({
        items: [],
        counts: { inbox: 0, unread: 0, archive: 0 },
        total: 0,
        nextCursor: null,
      }),
    );
    render(<Inbox />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Your inbox is empty");
    expect(screen.queryByText("Test release")).toBeNull();
  });
});


describe("theme, shortcuts and background updates", () => {
  it("persists a selected theme from the accessible menu and follows system changes", async () => {
    const user = userEvent.setup();
    api();
    const listeners = new Set<() => void>();
    let dark = false;
    vi.stubGlobal("matchMedia", () => ({ get matches() { return dark; },
      addEventListener: (_: string, callback: () => void) => listeners.add(callback),
      removeEventListener: (_: string, callback: () => void) => listeners.delete(callback),
    }));
    const first = render(<Inbox />);
    const trigger = screen.getByRole("button", { name: "Theme: system" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    first.unmount();
    render(<Inbox />);
    expect(screen.getByRole("button", { name: "Theme: dark" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Theme: dark" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Light/ }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Theme: light" }));
    await user.click(screen.getByRole("menuitemradio", { name: /System/ }));
    act(() => { dark = true; listeners.forEach(callback => callback()); });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await screen.findByRole("button", { name: /Test release/ });
  });
  it("focuses search with both shortcuts, clears it with Escape and returns mobile detail", async () => {
    api(); render(<Inbox />);
    await screen.findByRole("button", { name: /Test release/ });
    const search = screen.getByRole("searchbox");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "release" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Test release/ }));
    await screen.findByRole("heading", { name: "Test release" });
    fireEvent.keyDown(screen.getByRole("button", { name: /Playback speed/ }), { key: "Escape" });
    expect(navigation.url).toContain("item=test-item");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(navigation.url).not.toContain("item=");
    expect(document.activeElement).toBe(search);
    fireEvent.click(screen.getByRole("button", { name: /Test release/ }));
    await screen.findByRole("heading", { name: "Test release" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(navigation.url).not.toContain("item=");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(search);
  });
  it("refreshes loaded pages without a loading flash or replacing selected detail", async () => {
    navigation.url = "item=test-item";
    const older = { ...fixture, id: "older", title: "Older release" };
    const newest = { ...fixture, id: "new", title: "New arrival" };
    let updated = false;
    fetchMock.mockImplementation(async url => {
      if (!String(url).startsWith("/api/items?")) return response({ item: fixture });
      const paged = String(url).includes("cursor=");
      return response({ items: paged ? [older] : updated ? [newest, fixture] : [fixture],
        counts: { inbox: updated ? 3 : 2, unread: updated ? 3 : 2, archive: 0 },
        total: updated ? 3 : 2, nextCursor: paged ? null : "next" });
    });
    render(<Inbox />);
    await screen.findByRole("heading", { name: "Test release" });
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Older release/ });
    const heading = screen.getByRole("heading", { name: "Test release" });
    updated = true;
    act(() => serverChange());
    expect(screen.queryByLabelText("Loading items")).toBeNull();
    await screen.findByRole("button", { name: /New arrival/ });
    expect(screen.getByRole("button", { name: /Older release/ })).toBeTruthy();
    expect(screen.getByLabelText("3 inbox items")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Test release" })).toBe(heading);
  });
  it("rejects a stale live update arriving during a mutation and never polls", async () => {
    navigation.url = "item=test-item";
    let finishRefresh: (value: Response) => void = () => {};
    let refresh = false;
    let read = false;
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") { read = true; return response({ item: { ...fixture, readAt: "2026-10-10T13:00:00Z" } }); }
      if (!String(url).startsWith("/api/items?")) return response({ item: fixture });
      if (refresh && !read) return new Promise<Response>(resolve => { finishRefresh = resolve; });
      return response(result({ ...fixture, readAt: read ? "2026-10-10T13:00:00Z" : null }));
    });
    render(<Inbox />);
    await screen.findByRole("heading", { name: "Test release" });
    await screen.findByLabelText("1 unread items");
    refresh = true; act(() => serverChange());
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await screen.findByLabelText("0 unread items");
    await act(async () => finishRefresh(response(result())));
    expect(screen.getByLabelText("0 unread items")).toBeTruthy();
    const calls = fetchMock.mock.calls.length;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(60_000));
    expect(fetchMock.mock.calls.length).toBe(calls);
    vi.useRealTimers(); vi.restoreAllMocks();
  });
});


it("receives server updates without a refresh button, polling or focus refresh", async () => {
  api();
  vi.useFakeTimers();
  await act(async () => { render(<Inbox />); });
  const initial = fetchMock.mock.calls.length;
  expect(screen.queryByRole("button", { name: "Refresh items" })).toBeNull();
  await act(async () => vi.advanceTimersByTime(120_000));
  fireEvent.focus(window);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(fetchMock.mock.calls.length).toBe(initial);
  await act(async () => serverChange());
  expect(fetchMock.mock.calls.length).toBe(initial + 1);
  expect(screen.getByText("Live")).toBeTruthy();
  act(() => InboxEventSource.current.onerror?.());
  expect(screen.getByText("Reconnecting…")).toBeTruthy();
  await act(async () => serverChange(true));
  expect(fetchMock.mock.calls.length).toBe(initial + 2);
  expect(screen.getByText("Live")).toBeTruthy();
});


describe("immediate local navigation and detail races", () => {
  it("shows the full list item before its detail GET completes and never calls router.push", async () => {
    let finish: (value: Response) => void = () => {};
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response(result()) : new Promise<Response>(resolve => { finish = resolve; }));
    render(<Inbox />);
    fireEvent.click(await screen.findByRole("button", { name: /Test release/ }));
    expect(window.location.search).toBe("?item=test-item");
    expect(navigation.push).not.toHaveBeenCalled();
    const historyLength = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: /example.org.*Test release/ }));
    expect(window.history.length).toBe(historyLength);
    expect(screen.getByRole("heading", { name: "Test release" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Release details" })).toBeTruthy();
    expect(screen.queryByText("Loading item…")).toBeNull();
    await act(async () => finish(response({ item: { ...fixture, body: "Fresh server detail" } })));
    expect(screen.getByText("Fresh server detail")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/items?")).length).toBe(1);
  });

  it("keeps cached detail during retry and ignores an old selection response", async () => {
    const second = { ...fixture, id: "second", title: "Second release", body: "Second body" };
    const finishes: Array<(value: Response) => void> = [];
    fetchMock.mockImplementation(async url => String(url).startsWith("/api/items?")
      ? response({ ...result(), items: [fixture, second], total: 2 })
      : new Promise<Response>(resolve => { finishes.push(resolve); }));
    render(<Inbox />);
    fireEvent.click(await screen.findByRole("button", { name: /Test release/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second release/ }));
    await act(async () => finishes[0](response({ item: { ...fixture, title: "Stale first detail" } })));
    expect(screen.getByRole("heading", { name: "Second release" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Stale first detail" })).toBeNull();
    await act(async () => finishes[1](response({ item: { ...second, body: "Cached second body" } })));
    act(() => route(""));
    fireEvent.click(screen.getByRole("button", { name: /Second release/ }));
    expect(screen.getByText("Cached second body")).toBeTruthy();
    await act(async () => finishes[2](response({}, 503)));
    expect(screen.getByText("Cached second body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    expect(screen.getByText("Cached second body")).toBeTruthy();
    await act(async () => finishes[3](response({ item: second })));
  });

  it.each(["before", "after"])("ignores a stale detail GET arriving %s PATCH completion", async timing => {
    let finishGet: (value: Response) => void = () => {};
    let finishPatch: (value: Response) => void = () => {};
    let saved = false;
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") return new Promise<Response>(resolve => { finishPatch = resolve; });
      const item = { ...fixture, readAt: saved ? "2026-10-10T13:00:00Z" : null };
      if (String(url).startsWith("/api/items?")) return response(result(item));
      if (saved) return response({ item });
      return new Promise<Response>(resolve => { finishGet = resolve; });
    });
    render(<Inbox />);
    fireEvent.click(await screen.findByRole("button", { name: /Test release/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    if (timing === "before") await act(async () => finishGet(response({ item: fixture })));
    expect(screen.getByRole("button", { name: "Mark unread" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("0 unread items")).toBeTruthy();
    saved = true;
    await act(async () => finishPatch(response({ item: { ...fixture, readAt: "2026-10-10T13:00:00Z" } })));
    if (timing === "after") await act(async () => finishGet(response({ item: fixture })));
    expect(screen.getByRole("button", { name: "Mark unread" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("0 unread items")).toBeTruthy();
  });

  it("retains a pending mutation when navigating away and back without fetching pre-write detail", async () => {
    let finishPatch: (value: Response) => void = () => {};
    let item = fixture;
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") return new Promise<Response>(resolve => { finishPatch = resolve; });
      return String(url).startsWith("/api/items?") ? response(result(item)) : response({ item });
    });
    render(<Inbox />);
    fireEvent.click(await screen.findByRole("button", { name: /Test release/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/items/test-item")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    const getCalls = () => fetchMock.mock.calls.filter(([url, options]) =>
      url === "/api/items/test-item" && options?.method !== "PATCH").length;
    const beforeReturn = getCalls();
    act(() => route(""));
    fireEvent.click(screen.getByRole("button", { name: /Test release/ }));
    expect(screen.getByRole("button", { name: "Mark unread" }).hasAttribute("disabled")).toBe(true);
    expect(getCalls()).toBe(beforeReturn);
    item = { ...fixture, readAt: "2026-10-10T13:00:00Z" };
    await act(async () => finishPatch(response({ item })));
    expect(screen.getByRole("button", { name: "Mark unread" }).hasAttribute("disabled")).toBe(false);
    expect(getCalls()).toBe(beforeReturn + 1);
    expect(screen.getByLabelText("0 unread items")).toBeTruthy();
  });

  it("uses real Back and Forward entries, preserving filters and focus", async () => {
    api();
    // Next updates useSearchParams on popstate; leave traversal to real browser history.
    const onPop = () => {
      navigation.url = window.location.search.slice(1);
      navigation.listeners.forEach(fn => fn());
    };
    window.addEventListener("popstate", onPop);
    try {
      route("view=all&kind=alert&q=release");
      render(<Inbox />);
      fireEvent.click(await screen.findByRole("button", { name: /Test release/ }));
      await screen.findByRole("heading", { name: "Test release" });
      act(() => window.history.back());
      await screen.findByRole("heading", { name: "Select an item to read" });
      expect(window.location.search).toBe("?view=all&kind=alert&q=release");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /Test release/ }));
      act(() => window.history.forward());
      await screen.findByRole("heading", { name: "Test release" });
      expect(window.location.search).toContain("item=test-item");
      expect(navigation.push).not.toHaveBeenCalled();
    } finally { window.removeEventListener("popstate", onPop); }
  });
});


describe("Inbox playback navigation", () => {
  it("keeps audio node, source, position and playing across selection, search, filter, archive view, refresh and Back", async () => {
    let paused = true;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => { paused = false; });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => { paused = true; });
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
    const other = { ...fixture, id: "other", title: "Other recording" };
    fetchMock.mockImplementation(async (url) => String(url).startsWith("/api/items?")
      ? response({ ...result(), items: [fixture, other], total: 2 })
      : response({ item: String(url).includes("other") ? other : fixture }));
    const onPop = () => { navigation.url = window.location.search.slice(1); navigation.listeners.forEach(fn => fn()); };
    window.addEventListener("popstate", onPop);
    try {
      let inboxCommits = 0;
      render(<Profiler id="inbox" onRender={() => { inboxCommits++; }}><Inbox /></Profiler>);
      fireEvent.click(await screen.findByRole("button", { name: /Test release/ }));
      fireEvent.click(screen.getByRole("button", { name: "Play Test release" }));
      await screen.findByRole("button", { name: "Pause audio" });
      const node = screen.getByLabelText("Inbox audio") as HTMLAudioElement;
      node.currentTime = 43;
      vi.spyOn(HTMLMediaElement.prototype, "currentSrc", "get").mockImplementation(() => node.src);
      vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(1);
      vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(125);
      const commitsBeforeProgress = inboxCommits;
      fireEvent.timeUpdate(node);
      expect(inboxCommits).toBe(commitsBeforeProgress);
      expect(screen.getByRole("slider", { name: "Audio position" }).getAttribute("aria-valuetext")).toBe("0:43 of 2:05");
      const pauseCount = pause.mock.calls.length;
      const unchanged = () => {
        expect(screen.getByLabelText("Inbox audio")).toBe(node);
        expect(node.getAttribute("src")).toBe("/api/items/test-item/audio");
        expect(node.currentTime).toBe(43);
        expect(play).toHaveBeenCalledTimes(1);
        expect(pause.mock.calls.length).toBe(pauseCount);
        expect(screen.getByRole("button", { name: "Pause audio" })).toBeTruthy();
      };
      fireEvent.click(screen.getByRole("button", { name: /Other recording/ }));
      await screen.findByRole("heading", { name: "Other recording" }); unchanged();
      fireEvent.change(screen.getByLabelText("Search items"), { target: { value: "release" } });
      fireEvent.submit(screen.getByRole("search"));
      await screen.findByRole("heading", { name: "Select an item to read" }); unchanged();
      fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
      await waitFor(() => expect(window.location.search).toContain("kind=alert")); unchanged();
      fireEvent.click(screen.getByRole("button", { name: /Archive0 archive items/ }));
      await screen.findByRole("heading", { name: "Archive" }); unchanged();
      await act(async () => serverChange()); unchanged();
      fireEvent.click(screen.getByRole("button", { name: "Open playing item: Test release" }));
      await screen.findByRole("heading", { name: "Test release" }); unchanged();
      expect(window.location.search).toContain("view=archive");
      expect(window.location.search).toContain("q=release");
      act(() => window.history.back());
      await screen.findByRole("heading", { name: "Select an item to read" }); unchanged();
    } finally { window.removeEventListener("popstate", onPop); }
  });
});

describe("live invalidation integration", () => {
  it("generates missing report audio only on click, then reveals Play after live completion", async () => {
    let report: InboxItem = {
      ...resultFixture,
      audioAvailable: false, audioDuration: null, audioStatus: null,
      report: { version: 1, title: "Structured report", sections: [{ id: "findings", title: "Findings", blocks: [{ type: "text", text: "Verified findings", sourceIds: [] }] }], sources: [] },
    };
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === "POST") {
        report = { ...report, audioStatus: "queued" };
        return response({ item: report }, 202);
      }
      return String(url).startsWith("/api/items?") ? response(result(report)) : response({ item: report });
    });
    route("item=agent-result");
    render(<Inbox />);
    const generate = await screen.findByRole("button", { name: "Generate audio for Implemented cache invalidation" });
    expect(screen.getByText("Verified findings")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    fireEvent.click(generate);
    fireEvent.click(generate);
    await screen.findByRole("button", { name: "Audio queued for Implemented cache invalidation" });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    report = { ...report, audioStatus: "generating" };
    await act(async () => serverChange());
    await screen.findByRole("button", { name: "Preparing audio for Implemented cache invalidation" });
    report = { ...report, audioAvailable: true, audioDuration: 95, audioStatus: "ready" };
    await act(async () => serverChange());
    const control = await screen.findByRole("button", { name: "Play Implemented cache invalidation" });
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(control);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  });
  it("reveals playback when queued audio becomes ready without autoplaying or replacing the current track", async () => {
    let report: InboxItem = {
      ...resultFixture,
      audioAvailable: false,
      audioDuration: null,
      audioStatus: "queued" as const,
    };
    let paused = true;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => { paused = false; });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => { paused = true; });
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
    fetchMock.mockImplementation(async url => {
      const value = String(url);
      if (value.startsWith("/api/items?"))
        return response({ items: [report, fixture], nextCursor: null, counts: { inbox: 2, unread: 2, archive: 0 }, total: 2 });
      return response({ item: value.includes("test-item") ? fixture : report });
    });
    route("item=agent-result");
    render(<Inbox />);
    await screen.findByRole("heading", { name: report.title });
    expect(screen.getAllByText("Audio queued").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Test release/ }));
    await screen.findByRole("heading", { name: fixture.title });
    fireEvent.click(screen.getByRole("button", { name: "Play Test release" }));
    await screen.findByRole("button", { name: "Pause audio" });
    const audio = screen.getByLabelText("Inbox audio") as HTMLAudioElement;
    audio.currentTime = 38;
    fireEvent.click(screen.getByRole("button", { name: /Implemented cache invalidation/ }));
    await screen.findByRole("heading", { name: report.title });
    const playCount = play.mock.calls.length;
    const pauseCount = pause.mock.calls.length;

    report = { ...report, audioAvailable: true, audioDuration: 95, audioStatus: "ready" };
    await act(async () => serverChange());
    await screen.findByRole("button", { name: "Play Implemented cache invalidation" });

    expect(screen.getByLabelText("Inbox audio")).toBe(audio);
    expect(audio.getAttribute("src")).toBe("/api/items/test-item/audio");
    expect(audio.currentTime).toBe(38);
    expect(play).toHaveBeenCalledTimes(playCount);
    expect(pause).toHaveBeenCalledTimes(pauseCount);
  });
  it("defers an event during a write and updates selected detail outside the list", async () => {
    route("item=test-item");
    let finishPatch!: (value: Response) => void;
    let updated = false;
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") return new Promise<Response>(resolve => { finishPatch = resolve; });
      const item = { ...fixture, body: updated ? "Updated report from the server" : fixture.body,
        readAt: updated ? "2026-10-10T14:00:00Z" : null };
      if (String(url).startsWith("/api/items?")) return response({ ...result(item), items: [] });
      return response({ item });
    });
    render(<Inbox />);
    await screen.findByRole("heading", { name: "Release details" });
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    updated = true;
    await act(async () => { serverChange(); serverChange(); });
    expect(screen.queryByText("Updated report from the server")).toBeNull();
    await act(async () => finishPatch(response({ item: { ...fixture, readAt: "2026-10-10T14:00:00Z" } })));
    await screen.findByText("Updated report from the server");
    expect(screen.getByRole("button", { name: "Mark unread" })).toBeTruthy();
    expect(window.location.search).toBe("?item=test-item");
  });
  it("retains an event while loading another page and replays all loaded pages", async () => {
    const older = { ...fixture, id: "older", title: "Older report" };
    const newest = { ...fixture, id: "new", title: "Newest report" };
    let updated = false;
    let finishPage!: (value: Response) => void;
    let pageHeld = false;
    fetchMock.mockImplementation(async url => {
      const paged = String(url).includes("cursor=");
      if (paged && !pageHeld) {
        pageHeld = true;
        return new Promise<Response>(resolve => { finishPage = resolve; });
      }
      return response({ items: paged ? [older] : updated ? [newest, fixture] : [fixture],
        nextCursor: paged ? null : "next", total: updated ? 3 : 2,
        counts: { inbox: updated ? 3 : 2, unread: updated ? 3 : 2, archive: 0 } });
    });
    render(<Inbox />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    updated = true;
    await act(async () => serverChange());
    expect(screen.queryByRole("button", { name: /Newest report/ })).toBeNull();
    await act(async () => finishPage(response({ items: [older], nextCursor: null, total: 2,
      counts: { inbox: 2, unread: 2, archive: 0 } })));
    await screen.findByRole("button", { name: /Newest report/ });
    expect(screen.getByRole("button", { name: /Older report/ })).toBeTruthy();
    expect(screen.getByLabelText("3 inbox items")).toBeTruthy();
  });
});
