"use client";

import { useEffect, useRef, useState, useCallback, useLayoutEffect, memo } from "react";
import { useSearchParams } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowUpRight,
  BellRing,
  Check,
  ChevronRight,
  FileSearch,
  Inbox as InboxIcon,
  LoaderCircle,
  Mail,
  MailOpen,
  Moon,
  Menu,
  Newspaper,
  RefreshCw,
  Search,
  Sun,
  SunMoon,
  X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DetailPlayControl } from "@/components/audio-player";
import { AudioJobStatus } from "@/components/audio-job-status";
import { useInboxEvents } from "@/components/use-inbox-events";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";

import type { InboxItem, ItemView, ItemList } from "@/lib/contracts";
import { NotificationType, notificationTypeLabel } from "@/components/notification-type";
import { InboxMark } from "@/components/inbox-mark";
export type { InboxItem } from "@/lib/contracts";
type View = ItemView;
type ListResult = ItemList;
const views: { value: View; title: string; icon: typeof InboxIcon }[] = [
  { value: "inbox", title: "Inbox", icon: InboxIcon },
  { value: "unread", title: "Unread", icon: Mail },
  { value: "archive", title: "Archive", icon: Archive },
  { value: "all", title: "All items", icon: Newspaper },
];
const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const detailDateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "long",
  timeStyle: "short",
});
function formatDate(value: string, full = false) {
  const d = new Date(value);
  return Number.isNaN(d.valueOf())
    ? "Unknown date"
    : (full ? detailDateFormat : dateFormat).format(d);
}
function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function readingBody(item: InboxItem) {
  const parts = item.body.split(/\n\s*\n/);
  const first = parts[0]?.replace(/^#{1,6}\s+/, "").replace(/[*_`~]/g, "").trim();
  return first === item.title ? parts.slice(1).join("\n\n") : item.body;
}
function sourceLabel(item: InboxItem) {
  if (item.kind === "result") return item.origin?.host || item.origin?.project || "";
  const source = item.sources[0];
  if (!source)
    return item.kind === "briefing" ? "Daily briefing" : "Release alert";
  try {
    return new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    return source.title;
  }
}
function safeThreadUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname && !url.username && !url.password)
      return url.href;
    if (url.protocol === "t3-thread:" && url.hostname === "v1" &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^\/[A-Za-z0-9_-]+$/.test(url.pathname))
      return `t3-thread://v1${url.pathname}`;
  } catch { /* Malformed or unsupported thread references are not links. */ }
  return undefined;
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This item is no longer available."
        : response.status === 401 || response.status === 403
          ? "Access was denied. Check your connection and access settings."
          : "The inbox could not be reached. Please try again.",
    );
  return response.json() as Promise<T>;
}
function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="state-panel" role="alert">
      <p className="state-title">Unable to load</p>
      <p>{message}</p>
      <Button variant="outline" onClick={retry}>
        <RefreshCw />
        Try again
      </Button>
    </div>
  );
}
function ListSkeleton() {
  return (
    <div
      aria-busy="true"
      role="status"
      aria-label="Loading items"
      className="skeleton-list"
    >
      {[1, 2, 3, 4].map((i) => (
        <div className="skeleton-row" key={i}>
          <div className="skeleton short" />
          <div className="skeleton" />
          <div className="skeleton medium" />
        </div>
      ))}
      <span className="sr-only">Loading items…</span>
    </div>
  );
}

export function Inbox() {
  const params = useSearchParams();
  const rawView = params.get("view");
  const view: View = views.some((v) => v.value === rawView)
    ? (rawView as View)
    : "inbox";
  const q = params.get("q") || "";
  const rawKind = params.get("kind");
  const kind = rawKind === "briefing" || rawKind === "alert" || rawKind === "result" ? rawKind : "";
  const selectedId = params.get("item");
  const [search, setSearch] = useState(q);
  const searchInput = useRef<HTMLInputElement>(null);
  const focusSearchAfterNavigation = useRef(false);
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ai-inbox-theme");
      if (saved === "light" || saved === "dark" || saved === "system") setTheme(saved);
    } catch { /* Storage may be unavailable; system remains usable. */ }
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  const [list, setList] = useState<ListResult | null>(null);
  const [fetchedDetail, setDetail] = useState<InboxItem | null>(null);
  // Bound retained full bodies; the current list is also a valid immediate detail.
  const detailCache = useRef(new Map<string, InboxItem>());
  const rememberDetail = useCallback((item: InboxItem) => {
    const cache = detailCache.current;
    cache.delete(item.id);
    cache.set(item.id, item);
    if (cache.size > 60) cache.delete(cache.keys().next().value!);
  }, []);
  const detailController = useRef<AbortController | null>(null);
  const detailRevision = useRef(0);
  const mutatingId = useRef<string | null>(null);
  const detail = selectedId
    ? (fetchedDetail?.id === selectedId ? fetchedDetail :
      detailCache.current.get(selectedId) ?? list?.items.find(item => item.id === selectedId) ?? null)
    : null;
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const actionFocus = useRef<{ id: string; button: HTMLButtonElement } | null>(
    null,
  );
  const [refresh, setRefresh] = useState(0);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [liveVersion, setLiveVersion] = useState(0);
  const liveDirty = useRef(false);
  const connectionStatus = useInboxEvents(useCallback(() => {
    liveDirty.current = true;
    setLiveVersion(version => version + 1);
  }, []));
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const loadedQuery = useRef("");
  const loadedPages = useRef(1);
  const refreshController = useRef<AbortController | null>(null);
  const busy = useRef({ pending, moreLoading, loading });
  busy.current = { pending, moreLoading, loading };
  const listRef = useRef(list);
  listRef.current = list;
  const scrollAnchor = useRef<{ node: HTMLButtonElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    if (anchor?.node.isConnected) {
      const scroller = anchor.node.closest(".item-list");
      if (scroller) scroller.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top;
    }
    scrollAnchor.current = null;
  }, [list]);
  const currentRoute = useRef({
    listQuery: "",
    selectedId: "" as string | null,
  });
  const [navOpen, setNavOpen] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const itemButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousSelection = useRef<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const paginationRequest = useRef(0);
  const listQuery = new URLSearchParams({
    view,
    q,
    ...(kind ? { kind } : {}),
    limit: "30",
  }).toString();
  currentRoute.current = { listQuery, selectedId };
  const navigate = useCallback(
    (changes: Record<string, string | null>) => {
      // Read the live URL so successive clicks cannot merge against an old render.
      const next = new URLSearchParams(window.location.search);
      Object.entries(changes).forEach(([key, value]) =>
        value ? next.set(key, value) : next.delete(key),
      );
      const query = next.toString();
      const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`)
        window.history.pushState(null, "", url);
    },
    [],
  );
  useEffect(() => {
    setSearch(q);
  }, [q]);
  useEffect(() => {
    setActionError("");
  }, [selectedId]);
  useEffect(() => {
    const controller = new AbortController();
    refreshController.current = controller;
    const quiet = loadedQuery.current === listQuery && !!listRef.current;
    if (!quiet) {
      loadedPages.current = 1;
      paginationRequest.current++;
      setLoading(true);
      setMoreError("");
      setMoreLoading(false);
    }
    setListError("");
    setRefreshError("");
    const pages = loadedPages.current;
    const lastId = listRef.current?.items.at(-1)?.id;
    async function reload() {
      let data = await request<ListResult>(`/api/items?${listQuery}`, { signal: controller.signal });
      let fetchedPages = 1;
      // Re-read loaded pages; one extra page accommodates newly inserted rows.
      while (data.nextCursor && (fetchedPages < pages ||
        (quiet && fetchedPages === pages && lastId && !data.items.some(item => item.id === lastId)))) {
        const next = await request<ListResult>(`/api/items?${listQuery}&cursor=${encodeURIComponent(data.nextCursor)}`, { signal: controller.signal });
        data = { ...next, items: [...data.items, ...next.items.filter(item => !data.items.some(old => old.id === item.id))] };
        fetchedPages++;
      }
      if (controller.signal.aborted) return;
      if (quiet) {
        const scroller = document.getElementById("item-list");
        const top = scroller?.getBoundingClientRect().top ?? 0;
        const node = [...itemButtons.current.values()].find(button => button.getBoundingClientRect().bottom > top);
        if (node && scroller && scroller.scrollTop > 0) scrollAnchor.current = { node, top: node.getBoundingClientRect().top };
      }
      loadedPages.current = fetchedPages;
      loadedQuery.current = listQuery;
      setList(data);
      setLoading(false);
    }
    void reload().catch(error => {
      if (controller.signal.aborted) return;
      if (quiet) setRefreshError("Refresh failed. Your loaded items are still available.");
      else { setListError(error.message); setLoading(false); }
    });
    return () => controller.abort();
  }, [listQuery, refresh]);
  useEffect(() => {
    // Retain invalidations during initial loading, pagination or a local write.
    // The existing loaders abort stale reads and preserve loaded pages/scroll.
    if (!liveDirty.current || busy.current.pending || busy.current.moreLoading || busy.current.loading) return;
    liveDirty.current = false;
    setRefresh(version => version + 1);
    setDetailRefresh(version => version + 1);
  }, [liveVersion, pending, moreLoading, loading]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (selectedId && window.matchMedia("(max-width: 640px)").matches) {
          focusSearchAfterNavigation.current = true;
          navigate({ item: null });
        }
        searchInput.current?.focus({ preventScroll: true });
        searchInput.current?.select();
        return;
      }
      if (event.key !== "Escape" || navOpen) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target === searchInput.current) {
        if (search || q) { event.preventDefault(); setSearch(""); navigate({ q: null, item: null }); }
        return;
      }
      if (target?.closest("button, input, textarea, select, [contenteditable], [role='dialog'], [role='menu']")) return;
      if (selectedId && window.matchMedia("(max-width: 640px)").matches) {
        event.preventDefault(); navigate({ item: null });
      } else if (search || q) {
        event.preventDefault(); setSearch(""); navigate({ q: null });
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [navigate, selectedId, search, q, navOpen]);
  useEffect(() => {
    setDetailError("");
    if (!selectedId) {
      setDetailLoading(false);
      return;
    }
    // A GET started before a write must never restore pre-write reading state.
    if (mutatingId.current === selectedId) return;
    const controller = new AbortController();
    detailController.current = controller;
    const revision = detailRevision.current;
    setDetailLoading(true);
    request<{ item: InboxItem }>(
      `/api/items/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    )
      .then(({ item }) => {
        if (controller.signal.aborted || revision !== detailRevision.current ||
          currentRoute.current.selectedId !== selectedId) return;
        rememberDetail(item);
        setDetail(item);
        setDetailLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted && revision === detailRevision.current &&
          currentRoute.current.selectedId === selectedId) {
          setDetailError(error.message);
          setDetailLoading(false);
        }
      });
    return () => controller.abort();
  }, [selectedId, detailRefresh, rememberDetail]);
  useEffect(() => {
    if (!selectedId && focusSearchAfterNavigation.current) {
      searchInput.current?.focus({ preventScroll: true });
      searchInput.current?.select();
      focusSearchAfterNavigation.current = false;
    } else if (!selectedId && previousSelection.current)
      (
        itemButtons.current.get(previousSelection.current) ??
        listHeading.current
      )?.focus({ preventScroll: true });
    previousSelection.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    if (detail) detailHeading.current?.focus({ preventScroll: true });
  }, [selectedId, detail?.id]);

  async function loadMore() {
    if (!list?.nextCursor || moreLoading) return;
    refreshController.current?.abort();
    const token = ++paginationRequest.current;
    busy.current.moreLoading = true;
    setMoreLoading(true);
    setMoreError("");
    try {
      const result = await request<ListResult>(
        `/api/items?${listQuery}&cursor=${encodeURIComponent(list.nextCursor)}`,
      );
      if (token !== paginationRequest.current) return;
      loadedPages.current++;
      setList((current) =>
        current
          ? {
              ...result,
              items: [
                ...current.items,
                ...result.items.filter(
                  (item) => !current.items.some((old) => old.id === item.id),
                ),
              ],
            }
          : result,
      );
    } catch (error) {
      if (token === paginationRequest.current)
        setMoreError((error as Error).message);
    } finally {
      if (token === paginationRequest.current) setMoreLoading(false);
    }
  }
  useEffect(() => {
    if (!pending && actionFocus.current) {
      const { id, button } = actionFocus.current;
      if (id === selectedId && button.isConnected)
        button.focus({ preventScroll: true });
      actionFocus.current = null;
    }
  }, [pending, selectedId]);

  async function mutate(
    patch: { read?: boolean; archived?: boolean },
    trigger?: HTMLButtonElement,
  ) {
    if (!detail || mutatingId.current) return;
    if (trigger) actionFocus.current = { id: detail.id, button: trigger };
    const mutationQuery = listQuery;
    const previous = detail;
    const previousList = list;
    mutatingId.current = detail.id;
    detailRevision.current++;
    detailController.current?.abort();
    setDetailLoading(false);
    const optimistic = {
      ...detail,
      ...(patch.read !== undefined
        ? { readAt: patch.read ? new Date().toISOString() : null }
        : {}),
      ...(patch.archived !== undefined
        ? { archivedAt: patch.archived ? new Date().toISOString() : null }
        : {}),
    };
    refreshController.current?.abort();
    paginationRequest.current++;
    setMoreLoading(false);
    busy.current.pending = true;
    setPending(true);
    setActionError("");
    rememberDetail(optimistic);
    setDetail(optimistic);
    setList((current) => {
      if (!current) return current;
      const matches = (item: InboxItem) =>
        view === "all" ||
        (view === "archive"
          ? !!item.archivedAt
          : !item.archivedAt && (view !== "unread" || !item.readAt));
      const metric = (item: InboxItem) => ({
        inbox: Number(!item.archivedAt),
        unread: Number(!item.archivedAt && !item.readAt),
        archive: Number(!!item.archivedAt),
      });
      const before = metric(previous),
        after = metric(optimistic);
      return {
        ...current,
        items: current.items
          .map((item) => (item.id === optimistic.id ? optimistic : item))
          .filter(matches),
        total: Math.max(
          0,
          current.total -
            Number(
              current.items.some((item) => item.id === previous.id) &&
                !matches(optimistic),
            ),
        ),
        counts: {
          inbox: current.counts.inbox + after.inbox - before.inbox,
          unread: current.counts.unread + after.unread - before.unread,
          archive: current.counts.archive + after.archive - before.archive,
        },
      };
    });
    try {
      const { item } = await request<{ item: InboxItem }>(
        `/api/items/${encodeURIComponent(previous.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      rememberDetail(item);
      setDetail((current) => (current?.id === item.id ? item : current));
    } catch (error) {
      rememberDetail(previous);
      setDetail((current) =>
        current?.id === previous.id ? previous : current,
      );
      if (currentRoute.current.listQuery === mutationQuery)
        setList(previousList);
      if (currentRoute.current.selectedId === previous.id) {
        setActionError(
          `Change could not be saved. ${(error as Error).message}`,
        );
      }
    } finally {
      mutatingId.current = null;
      setDetailRefresh((n) => n + 1);
      setPending(false);
      setRefresh((n) => n + 1);
    }
  }
  const currentView = views.find((v) => v.value === view)!;
  const navigation = (
    <>
      <div className="sidebar-brand">
        <InboxMark className="brand-mark" />
        <span>AI Inbox</span>
      </div>
      <nav aria-label="Inbox views" className="nav-list">
        {views.map(({ value, title, icon: Icon }) => (
          <Button
            key={value}
            variant="ghost"
            className={`nav-item ${view === value ? "active" : ""}`}
            aria-current={view === value ? "page" : undefined}
            onClick={() => {
              navigate({ view: value, item: null });
              setNavOpen(false);
            }}
          >
            <Icon size={18} />
            <span>{title}</span>
            {value !== "all" && list && (
              <span
                className="nav-count"
                aria-label={`${list.counts[value]} ${title.toLowerCase()} items`}
              >
                {list.counts[value]}
              </span>
            )}
          </Button>
        ))}
      </nav>
      <div className="theme-control">
        <span className="theme-label">Theme</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button variant="outline" className="theme-trigger" aria-label={`Theme: ${theme}`}>
              {theme === "light" ? <Sun aria-hidden="true" /> : theme === "dark" ? <Moon aria-hidden="true" /> : <SunMoon aria-hidden="true" />}
              <span>{theme[0].toUpperCase() + theme.slice(1)}</span>
              <ChevronRight className="theme-chevron" aria-hidden="true" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="inbox-theme-menu" align="end" sideOffset={8}>
              <DropdownMenu.Label className="inbox-theme-menu-label">Appearance</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={theme} onValueChange={value => {
            const nextTheme = value as typeof theme;
            setTheme(nextTheme);
            try { localStorage.setItem("ai-inbox-theme", nextTheme); } catch { /* Use the selected theme for this session. */ }
          }}>
                {(["system", "light", "dark"] as const).map(value => {
                  const Icon = value === "system" ? SunMoon : value === "light" ? Sun : Moon;
                  return (
                    <DropdownMenu.RadioItem key={value} className="inbox-theme-option" value={value}>
                      <Icon aria-hidden="true" />
                      <span>{value[0].toUpperCase() + value.slice(1)}</span>
                      <DropdownMenu.ItemIndicator className="inbox-theme-check"><Check aria-hidden="true" /></DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  );
                })}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <p>Ctrl/⌘ K search · Esc back / clear</p>
      </div>
      <div className="sidebar-footer">
        <span className="status-dot" />
        Private inbox
      </div>
    </>
  );
  return (
    <div className="inbox-shell">
      <a href="#item-list" className="skip-link">
        Skip to items
      </a>
      <aside className="sidebar">{navigation}</aside>
      <main className={`workspace ${selectedId ? "has-selection" : ""}`}>
        <section
          className="list-panel"
          aria-label={`${currentView.title} items`}
        >
          <header className="list-header">
            <div className="heading-row">
              <Sheet open={navOpen} onOpenChange={setNavOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mobile-menu"
                    aria-label="Open navigation"
                  >
                    <Menu />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="mobile-sidebar">
                  <SheetTitle className="sr-only">Inbox navigation</SheetTitle>
                  <SheetDescription className="sr-only">
                    Choose which items to view.
                  </SheetDescription>
                  {navigation}
                </SheetContent>
              </Sheet>
              <div>
                <h1 ref={listHeading} tabIndex={-1}>
                  {currentView.title}
                </h1>
                <p className="result-count" role="status" aria-live="polite">
                  {loading
                    ? "Loading items…"
                    : listError
                      ? "Connection unavailable"
                      : `${list?.total ?? 0} ${list?.total === 1 ? "item" : "items"}${q ? " found" : ""}`}
                </p>
              </div>
              <span className="live-connection" data-state={connectionStatus} role="status" aria-live="polite">
                <span aria-hidden="true" />
                <span className="live-connection-label">{connectionStatus === "connected" ? "Live" : connectionStatus === "reconnecting" ? "Reconnecting…" : "Live connection unavailable"}</span>
              </span>
            </div>
            <form
              className="search-form"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                navigate({ q: search.trim(), item: null });
              }}
            >
              <Search size={17} className="search-icon" />
              <Input
                ref={searchInput}
                aria-keyshortcuts="Control+k Meta+k"
                aria-describedby="search-shortcuts"
                type="search"
                aria-label="Search items"
                placeholder="Search your inbox"
                maxLength={300}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Clear search"
                  onClick={() => {
                    setSearch("");
                    navigate({ q: null, item: null });
                  }}
                >
                  <X />
                </Button>
              )}
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                aria-label="Run search"
              >
                <ChevronRight />
              </Button>
            </form>
            <span id="search-shortcuts" className="sr-only">Ctrl or Command K focuses search. Escape clears search; outside inputs, Escape returns to the list on mobile.</span>
            {refreshError && <p className="pagination-error" role="status">{refreshError}</p>}
            <div className="filter-row">
              <div className="type-filter" role="group" aria-label="Filter by type">
                {([
                  { value: "", label: "All", Icon: InboxIcon },
                  { value: "briefing", label: "Briefings", Icon: Newspaper },
                  { value: "alert", label: "Alerts", Icon: BellRing },
                  { value: "result", label: "Agent results", Icon: FileSearch },
                ] as const).map(({ value, label, Icon }) => (
                  <Button
                    key={value || "all"}
                    type="button"
                    variant="ghost"
                    className="type-filter-chip"
                    aria-pressed={kind === value}
                    onClick={() => navigate({ kind: value || null, item: null })}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </Button>
                ))}
              </div>
              {q && (
                <span className="query-label" title={q}>
                  “{q}”
                </span>
              )}
            </div>
          </header>
          <div
            id="item-list"
            className="item-list"
            tabIndex={-1}
            aria-busy={loading}
          >
            {loading ? (
              <ListSkeleton />
            ) : listError ? (
              <ErrorState
                message={listError}
                retry={() => setRefresh((n) => n + 1)}
              />
            ) : !list?.items.length ? (
              <div className="state-panel empty-state">
                <currentView.icon size={28} strokeWidth={1.4} />
                <p className="state-title">
                  {q || kind
                    ? "No matching items"
                    : view === "unread"
                      ? "You’re all caught up"
                      : view === "archive"
                        ? "No archived items"
                        : "Your inbox is empty"}
                </p>
                <p>
                  {q || kind
                    ? "Try another search or change the type filter."
                    : view === "archive"
                      ? "Items you archive will appear here."
                      : "Briefings, release alerts, and agent results will appear here when they arrive."}
                </p>
                {(q || kind) && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      navigate({ q: null, kind: null, item: null })
                    }
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <>
                <ul className="items">
                  {list.items.map((item) => (
                    <li key={item.id}>
                      <button
                        ref={(node) => {
                          if (node) itemButtons.current.set(item.id, node);
                          else itemButtons.current.delete(item.id);
                        }}
                        className={`item-row ${selectedId === item.id ? "selected" : ""} ${!item.readAt ? "unread" : ""}`}
                        aria-current={
                          selectedId === item.id ? "true" : undefined
                        }
                        onClick={() => navigate({ item: item.id })}
                      >
                        <span className="item-meta">
                          <NotificationType kind={item.kind} resultType={item.resultType} audioAvailable={item.audioAvailable} />
                          {sourceLabel(item) && <span className="source-name">{sourceLabel(item)}</span>}
                          <time dateTime={item.publishedAt}>
                            {formatDate(item.publishedAt)}
                          </time>
                        </span>
                        <span className="item-title">
                          {!item.readAt && (
                            <span className="unread-dot">
                              <span className="sr-only">Unread: </span>
                            </span>
                          )}
                          {item.title}
                        </span>
                        <span className="item-summary">
                          {item.summary || "Open to read this item."}
                        </span>
                        <span className="item-foot">
                          {item.kind === "briefing" && item.edition && <span>{item.edition[0].toUpperCase() + item.edition.slice(1)} edition</span>}
                          {item.archivedAt && <span>Archived</span>}
                          {item.kind === "result" && !item.audioAvailable && item.audioStatus && item.audioStatus !== "ready" && (
                            <AudioJobStatus status={item.audioStatus} variant="compact" />
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {moreError && (
                  <p className="pagination-error" role="alert">
                    {moreError}
                  </p>
                )}
                {list.nextCursor && (
                  <div className="load-more">
                    <Button
                      variant="outline"
                      disabled={moreLoading}
                      onClick={loadMore}
                    >
                      {moreLoading ? <LoaderCircle className="spin" /> : null}
                      {moreLoading
                        ? "Loading…"
                        : moreError
                          ? "Retry loading more"
                          : "Load more"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
        <section
          className="detail-panel"
          aria-label="Item detail"
          aria-busy={detailLoading && !detail}
        >
          {selectedId ? (
            <>
              <header className="detail-toolbar">
                <Button
                  variant="ghost"
                  size="sm"
                  className="back-button"
                  aria-keyshortcuts="Escape"
                  title="Back to list (Esc)"
                  onClick={() => navigate({ item: null })}
                >
                  <ArrowLeft />
                  Back to list
                </Button>
                <span className="desktop-detail-label">
                  {detail ? notificationTypeLabel(detail.kind, detail.resultType) : "Item"}
                </span>
                {detail && (
                  <div className="detail-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={(event) =>
                        mutate({ read: !detail.readAt }, event.currentTarget)
                      }
                      aria-label={detail.readAt ? "Mark unread" : "Mark read"}
                    >
                      {detail.readAt ? <Mail /> : <MailOpen />}
                      <span>{detail.readAt ? "Mark unread" : "Mark read"}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={(event) =>
                        mutate(
                          { archived: !detail.archivedAt },
                          event.currentTarget,
                        )
                      }
                      aria-label={
                        detail.archivedAt ? "Restore to inbox" : "Archive item"
                      }
                    >
                      {detail.archivedAt ? <ArchiveRestore /> : <Archive />}
                      <span>{detail.archivedAt ? "Restore" : "Archive"}</span>
                    </Button>
                  </div>
                )}
              </header>
              <div className="detail-scroll" key={selectedId}>
                {detailError && detail && (
                  <div className="action-error" role="alert">
                    <p>Refresh failed. The saved item is still available. {detailError}</p>
                    <Button variant="outline" onClick={() => setDetailRefresh(n => n + 1)}>Retry refresh</Button>
                  </div>
                )}
                {detailLoading && !detail ? (
                  <div className="detail-loading" role="status">
                    <LoaderCircle className="spin" size={20} />
                    Loading item…
                  </div>
                ) : detailError && !detail ? (
                  <ErrorState
                    message={detailError}
                    retry={() => setDetailRefresh((n) => n + 1)}
                  />
                ) : (
                  detail && (
                    <article className="article">
                      <div className="article-kicker">
                        <NotificationType kind={detail.kind} resultType={detail.resultType} audioAvailable={detail.audioAvailable} />
                        {detail.edition && (
                          <span>· {detail.edition} edition</span>
                        )}
                        {detail.archivedAt && (
                          <Badge variant="secondary">Archived</Badge>
                        )}
                      </div>
                      {detail.kind === "result" && detail.origin && (
                        <div className="result-origin" aria-label="Result origin">
                          <span className="result-origin-label">From</span>
                          {detail.origin.host && <span className="origin-value" title={detail.origin.host}>{detail.origin.host}</span>}
                          {detail.origin.project && <span className="origin-value" title={detail.origin.project}>{detail.origin.project}</span>}
                          {detail.origin.model && <span className="origin-value" title={detail.origin.model}>{detail.origin.model}</span>}
                          {safeThreadUrl(detail.origin.threadUrl) && (
                            <a href={safeThreadUrl(detail.origin.threadUrl)} target="_blank" rel="noopener noreferrer">Open source thread<span className="sr-only"> (opens in new tab)</span></a>
                          )}
                        </div>
                      )}
                      <h2 ref={detailHeading} tabIndex={-1}>
                        {detail.title}
                      </h2>
                      <div className="article-meta">
                        <time dateTime={detail.publishedAt}>
                          {formatDate(detail.publishedAt, true)}
                        </time>
                        <span
                          className="read-status"
                          role="status"
                          aria-live="polite"
                        >
                          {pending ? (
                            <>
                              <LoaderCircle size={13} className="spin" />
                              Saving…
                            </>
                          ) : detail.readAt ? (
                            <>
                              <Check size={13} />
                              Read
                            </>
                          ) : (
                            <>
                              <span className="unread-dot" />
                              Unread
                            </>
                          )}
                        </span>
                      </div>
                      {actionError && (
                        <div className="action-error" role="alert">
                          <p>{actionError}</p>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setActionError("");
                              setDetailRefresh((n) => n + 1);
                              setRefresh((n) => n + 1);
                            }}
                          >
                            Refresh state
                          </Button>
                        </div>
                      )}
                      {detail.kind === "result" && !detail.audioAvailable && detail.audioStatus && detail.audioStatus !== "ready"
                        ? <AudioJobStatus status={detail.audioStatus} />
                        : <DetailPlayControl item={detail} />}
                      <MarkdownBody body={readingBody(detail)} />
                      {detail.tags.length > 0 && (
                        <div className="tags" aria-label="Tags">
                          {detail.tags.map((tag) => (
                            <Badge variant="secondary" key={tag}>
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <section
                        className="sources"
                        aria-labelledby="sources-heading"
                      >
                        <h3 id="sources-heading">
                          Sources <span>{detail.sources.length}</span>
                        </h3>
                        {detail.sources.length ? (
                          <ul>
                            {detail.sources.map((source, index) => (
                              <li key={`${source.url}-${index}`}>
                                {safeUrl(source.url) ? (
                                  <a
                                    href={safeUrl(source.url)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    <span className="source-number">
                                      {index + 1}
                                    </span>
                                    <span>
                                      <span className="source-title">
                                        {source.title || "Source"}
                                      </span>
                                      <span className="source-url">
                                        {new URL(source.url).hostname}
                                      </span>
                                    </span>
                                    <ArrowUpRight size={16} />
                                    <span className="sr-only">
                                      {" "}
                                      (opens in new tab)
                                    </span>
                                  </a>
                                ) : (
                                  <span className="invalid-source">
                                    {source.title} · Link unavailable
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="no-sources">
                            No source links were included in this item.
                          </p>
                        )}
                      </section>
                    </article>
                  )
                )}
              </div>
            </>
          ) : (
            <div className="detail-empty">
              <span className="detail-empty-icon">
                <Newspaper size={30} strokeWidth={1.3} />
              </span>
              <h2>Select an item to read</h2>
              <p>Briefings, release alerts, agent results, and their sources appear here.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
// Markdown parsing is independent of search typing, playback and read/archive state.
const MarkdownBody = memo(function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => (
            <span className="markdown-image-label">
              {alt ? `Image: ${alt}` : "Image"}
            </span>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
});
