import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { Inbox, type InboxItem } from "./inbox";

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
  edition: null,
  publishedAt: "2026-10-10T12:00:00Z",
  body: "## Release details\nRead the [official source](https://example.org/release).",
  summary: "A test-only summary.",
  sources: [{ title: "Official source", url: "https://example.org/release" }],
  audioAvailable: true,
  audioDuration: 125,
  readAt: null,
  archivedAt: null,
  tags: ["test"],
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
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
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
    const audio = screen.getByLabelText("Listen to Test release");
    expect(audio.getAttribute("autoplay")).toBeNull();
    fireEvent.change(screen.getByLabelText("Playback speed"), {
      target: { value: "1.5" },
    });
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
    fireEvent.change(screen.getByLabelText("Show"), {
      target: { value: "alert" },
    });
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
  it("persists a selected theme across remounts and follows system changes", async () => {
    api();
    const listeners = new Set<() => void>();
    let dark = false;
    vi.stubGlobal("matchMedia", () => ({ get matches() { return dark; },
      addEventListener: (_: string, callback: () => void) => listeners.add(callback),
      removeEventListener: (_: string, callback: () => void) => listeners.delete(callback),
    }));
    const first = render(<Inbox />);
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    first.unmount();
    render(<Inbox />);
    expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe("dark");
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "light" } });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "system" } });
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
    fireEvent.keyDown(screen.getByLabelText("Playback speed"), { key: "Escape" });
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
    fireEvent.focus(window);
    expect(screen.queryByLabelText("Loading items")).toBeNull();
    await screen.findByRole("button", { name: /New arrival/ });
    expect(screen.getByRole("button", { name: /Older release/ })).toBeTruthy();
    expect(screen.getByLabelText("3 inbox items")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Test release" })).toBe(heading);
  });
  it("rejects a stale refresh arriving during a mutation and pauses checks while hidden", async () => {
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
    refresh = true; fireEvent.focus(window);
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


it("checks every minute only while visible and refreshes on return", async () => {
  api();
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => { render(<Inbox />); });
  const initial = fetchMock.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(fetchMock.mock.calls.length).toBe(initial + 1);
  visibility.mockReturnValue("hidden");
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(fetchMock.mock.calls.length).toBe(initial + 1);
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetchMock.mock.calls.length).toBe(initial + 2);
  visibility.mockRestore();
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
    fireEvent.click(screen.getByRole("button", { name: /Test release/ }));
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
