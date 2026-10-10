import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type InboxInvalidation, useInboxEvents } from './use-inbox-events';
class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = [];
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { super(); MockEventSource.instances.push(this); }
  send(type: string, revision: string) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ revision }) })); }
}
beforeEach(() => { MockEventSource.instances = []; vi.stubGlobal('EventSource', MockEventSource); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses one same-origin source, latest callback, baseline/change dedup and reconnect status', async () => {
  const first = vi.fn(), latest = vi.fn();
  const view = renderHook(({ callback }) => useInboxEvents(callback), { initialProps: { callback: first } });
  const source = MockEventSource.instances[0];
  expect(source.url).toBe('/api/events'); expect(view.result.current).toBe('reconnecting');
  await act(async () => source.send('baseline', '1'));
  expect(first).toHaveBeenCalledTimes(1); expect(view.result.current).toBe('connected');
  view.rerender({ callback: latest });
  await act(async () => { source.send('change', '2'); });
  await act(async () => { source.send('change', '2'); });
  expect(latest).toHaveBeenCalledTimes(1); expect(MockEventSource.instances).toHaveLength(1);
  act(() => source.onerror?.()); expect(view.result.current).toBe('reconnecting');
  await act(async () => source.send('baseline', '2'));
  expect(latest).toHaveBeenCalledTimes(2); expect(view.result.current).toBe('connected');
  const signal = latest.mock.calls[0][0].signal as AbortSignal;
  view.unmount(); expect(signal.aborted).toBe(true); expect(source.close).toHaveBeenCalledTimes(1);
  act(() => source.send('change', '3')); expect(latest).toHaveBeenCalledTimes(2);
});
it('serializes asynchronous refreshes and retains only the latest trailing revision', async () => {
  let finish!: () => void;
  const callback = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  renderHook(() => useInboxEvents(callback));
  const source = MockEventSource.instances[0];
  act(() => { source.send('baseline', '1'); source.send('change', '2'); source.send('change', '3'); });
  expect(callback).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
  expect(callback.mock.calls[1][0].revision).toBe('3');
});
it('ignores malformed frames, tolerates missing EventSource, aborts pending work on cleanup', async () => {
  const callback = vi.fn((_event: InboxInvalidation) => new Promise<void>(() => {}));
  const view = renderHook(() => useInboxEvents(callback));
  const source = MockEventSource.instances[0];
  act(() => { source.send('change', 'bad'); source.dispatchEvent(new MessageEvent('baseline', { data: '{' })); });
  expect(callback).not.toHaveBeenCalled();
  act(() => { source.send('baseline', '1'); source.send('change', '2'); });
  view.unmount(); expect(callback.mock.calls[0][0].signal.aborted).toBe(true);
  vi.stubGlobal('EventSource', undefined);
  const missing = renderHook(() => useInboxEvents(vi.fn())); expect(missing.result.current).toBe('unavailable');
});
