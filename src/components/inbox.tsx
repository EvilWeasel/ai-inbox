"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronRight,
  Inbox as InboxIcon,
  LoaderCircle,
  Mail,
  MailOpen,
  Menu,
  Newspaper,
  RefreshCw,
  Search,
  X,
  Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";

import type { InboxItem, ItemView, ItemList } from "@/lib/contracts";
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
function sourceLabel(item: InboxItem) {
  const source = item.sources[0];
  if (!source)
    return item.kind === "briefing" ? "Daily briefing" : "Release alert";
  try {
    return new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    return source.title;
  }
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
  const router = useRouter();
  const params = useSearchParams();
  const rawView = params.get("view");
  const view: View = views.some((v) => v.value === rawView)
    ? (rawView as View)
    : "inbox";
  const q = params.get("q") || "";
  const rawKind = params.get("kind");
  const kind = rawKind === "briefing" || rawKind === "alert" ? rawKind : "";
  const selectedId = params.get("item");
  const [search, setSearch] = useState(q);
  const [list, setList] = useState<ListResult | null>(null);
  const [detail, setDetail] = useState<InboxItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState("");
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
      const next = new URLSearchParams(params.toString());
      Object.entries(changes).forEach(([key, value]) =>
        value ? next.set(key, value) : next.delete(key),
      );
      router.push(`/?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );
  useEffect(() => {
    setSearch(q);
  }, [q]);
  useEffect(() => {
    setActionError("");
  }, [selectedId]);
  useEffect(() => {
    const controller = new AbortController();
    paginationRequest.current++;
    setLoading(true);
    setListError("");
    setMoreError("");
    setMoreLoading(false);
    request<ListResult>(`/api/items?${listQuery}`, {
      signal: controller.signal,
    })
      .then((data) => {
        setList(data);
        setLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setListError(error.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [listQuery, refresh]);
  useEffect(() => {
    setDetail(null);
    setDetailError("");
    if (!selectedId) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    request<{ item: InboxItem }>(
      `/api/items/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    )
      .then(({ item }) => {
        setDetail(item);
        setDetailLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setDetailError(error.message);
          setDetailLoading(false);
        }
      });
    return () => controller.abort();
  }, [selectedId, detailRefresh]);
  useEffect(() => {
    if (!selectedId && previousSelection.current)
      (
        itemButtons.current.get(previousSelection.current) ??
        listHeading.current
      )?.focus({ preventScroll: true });
    previousSelection.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    if (detail && !detailLoading)
      detailHeading.current?.focus({ preventScroll: true });
  }, [selectedId, detailLoading]);

  async function loadMore() {
    if (!list?.nextCursor || moreLoading) return;
    const token = ++paginationRequest.current;
    setMoreLoading(true);
    setMoreError("");
    try {
      const result = await request<ListResult>(
        `/api/items?${listQuery}&cursor=${encodeURIComponent(list.nextCursor)}`,
      );
      if (token !== paginationRequest.current) return;
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
  async function mutate(patch: { read?: boolean; archived?: boolean }) {
    if (!detail || pending) return;
    const mutationQuery = listQuery;
    const previous = detail;
    const previousList = list;
    const optimistic = {
      ...detail,
      ...(patch.read !== undefined
        ? { readAt: patch.read ? new Date().toISOString() : null }
        : {}),
      ...(patch.archived !== undefined
        ? { archivedAt: patch.archived ? new Date().toISOString() : null }
        : {}),
    };
    setPending(true);
    setActionError("");
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
      setDetail((current) => (current?.id === item.id ? item : current));
    } catch (error) {
      setDetail((current) =>
        current?.id === previous.id ? previous : current,
      );
      if (currentRoute.current.listQuery === mutationQuery)
        setList(previousList);
      if (currentRoute.current.selectedId === previous.id) {
        setActionError(
          `Change could not be saved. ${(error as Error).message}`,
        );
        setDetailRefresh((n) => n + 1);
      }
    } finally {
      setPending(false);
      setRefresh((n) => n + 1);
    }
  }
  const currentView = views.find((v) => v.value === view)!;
  const navigation = (
    <>
      <div className="sidebar-brand">
        <span className="brand-mark">
          <InboxIcon size={19} />
        </span>
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
              <Button
                variant="ghost"
                size="icon"
                className="refresh-button"
                aria-label="Refresh items"
                disabled={loading}
                onClick={() => setRefresh((n) => n + 1)}
              >
                <RefreshCw className={loading ? "spin" : ""} />
              </Button>
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
            <div className="filter-row">
              <label htmlFor="kind-filter">Show</label>
              <select
                id="kind-filter"
                value={kind}
                onChange={(event) =>
                  navigate({ kind: event.target.value, item: null })
                }
              >
                <option value="">All types</option>
                <option value="briefing">Briefings</option>
                <option value="alert">Release alerts</option>
              </select>
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
                      : "New briefings and release alerts will appear here when they arrive."}
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
                          <span className={`kind-icon ${item.kind}`}>
                            {item.kind === "briefing" ? (
                              <Newspaper size={14} />
                            ) : (
                              <Zap size={14} />
                            )}
                          </span>
                          <span className="source-name">
                            {sourceLabel(item)}
                          </span>
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
                          <span>
                            {item.kind === "briefing"
                              ? `${item.edition ? `${item.edition[0].toUpperCase()}${item.edition.slice(1)} ` : ""}briefing`
                              : "Release alert"}
                          </span>
                          {item.archivedAt && <span>Archived</span>}
                          {item.audioAvailable && (
                            <span className="audio-indicator">
                              <AudioLines size={13} />
                              <span className="sr-only">Audio available</span>
                            </span>
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
          aria-busy={detailLoading}
        >
          {selectedId ? (
            <>
              <header className="detail-toolbar">
                <Button
                  variant="ghost"
                  size="sm"
                  className="back-button"
                  onClick={() => navigate({ item: null })}
                >
                  <ArrowLeft />
                  Back to list
                </Button>
                <span className="desktop-detail-label">
                  {detail?.kind === "briefing"
                    ? "Briefing"
                    : detail?.kind === "alert"
                      ? "Release alert"
                      : "Item"}
                </span>
                {detail && (
                  <div className="detail-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => mutate({ read: !detail.readAt })}
                      aria-label={detail.readAt ? "Mark unread" : "Mark read"}
                    >
                      {detail.readAt ? <Mail /> : <MailOpen />}
                      <span>{detail.readAt ? "Mark unread" : "Mark read"}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => mutate({ archived: !detail.archivedAt })}
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
                {detailLoading ? (
                  <div className="detail-loading" role="status">
                    <LoaderCircle className="spin" size={20} />
                    Loading item…
                  </div>
                ) : detailError ? (
                  <ErrorState
                    message={detailError}
                    retry={() => setDetailRefresh((n) => n + 1)}
                  />
                ) : (
                  detail && (
                    <article className="article">
                      <div className="article-kicker">
                        <span>
                          {detail.kind === "briefing"
                            ? "Daily briefing"
                            : "Release alert"}
                        </span>
                        {detail.edition && (
                          <span>· {detail.edition} edition</span>
                        )}
                        {detail.archivedAt && (
                          <Badge variant="secondary">Archived</Badge>
                        )}
                      </div>
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
                      <AudioPlayer key={detail.id} item={detail} />
                      {detail.summary && (
                        <p className="article-summary">{detail.summary}</p>
                      )}
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
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {detail.body}
                        </ReactMarkdown>
                      </div>
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
              <p>Briefings, release notes, and their sources appear here.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
function AudioPlayer({ item }: { item: InboxItem }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [rate, setRate] = useState("1");
  const [error, setError] = useState(false);
  if (!item.audioAvailable)
    return (
      <div className="audio-unavailable">
        <AudioLines size={16} />
        <span>Audio is not available for this item.</span>
      </div>
    );
  return (
    <section className="audio-player" aria-label="Audio briefing">
      <div className="audio-heading">
        <span>
          <AudioLines size={17} />
          Listen
          {item.audioDuration != null && item.audioDuration > 0 && (
            <span className="audio-duration">
              {Math.floor(item.audioDuration / 60)}:
              {String(Math.floor(item.audioDuration % 60)).padStart(2, "0")}
            </span>
          )}
        </span>
        <label>
          Speed
          <select
            aria-label="Playback speed"
            value={rate}
            onChange={(event) => {
              setRate(event.target.value);
              if (audio.current)
                audio.current.playbackRate = Number(event.target.value);
            }}
          >
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
              <option value={speed} key={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <div className="audio-error" role="alert">
          <p>Audio could not be loaded.</p>
          <Button size="sm" variant="outline" onClick={() => setError(false)}>
            Retry audio
          </Button>
        </div>
      ) : (
        <audio
          ref={audio}
          controls
          preload="none"
          src={`/api/items/${encodeURIComponent(item.id)}/audio`}
          aria-label={`Listen to ${item.title}`}
          onError={() => setError(true)}
          onLoadedMetadata={() => {
            if (audio.current) audio.current.playbackRate = Number(rate);
          }}
        >
          Your browser does not support audio playback.
        </audio>
      )}
    </section>
  );
}
