import { sampleFrames } from './media.js';
import { detectOpeningWindow } from './core.js';

// Share clock frames only when the original 2-second clock grid lies exactly
// on the analysis grid. Keep look-behind/look-ahead for short selected clips.
export function createClockSampler(
  source,
  clockRoi,
  interval,
  readClock,
  signal,
  threads,
  onClockProgress = () => {},
  sample = sampleFrames,
) {
  const clockStart = Math.max(0, source.in - 30);
  const clockEnd = Math.min(source.duration ?? source.out, source.in + 900);
  const onGrid = (value) => Math.abs(value - Math.round(value)) < 1e-7;
  const shared = onGrid(2 / interval) && onGrid((source.in - clockStart) / interval);
  const clockSamples = [];
  let openingWindow = null;
  const nextTime = () => clockStart + clockSamples.length * 2;
  const accept = async (frame) => {
    signal?.throwIfAborted();
    const value = await readClock(frame.raw, frame);
    clockSamples.push({ time: nextTime(), ...value });
    onClockProgress(clockSamples.length);
    if (value.clockSeconds !== null) {
      try {
        openingWindow = detectOpeningWindow(clockSamples, source);
      } catch (error) {
        if (error.message.includes('선택한 원본 구간')) throw error;
      }
    }
  };
  const scan = async (end) => {
    if (openingWindow || nextTime() >= end) return;
    for await (const frame of sample(
      { ...source, in: nextTime(), out: end },
      clockRoi,
      2,
      signal,
      threads,
    )) {
      await accept(frame);
      if (openingWindow) break;
    }
  };
  return {
    clockSamples,
    get openingWindow() {
      return openingWindow;
    },
    async *frames(regions) {
      if (!shared) {
        await scan(clockEnd);
        openingWindow ??= detectOpeningWindow(clockSamples, source);
        yield* sample(source, regions, interval, signal, threads);
        return;
      }
      await scan(Math.min(source.in, clockEnd));
      const includeClock = !openingWindow;
      for await (const frame of sample(
        source,
        includeClock ? [...regions, clockRoi] : regions,
        interval,
        signal,
        threads,
      )) {
        signal?.throwIfAborted();
        if (!openingWindow && frame.time + 1e-7 >= nextTime() && nextTime() < clockEnd) {
          await accept(frame.regions.at(-1));
          if (!openingWindow && nextTime() >= clockEnd)
            openingWindow = detectOpeningWindow(clockSamples, source);
        }
        yield includeClock ? { ...frame, regions: frame.regions.slice(0, -1) } : frame;
      }
      // A short selection may end before twenty seconds of valid clock data.
      await scan(clockEnd);
      openingWindow ??= detectOpeningWindow(clockSamples, source);
    },
  };
}
