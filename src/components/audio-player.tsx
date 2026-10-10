"use client";

import { createContext, memo, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import type { InboxItem } from "@/lib/contracts";

type Track = Pick<InboxItem, "id" | "title">;
type Status = { track: Track | null; playing: boolean; pending: boolean; ended: boolean; error: string };
type Progress = { time: number; duration: number; speed: number };
const initialStatus: Status = { track: null, playing: false, pending: false, ended: false, error: "" };
const initialProgress: Progress = { time: 0, duration: 0, speed: 1 };
const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];
const finite = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

// Two stores keep frequent progress events out of the detail/list render tree.
function createPlayer() {
  let audio: HTMLAudioElement | null = null;
  let status = initialStatus;
  let progress = initialProgress;
  let request = 0;
  let source = "";
  const statusListeners = new Set<() => void>();
  const progressListeners = new Set<() => void>();
  const setStatus = (patch: Partial<Status>) => {
    status = { ...status, ...patch };
    statusListeners.forEach(fn => fn());
  };
  const setProgress = (patch: Partial<Progress>) => {
    progress = { ...progress, ...patch };
    progressListeners.forEach(fn => fn());
  };
  const validMedia = () => !!audio && !!source && audio.currentSrc === new URL(source, window.location.href).href;
  const updateProgress = () => {
    if (validMedia() && audio!.readyState > 0)
      setProgress({ time: finite(audio!.currentTime), duration: finite(audio!.duration) });
  };
  const pause = () => {
    request++;
    audio?.pause();
    setStatus({ playing: false, pending: false });
  };
  const play = async (track: Track) => {
    if (!audio) return;
    const token = ++request;
    if (status.track?.id !== track.id) {
      audio.pause();
      source = `/api/items/${encodeURIComponent(track.id)}/audio`;
      audio.src = source;
      audio.load();
      setProgress({ time: 0, duration: 0 });
      setStatus({ track: { id: track.id, title: track.title }, playing: false, ended: false });
    } else if (status.ended || audio.ended) {
      audio.currentTime = 0;
      setProgress({ time: 0 });
    } else if (audio.error) {
      // Retry the current source only on an explicit gesture.
      audio.load();
    }
    audio.playbackRate = progress.speed;
    setStatus({ pending: true, playing: false, ended: false, error: "" });
    try {
      await audio.play();
      if (token === request) setStatus({ playing: !audio.paused, pending: false });
    } catch {
      if (token === request) setStatus({ playing: false, pending: false, error: "Audio could not play. Check your connection, then retry." });
    }
  };
  const seek = (time: number) => {
    if (!audio || !Number.isFinite(time) || !progress.duration) return;
    audio.currentTime = Math.max(0, Math.min(progress.duration, time));
    setProgress({ time: audio.currentTime });
    if (audio.currentTime < progress.duration) setStatus({ ended: false });
  };
  const speed = (value: number) => {
    if (!speeds.includes(value)) return;
    if (audio) audio.playbackRate = value;
    setProgress({ speed: value });
    try { localStorage.setItem("ai-inbox-playback-speed", String(value)); } catch { /* Session preference still works. */ }
  };
  return {
    subscribeStatus: (fn: () => void) => { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; },
    subscribeProgress: (fn: () => void) => { progressListeners.add(fn); return () => { progressListeners.delete(fn); }; },
    getStatus: () => status, getProgress: () => progress,
    play, pause, seek, speed,
    toggle: () => { if (status.playing || status.pending) pause(); else if (status.track) void play(status.track); },
    attach: (node: HTMLAudioElement) => {
      audio = node;
      try { const saved = Number(localStorage.getItem("ai-inbox-playback-speed")); if (speeds.includes(saved)) speed(saved); } catch { /* Default speed. */ }
      const ended = () => {
        if (!validMedia() || !node.ended) return;
        request++;
        updateProgress();
        setStatus({ playing: false, pending: false, ended: true });
      };
      const error = () => {
        if (!validMedia() || !node.error) return;
        request++;
        setStatus({ playing: false, pending: false, error: "Audio could not load. Check your connection, then retry." });
      };
      const paused = () => {
        // Queued pause events from a source switch cannot cancel its pending play.
        if (validMedia() && node.paused && !status.pending) setStatus({ playing: false });
      };
      const events = { timeupdate: updateProgress, durationchange: updateProgress, loadedmetadata: updateProgress, ended, error, pause: paused };
      Object.entries(events).forEach(([name, handler]) => node.addEventListener(name, handler));
      return () => {
        request++;
        Object.entries(events).forEach(([name, handler]) => node.removeEventListener(name, handler));
        if (source) node.pause();
        audio = null;
      };
    },
  };
}
type Player = ReturnType<typeof createPlayer>;
const PlayerContext = createContext<Player | null>(null);
function usePlayer() {
  const player = useContext(PlayerContext);
  if (!player) throw new Error("AudioPlayerProvider is required");
  return player;
}
function useStatus(player: Player) {
  return useSyncExternalStore(player.subscribeStatus, player.getStatus, () => initialStatus);
}
export function AudioPlayerProvider({ children }: { children: React.ReactNode }) {
  const [player] = useState(createPlayer);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => player.attach(audio.current!), [player]);
  return <PlayerContext.Provider value={player}>
    <div className="player-layout">
      <div className="player-content">{children}</div>
      <PlayerDock />
    </div>
    <audio ref={audio} preload="none" aria-label="Inbox audio" hidden />
  </PlayerContext.Provider>;
}
export const DetailPlayControl = memo(function DetailPlayControl({ item }: { item: InboxItem }) {
  const player = usePlayer();
  const status = useStatus(player);
  if (!item.audioAvailable) return <p className="audio-unavailable">Audio is not available for this item.</p>;
  const current = status.track?.id === item.id;
  const label = current ? status.pending ? "Cancel playback" : status.playing ? "Pause" : status.error ? "Retry" : status.ended ? "Replay" : "Resume" : "Play";
  return <section className="audio-player" aria-label="Audio briefing">
    <button className="detail-play-control" onClick={() => {
      if (current && (status.playing || status.pending)) player.pause(); else void player.play(item);
    }} aria-label={`${label} ${item.title}`}>
      {current && status.playing ? <Pause size={18} /> : <Play size={18} />} {label} audio
    </button>
    <span className="audio-duration">Playback controls stay in the bottom player.</span>
  </section>;
});
function time(value: number) {
  const seconds = Math.floor(finite(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
const PlayerDock = memo(function PlayerDock() {
  const player = usePlayer();
  const status = useStatus(player);
  const progress = useSyncExternalStore(player.subscribeProgress, player.getProgress, () => initialProgress);
  const label = status.pending ? "Cancel playback" : status.playing ? "Pause audio" : status.error ? "Retry audio" : status.ended ? "Replay audio" : "Play audio";
  return <section className="player-dock" aria-label="Persistent audio player">
    <div className="player-recording">
      {status.track ? <button className="player-title" title={status.track.title} aria-label={`Open playing item: ${status.track.title}`} onClick={() => {
        const url = new URL(window.location.href);
        url.searchParams.set("item", status.track!.id);
        if (url.href !== window.location.href) window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }}>{status.track.title}</button> : <span className="player-empty">Choose Play on an item to listen</span>}
      <span className="player-state" role="status">{status.pending ? "Starting…" : status.playing ? "Playing" : status.ended ? "Finished" : status.track ? "Paused" : "No recording selected"}</span>
    </div>
    <div className="player-controls">
      <button aria-label={label} disabled={!status.track} onClick={player.toggle}>{status.playing ? <Pause size={20} /> : status.ended ? <RotateCcw size={20} /> : <Play size={20} />}</button>
      <div className="player-progress">
        <input type="range" aria-label="Audio position" min={0} max={progress.duration || 0} step={1} value={Math.min(progress.time, progress.duration)} disabled={!progress.duration} aria-valuetext={`${time(progress.time)} of ${progress.duration ? time(progress.duration) : "unknown duration"}`} onChange={event => player.seek(Number(event.target.value))} />
        <span className="player-time">{time(progress.time)} / {progress.duration ? time(progress.duration) : "–:––"}</span>
      </div>
      <label className="player-speed"><span className="sr-only">Playback speed</span><select aria-label="Playback speed" value={progress.speed} onChange={event => player.speed(Number(event.target.value))}>{speeds.map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
    </div>
    {status.error && <p className="player-error" role="alert">{status.error}</p>}
  </section>;
});
