import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { planClips } from '../engine/core.js';
const { adapter } = createRequire(import.meta.url)('../plugin/premiere.js');
// SDK-shaped fake tests the adapter's edit policy. It is not a Premiere integration test.
function fixture({ failInsert = false } = {}) {
  const items = [],
    sequences = [],
    transactions = [];
  let created;
  const time = (seconds) => ({ seconds });
  const item = {
    name: 'game.mp4',
    type: 1,
    path: 'C:/game.mp4',
    isSequence: async () => false,
    isOffline: async () => false,
    getMediaFilePath: async () => item.path,
    createSubClipAction: (name, start, end) => () =>
      items.push({ ...item, name, length: end.seconds - start.seconds }),
  };
  items.push(item);
  const root = { getItems: async () => items };
  const track = () => ({
    items: [],
    getTrackItems() {
      return this.items;
    },
    createSetNameAction(name) {
      return () => {
        this.name = name;
      };
    },
  });
  function insert(seq, media, start, index) {
    while (seq.video.length <= index) seq.video.push(track());
    const clip = {
      getStartTime: async () => time(start.seconds),
      getEndTime: async () => time(start.seconds + (media.length ?? 200)),
    };
    seq.video[index].items.push(clip);
    seq.audio[0].items.push({ ...clip });
  }
  const project = {
    getRootItem: async () => root,
    lockedAccess: (fn) => fn(),
    executeTransaction(fn, label) {
      const actions = [];
      fn({ addAction: (a) => actions.push(a) });
      actions.forEach((a) => a());
      transactions.push(label);
      return true;
    },
    async createSequenceFromMedia(name, media) {
      const s = {
        name,
        video: [track()],
        audio: [track()],
        getVideoTrackCount: async () => s.video.length,
        getAudioTrackCount: async () => s.audio.length,
        getVideoTrack: async (i) => s.video[i],
        getAudioTrack: async (i) => s.audio[i],
        getProjectItem: async () => ({
          createSetNameAction: (name) => () => {
            s.name = name;
          },
        }),
      };
      insert(s, media[0], time(0), 0);
      sequences.push(s);
      created = s;
      return s;
    },
    openSequence: async () => true,
    setActiveSequence: async () => true,
  };
  const ppro = {
    Project: { getActiveProject: async () => project },
    FolderItem: { cast: (x) => (x === root ? root : null) },
    ClipProjectItem: { cast: (x) => x },
    FrameRate: { createWithValue: (x) => x },
    TickTime: { createWithFrameAndFrameRate: (f, r) => time(f / r) },
    Constants: { TrackItemType: { CLIP: 1 }, MediaType: { VIDEO: 1 } },
    TrackItemSelection: {
      createEmptySelection: (fn) =>
        fn({
          items: [],
          addItem(item) {
            this.items.push(item);
          },
        }),
    },
    SequenceEditor: {
      getEditor: (seq) => ({
        createRemoveItemsAction: (selection) => () => {
          for (const t of [...seq.video, ...seq.audio])
            t.items = t.items.filter((i) => !selection.items.includes(i));
        },
        createInsertProjectItemAction: (media, start, index) => () => {
          if (failInsert) throw Error('insert failed');
          insert(seq, media, start, index);
        },
      }),
    },
  };
  return {
    host: adapter(ppro),
    items,
    sequences,
    transactions,
    get created() {
      return created;
    },
  };
}
function plan() {
  const source = {
    path: 'C:/game.mp4',
    name: 'game.mp4',
    in: 0,
    out: 200,
    duration: 200,
    fpsNum: 60,
    fpsDen: 1,
    audio: [{ channels: 2 }],
  };
  return {
    ...planClips(
      [
        { id: '1', type: 'kill', time: 30 },
        { id: '2', type: 'death', time: 80 },
        { id: '3', type: 'assist', time: 140 },
      ],
      source,
    ),
    source,
  };
}
test('host creates a NEW validated timeline with correct tracks and synced audio', async () => {
  const f = fixture(),
    result = await f.host.generate(plan());
  assert.equal(result.clips, 3);
  assert.equal(result.audioTracks, 1);
  assert.equal(f.sequences.length, 1);
  assert.equal(f.created.video[0].items.length, 1);
  assert.equal(f.created.video[1].items.length, 1);
  assert.equal(f.created.video[2].items.length, 1);
  assert.equal(f.items[0].name, 'game.mp4');
  assert.ok(!f.created.name.includes('INCOMPLETE'));
});
test('host failures leave a clearly incomplete result, never a success', async () => {
  const f = fixture({ failInsert: true });
  await assert.rejects(() => f.host.generate(plan()), /INCOMPLETE/);
  assert.ok(f.created.name.includes('INCOMPLETE'));
});
test('cancel before sequence creation leaves source untouched', async () => {
  const f = fixture();
  await assert.rejects(() => f.host.generate(plan(), { isCancelled: () => true }), /취소/);
  assert.equal(f.sequences.length, 0);
  assert.equal(f.items[0].path, 'C:/game.mp4');
});
test('rejects invalid output positions before touching host', () => {
  const f = fixture(),
    p = plan();
  p.clips[1].outputInFrame = 0;
  assert.throws(() => f.host.validatePlan(p), /시간축/);
  assert.equal(f.transactions.length, 0);
});
