"use client";

import { createContext, memo, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DropdownMenu, Popover, Slider } from "radix-ui";
import { Check, ChevronDown, Pause, Play, RotateCcw, Volume1, Volume2, VolumeX } from "lucide-react";
import type { InboxItem } from "@/lib/contracts";
import "./audio-player.css";
import { AudioGenerationControl } from "./audio-generation-control";

type Track = Pick<InboxItem, "id" | "title">;
type Status = { track: Track | null; playing: boolean; pending: boolean; ended: boolean; error: string };
type Progress = { time: number; duration: number; speed: number };
type Volume = { level: number; muted: boolean; lastAudible: number };
const initialStatus: Status = { track: null, playing: false, pending: false, ended: false, error: "" };
const initialProgress: Progress = { time: 0, duration: 0, speed: 1 };
const initialVolume: Volume = { level: 0.8, muted: false, lastAudible: 0.8 };
const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];
const finite = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
const clampVolume = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const volumeStorageKey = "ai-inbox-audio-volume";
const mutedStorageKey = "ai-inbox-audio-muted";
const lastAudibleStorageKey = "ai-inbox-audio-last-volume";

// Status, time and volume are separate stores so timeupdate events do not
// rerender article/list content or the independent volume controls.
function createPlayer() {
  let audio: HTMLAudioElement | null = null;
  let status = initialStatus;
  let progress = initialProgress;
  let volume = initialVolume;
  let request = 0;
  let source = "";
  const statusListeners = new Set<() => void>();
  const progressListeners = new Set<() => void>();
  const volumeListeners = new Set<() => void>();
  const setStatus = (patch: Partial<Status>) => {
    status = { ...status, ...patch };
    statusListeners.forEach(fn => fn());
  };
  const setProgress = (patch: Partial<Progress>) => {
    progress = { ...progress, ...patch };
    progressListeners.forEach(fn => fn());
  };
  const setVolumeState = (next: Volume) => {
    volume = next;
    if (audio) {
      audio.volume = next.level;
      audio.muted = next.muted;
    }
    try {
      localStorage.setItem(volumeStorageKey, String(next.level));
      localStorage.setItem(mutedStorageKey, String(next.muted));
      localStorage.setItem(lastAudibleStorageKey, String(next.lastAudible));
    } catch { /* In-memory preference still works when storage is unavailable. */ }
    volumeListeners.forEach(fn => fn());
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
    audio.volume = volume.level;
    audio.muted = volume.muted;
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
  const setVolume = (value: number) => {
    const level = clampVolume(value);
    setVolumeState({ level, muted: false, lastAudible: level > 0 ? level : volume.lastAudible });
  };
  const toggleMute = () => {
    if (volume.muted || volume.level === 0) {
      const level = volume.level > 0 ? volume.level : volume.lastAudible > 0 ? volume.lastAudible : initialVolume.level;
      setVolumeState({ level, muted: false, lastAudible: level });
    } else {
      setVolumeState({ ...volume, muted: true });
    }
  };
  const restoreVolume = () => {
    const readLevel = (key: string, fallback: number) => {
      try {
        const stored = localStorage.getItem(key);
        if (stored === null || !/^(?:\d+\.?\d*|\.\d+)$/.test(stored.trim())) return fallback;
        const value = Number(stored);
        return Number.isFinite(value) ? clampVolume(value) : fallback;
      } catch { return fallback; }
    };
    let muted = false;
    try {
      const saved = localStorage.getItem(mutedStorageKey);
      if (saved === "true" || saved === "false") muted = saved === "true";
    } catch { /* Default to unmuted. */ }
    const level = readLevel(volumeStorageKey, initialVolume.level);
    const lastAudible = readLevel(lastAudibleStorageKey, level > 0 ? level : initialVolume.level) || initialVolume.level;
    volume = { level, muted, lastAudible };
    if (audio) {
      audio.volume = level;
      audio.muted = muted;
    }
    volumeListeners.forEach(fn => fn());
  };
  return {
    subscribeStatus: (fn: () => void) => { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; },
    subscribeProgress: (fn: () => void) => { progressListeners.add(fn); return () => { progressListeners.delete(fn); }; },
    subscribeVolume: (fn: () => void) => { volumeListeners.add(fn); return () => { volumeListeners.delete(fn); }; },
    getStatus: () => status, getProgress: () => progress, getVolume: () => volume,
    play, pause, seek, speed, setVolume, toggleMute,
    toggle: () => { if (status.playing || status.pending) pause(); else if (status.track) void play(status.track); },
    attach: (node: HTMLAudioElement) => {
      audio = node;
      try { const saved = Number(localStorage.getItem("ai-inbox-playback-speed")); if (speeds.includes(saved)) speed(saved); } catch { /* Default speed. */ }
      restoreVolume();
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
export const DetailPlayControl = memo(function DetailPlayControl({ item, onAudioRequested }: { item: InboxItem; onAudioRequested?: (item: InboxItem) => void }) {
  const player = usePlayer();
  const status = useStatus(player);
  if (!item.audioAvailable) return <AudioGenerationControl key={item.id} item={item} onRequested={onAudioRequested} />;
  const current = status.track?.id === item.id;
  const label = current ? status.pending ? "Cancel playback" : status.playing ? "Pause" : status.error ? "Retry" : status.ended ? "Replay" : "Resume" : "Play";
  const duration = finite(item.audioDuration ?? 0);
  const detailStatus = current ? status.error ? "Audio unavailable" : status.playing ? "Playing" : status.ended ? "Finished" : "Paused" : "";
  return <section className="audio-player enhanced-audio-detail" aria-label="Audio briefing">
    <button className="detail-play-control" onClick={() => {
      if (current && (status.playing || status.pending)) player.pause(); else void player.play(item);
    }} aria-label={`${label} ${item.title}`}>
      {current && status.playing ? <Pause size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />} {label} audio
    </button>
    <span className="audio-duration">{duration > 0 ? `${time(duration)} audio` : "Audio recording"}</span>
    <span className="audio-detail-status" role="status">{detailStatus}</span>
  </section>;
});
function time(value: number) {
  const seconds = Math.floor(finite(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function VolumeControl({ player, volume }: { player: Player; volume: Volume }) {
  const icon = volume.muted || volume.level === 0 ? <VolumeX size={18} aria-hidden="true" /> : volume.level < 0.5 ? <Volume1 size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />;
  const slider = <Slider.Root className="player-volume-slider" min={0} max={1} step={0.01} value={[volume.muted ? 0 : volume.level]} onValueChange={values => player.setVolume(values[0] ?? 0)}>
    <Slider.Track className="player-slider-track"><Slider.Range className="player-slider-range" /><Slider.Thumb className="player-slider-thumb" aria-label="Volume" /></Slider.Track>
  </Slider.Root>;
  const button = <button className="player-icon-button player-volume-toggle player-desktop-mute" aria-label={volume.muted || volume.level === 0 ? "Unmute audio" : "Mute audio"} aria-pressed={volume.muted || volume.level === 0} onClick={player.toggleMute}>{icon}</button>;
  return <div className="player-volume-control">{button}<Popover.Root>
    <Popover.Trigger asChild><button className="player-icon-button player-volume-menu-trigger" aria-label="Adjust volume">{icon}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="player-volume-popover" side="top" align="end" sideOffset={10} aria-label="Volume controls">
      <button className="player-popover-mute" aria-label={volume.muted || volume.level === 0 ? "Unmute recording" : "Mute recording"} onClick={player.toggleMute}>{icon}</button>{slider}<span className="player-volume-percent">{Math.round(volume.level * 100)}%</span>
    </Popover.Content></Popover.Portal>
  </Popover.Root>{slider}</div>;
}
const PlayerDock = memo(function PlayerDock() {
  const player = usePlayer();
  const status = useStatus(player);
  const progress = useSyncExternalStore(player.subscribeProgress, player.getProgress, () => initialProgress);
  const volume = useSyncExternalStore(player.subscribeVolume, player.getVolume, () => initialVolume);
  const label = status.pending ? "Cancel playback" : status.playing ? "Pause audio" : status.error ? "Retry audio" : status.ended ? "Replay audio" : "Play audio";
  return <section className="player-dock enhanced-player-dock" aria-label="Persistent audio player">
    <div className="player-recording">
      {status.track ? <button className="player-title" title={status.track.title} aria-label={`Open playing item: ${status.track.title}`} onClick={() => {
        const url = new URL(window.location.href);
        url.searchParams.set("item", status.track!.id);
        if (url.href !== window.location.href) window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }}>{status.track.title}</button> : <span className="player-empty">Choose Play on an item to listen</span>}
      <span className="player-state" role="status">{status.pending ? "Starting…" : status.playing ? "Playing" : status.ended ? "Finished" : status.track ? "Paused" : "No recording selected"}</span>
    </div>
    <div className="player-controls">
      <button className="player-main-toggle" aria-label={label} disabled={!status.track} onClick={player.toggle}>{status.playing ? <Pause size={20} aria-hidden="true" /> : status.ended ? <RotateCcw size={19} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}</button>
      <div className="player-progress">
        <Slider.Root className="player-seek-slider" min={0} max={progress.duration || 1} step={1} value={[Math.min(progress.time, progress.duration)]} disabled={!progress.duration} onValueChange={values => player.seek(values[0] ?? 0)}>
          <Slider.Track className="player-slider-track"><Slider.Range className="player-slider-range" /><Slider.Thumb className="player-slider-thumb" aria-label="Audio position" aria-valuetext={`${time(progress.time)} of ${progress.duration ? time(progress.duration) : "unknown duration"}`} /></Slider.Track>
        </Slider.Root>
        <span className="player-time"><span>{time(progress.time)}</span><span aria-hidden="true"> / </span><span>{progress.duration ? time(progress.duration) : "–:––"}</span></span>
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><button className="player-speed-trigger" aria-label={`Playback speed, ${progress.speed} times`}><span>{progress.speed}×</span><ChevronDown size={14} aria-hidden="true" /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="player-speed-menu" align="end" side="top" sideOffset={9} aria-label="Playback speed">
          <DropdownMenu.Label className="player-menu-label">Playback speed</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={String(progress.speed)} onValueChange={value => player.speed(Number(value))}>
            {speeds.map(value => <DropdownMenu.RadioItem className="player-speed-option" key={value} value={String(value)}>
              <span>{value}×</span><DropdownMenu.ItemIndicator><Check size={15} aria-hidden="true" /></DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>)}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      <VolumeControl player={player} volume={volume} />
    </div>
    {status.error && <p className="player-error" role="alert">{status.error}</p>}
  </section>;
});
