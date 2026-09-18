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
  let created,
    inLock = false,
    activeSequence = { guid: 'source-sequence' };
  const time = (seconds) => ({ seconds });
  const action = (fn) => {
    if (!inLock) throw Error('Requires locked access');
    return fn;
  };
  const item = {
    name: 'game.mp4',
    type: 1,
    path: 'C:/game.mp4',
    isSequence: async () => false,
    isOffline: async () => false,
    getMediaFilePath: async () => item.path,
    getParentBin: () => root,
    createSubClipAction: (name, start, end) =>
      action(() => items.push({ ...item, name, length: end.seconds - start.seconds })),
  };
  items.push(item);
  const root = {
    getItems: async () => items,
    createRemoveItemAction: (target) =>
      action(() => {
        const index = items.indexOf(target);
        if (index >= 0) items.splice(index, 1);
      }),
  };
  const track = () => ({
    items: [],
    getTrackItems() {
      return this.items;
    },
    createSetNameAction(name) {
      return action(() => {
        this.name = name;
      });
    },
  });
  function insert(seq, media, start, index) {
    while (seq.video.length <= index) seq.video.push(track());
    const clip = {
      mediaType: 'video',
      getStartTime: async () => time(start.seconds),
      getEndTime: async () => time(start.seconds + (media.length ?? 200)),
    };
    seq.video[index].items.push(clip);
    seq.audio[0].items.push({ ...clip, mediaType: 'audio' });
  }
  const project = {
    guid: 'project-guid',
    getRootItem: async () => root,
    getActiveSequence: async () => activeSequence,
    lockedAccess(fn) {
      inLock = true;
      try {
        return fn();
      } finally {
        inLock = false;
      }
    },
    executeTransaction(fn, label) {
      const actions = [];
      fn({ addAction: (a) => actions.push(a) });
      actions.forEach((a) => a());
      transactions.push(label);
      return true;
    },
    async createSequenceFromMedia(name, media) {
      let selection = {
        items: [],
        addItem(item, skipDuplicateCheck) {
          if (activeSequence !== s || skipDuplicateCheck !== true)
            throw Error('Illegal Parameter type');
          this.items.push(item);
          return true;
        },
      };
      const s = {
        guid: `sequence-${sequences.length + 1}`,
        name,
        video: [track()],
        audio: [track()],
        getVideoTrackCount: async () => s.video.length,
        getAudioTrackCount: async () => s.audio.length,
        getVideoTrack: async (i) => s.video[i],
        getAudioTrack: async (i) => s.audio[i],
        clearSelection: async () => {
          if (activeSequence !== s) throw Error('sequence must be active');
          selection = {
            items: [],
            addItem(item, skipDuplicateCheck) {
              if (activeSequence !== s || skipDuplicateCheck !== true)
                throw Error('Illegal Parameter type');
              this.items.push(item);
              return true;
            },
          };
          return true;
        },
        getSelection: async () => selection,
        getProjectItem: async () => ({
          createSetNameAction: (name) =>
            action(() => {
              s.name = name;
            }),
        }),
      };
      insert(s, media[0], time(0), 0);
      sequences.push(s);
      created = s;
      return s;
    },
    getSequence: (guid) => ({ guid }),
    getSequences: async () => sequences,
    closeSequence: async () => true,
    async deleteSequence(sequence) {
      const index = sequences.indexOf(sequence);
      if (index < 0) return false;
      sequences.splice(index, 1);
      return true;
    },
    openSequence: async () => true,
    setActiveSequence: async (sequence) => {
      activeSequence = sequence;
      return true;
    },
  };
  const ppro = {
    Project: {
      getActiveProject: async () => project,
      getProject: (guid) => (guid === project.guid ? project : null),
    },
    FolderItem: { cast: (x) => (x === root ? root : null) },
    ClipProjectItem: {
      cast: (x) => {
        const cast = Object.create(x);
        cast.isClipProjectItemCast = true;
        return cast;
      },
    },
    FrameRate: { createWithValue: (x) => x },
    TickTime: { createWithFrameAndFrameRate: (f, r) => time(f / r) },
    Constants: { TrackItemType: { CLIP: 1 }, MediaType: { ANY: 0, VIDEO: 1, AUDIO: 2 } },
    TrackItemSelection: {
      createEmptySelection: () => {
        throw Error('detached TrackItemSelection is rejected by Premiere 26.5');
      },
    },
    SequenceEditor: {
      getEditor: (seq) => ({
        createRemoveItemsAction(selection, _ripple, mediaType) {
          if (arguments.length !== 3 || mediaType === ppro.Constants.MediaType.ANY)
            throw Error('Invalid parameter');
          return action(() => {
            for (const t of [...seq.video, ...seq.audio])
              t.items = t.items.filter(
                (item) =>
                  !selection.items.includes(item) ||
                  (mediaType !== ppro.Constants.MediaType.ANY &&
                    (mediaType === ppro.Constants.MediaType.VIDEO) !==
                      (item.mediaType === 'video')),
              );
          });
        },
        createInsertProjectItemAction: (media, start, index) =>
          action(() => {
            if (media.isClipProjectItemCast) throw Error('Invalid parameter');
            if (failInsert) throw Error('insert failed');
            insert(seq, media, start, index);
          }),
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
test('host failures remove the incomplete sequence and generated subclips', async () => {
  const f = fixture({ failInsert: true });
  await assert.rejects(() => f.host.generate(plan()), /EOL 항목을 정리했습니다/);
  assert.equal(f.sequences.length, 0);
  assert.deepEqual(
    f.items.map((item) => item.name),
    ['game.mp4'],
  );
});
test('cancel before sequence creation leaves source untouched', async () => {
  const f = fixture();
  await assert.rejects(() => f.host.generate(plan(), { isCancelled: () => true }), /취소/);
  assert.equal(f.sequences.length, 0);
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].path, 'C:/game.mp4');
});
test('rejects invalid output positions before touching host', () => {
  const f = fixture(),
    p = plan();
  p.clips[1].outputInFrame = 0;
  assert.throws(() => f.host.validatePlan(p), /시간축/);
  assert.equal(f.transactions.length, 0);
});
