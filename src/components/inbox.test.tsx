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
  navigation.url = url.replace(/^\/\?/, "");
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
  navigation.url = "";
  navigation.push.mockReset().mockImplementation((url) => route(url));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    fetchMock
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValue(
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
