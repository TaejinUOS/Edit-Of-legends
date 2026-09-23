import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { planClips } from '../engine/core.js';
const { adapter } = createRequire(import.meta.url)('../plugin/premiere.js');
// SDK-shaped fake tests the adapter's edit policy. It is not a Premiere integration test.
function fixture({ failInsert = false, failMove = false } = {}) {
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
  const makeSource = (path) => {
    const item = {
      name: path.split('/').at(-1),
      type: 1,
      path,
      isSequence: async () => false,
      isOffline: async () => false,
      getMediaFilePath: async () => item.path,
      getParentBin: () => root,
      createSubClipAction: (name, start, end) =>
        action(() => items.push({ ...item, name, length: end.seconds - start.seconds })),
    };
    return item;
  };
  const item = makeSource('C:/game.mp4');
  items.push(item);
  const root = {
    getItems: async () => items,
    createBinAction: (name) =>
      action(() => {
        const binItems = [];
        const bin = {
          name,
          getItems: async () => binItems,
          getParentBin: () => root,
          createRemoveItemAction: (target) =>
            action(() => {
              const index = binItems.indexOf(target);
              if (index >= 0) binItems.splice(index, 1);
            }),
        };
        items.push(bin);
      }),
    createMoveItemAction: (target, bin) =>
      action(() => {
        if (failMove) throw Error('move failed');
        const index = items.indexOf(target);
        if (index < 0) throw Error('source item missing');
        items.splice(index, 1);
        target.getParentBin = () => bin;
        bin.getItems().then((children) => children.push(target));
      }),
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
    FolderItem: { cast: (x) => (x && typeof x.getItems === 'function' ? x : null) },
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
    addSource: (path) => items.push(makeSource(path)),
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
    out: 400,
    duration: 400,
    openingWindow: { in: 50, out: 210 },
    fpsNum: 60,
    fpsDen: 1,
    audio: [{ channels: 2 }],
  };
  return {
    ...planClips(
      [
        { id: '1', type: 'kill', time: 230 },
        { id: '2', type: 'death', time: 280 },
        { id: '3', type: 'assist', time: 340 },
      ],
      source,
    ),
    source,
  };
}

test('selected timeline videos return every source range in timeline order', async () => {
  const selected = (path, start, inPoint, outPoint) => ({
    getIsSelected: async () => true,
    getStartTime: async () => ({ seconds: start }),
    getSpeed: async () => 1,
    isSpeedReversed: async () => false,
    getProjectItem: async () => ({
      isSequence: async () => false,
      isMulticamClip: async () => false,
      isMergedClip: async () => false,
      isOffline: async () => false,
      getMediaFilePath: async () => path,
    }),
    getInPoint: async () => ({ seconds: inPoint }),
    getOutPoint: async () => ({ seconds: outPoint }),
  });
  const tracks = [
    { getTrackItems: async () => [selected('C:/second.mp4', 20, 30, 40)] },
    { getTrackItems: async () => [selected('C:/first.mp4', 0, 5, 15)] },
  ];
  const sequence = {
    getVideoTrackCount: async () => tracks.length,
    getVideoTrack: async (index) => tracks[index],
  };
  const host = adapter({
    Project: { getActiveProject: async () => ({ getActiveSequence: async () => sequence }) },
    ClipProjectItem: { cast: (item) => item },
    Constants: { TrackItemType: { CLIP: 1 } },
  });
  assert.deepEqual(await host.selectedSources(), [
    { path: 'C:/first.mp4', in: 5, out: 15 },
    { path: 'C:/second.mp4', in: 30, out: 40 },
  ]);
});
test('host creates a NEW validated timeline with correct tracks and synced audio', async () => {
  const f = fixture(),
    result = await f.host.generate(plan());
  assert.equal(result.clips, 4);
  assert.equal(result.audioTracks, 1);
  assert.equal(f.sequences.length, 1);
  assert.equal(f.created.video[0].items.length, 2);
  assert.equal(f.created.video[1].items.length, 1);
  assert.equal(f.created.video[2].items.length, 1);
  assert.equal(f.items[0].name, 'game.mp4');
  const bin = f.items[1];
  assert.equal(bin.name, result.binName);
  const clips = await bin.getItems();
  assert.equal(clips.length, 4);
  assert.match(clips[0].name, /^EOL_1번클립\(오프닝\)_[a-z0-9_]+$/);
  assert.match(clips[1].name, /^EOL_2번클립\(킬\)_[a-z0-9_]+$/);
  assert.match(clips[2].name, /^EOL_3번클립\(데스\)_[a-z0-9_]+$/);
  assert.match(clips[3].name, /^EOL_4번클립\(어시\)_[a-z0-9_]+$/);
  assert.ok(!f.created.name.includes('INCOMPLETE'));
});

test('multiple source plans produce one sequence and one subclip bin', async () => {
  const f = fixture();
  f.addSource('C:/other.mp4');
  const first = plan();
  const second = {
    ...plan(),
    source: { ...first.source, path: 'C:/other.mp4', name: 'other.mp4' },
  };
  const combined = f.host.combinePlans([first, second]);
  assert.equal(combined.clips.length, 8);
  assert.equal(combined.clips[4].sourceIndex, 1);
  assert.equal(combined.clips[4].outputInFrame, first.frames);
  const result = await f.host.generate(combined);
  assert.equal(f.sequences.length, 1);
  assert.equal(result.clips, 8);
  const bin = f.items.find((item) => item.name === result.binName);
  const clips = await bin.getItems();
  assert.equal(clips.length, 8);
  assert.equal(clips[0].path, 'C:/game.mp4');
  assert.equal(clips[4].path, 'C:/other.mp4');
});

test('combined sequence rejects mismatched FPS or audio channels', () => {
  const host = fixture().host;
  const first = plan();
  const slowerSource = { ...first.source, fpsNum: 30 };
  const slower = { ...planClips([{ id: '1', type: 'kill', time: 230 }], slowerSource), source: slowerSource };
  assert.throws(
    () => host.combinePlans([first, slower]),
    /FPS와 오디오/,
  );
  const second = plan();
  second.source = { ...second.source, audio: [{ channels: 1 }] };
  assert.throws(() => host.combinePlans([first, second]), /FPS와 오디오/);
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

test('folder move failure removes generated clips, sequence, and empty bin', async () => {
  const f = fixture({ failMove: true });
  await assert.rejects(() => f.host.generate(plan()), /move failed/);
  assert.equal(f.sequences.length, 0);
  assert.deepEqual(f.items.map((item) => item.name), ['game.mp4']);
});

test('flash clips create V4 with the flash label and synchronized audio', async () => {
  const f = fixture();
  const source = plan().source;
  const edit = { ...planClips([{ id: 'flash-1', type: 'flash', time: 260 }], source), source };
  const result = await f.host.generate(edit);
  assert.equal(result.clips, 2);
  assert.equal(f.created.video[3].items.length, 1);
  assert.match((await f.items[1].getItems())[1].name, /2번클립\(점멸\)/);
  assert.equal(result.audioTracks, 1);
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
