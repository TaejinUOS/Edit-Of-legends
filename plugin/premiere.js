/* Host adapter. All edits target a newly created sequence and newly created subclips. */
function adapter(ppro) {
  function transaction(project, label, actions) {
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((compound) => {
        for (const action of actions) compound.addAction(action);
      }, label);
    });
    if (!ok) throw Error(label + ' 작업을 적용하지 못했습니다.');
  }
  const canonical = (p) => p.replace(/\\/g, '/').toLowerCase();
  async function descendants(folder) {
    const result = [];
    for (const item of await folder.getItems()) {
      result.push(item);
      let bin;
      try {
        bin = ppro.FolderItem.cast(item);
      } catch {}
      if (bin) result.push(...(await descendants(bin)));
    }
    return result;
  }
  async function selectedSource() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw Error('Premiere 프로젝트를 여세요.');
    const sequence = await project.getActiveSequence();
    if (!sequence) throw Error('원본 클립이 있는 시퀀스를 여세요.');
    const videos = [];
    for (let i = 0; i < (await sequence.getVideoTrackCount()); i++) {
      const track = await sequence.getVideoTrack(i);
      for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false))
        if (await item.getIsSelected()) videos.push(item);
    }
    if (videos.length !== 1)
      throw Error(
        '타임라인에서 영상 클립 하나를 선택하세요. 연결된 오디오는 함께 선택해도 됩니다.',
      );
    const item = videos[0];
    if (Math.abs((await item.getSpeed()) - 1) > 0.00001 || (await item.isSpeedReversed()))
      throw Error('속도 변경·역재생 클립은 지원하지 않습니다.');
    const clip = ppro.ClipProjectItem.cast(await item.getProjectItem());
    if (
      !clip ||
      (await clip.isSequence()) ||
      (await clip.isMulticamClip()) ||
      (await clip.isMergedClip()) ||
      (await clip.isOffline())
    )
      throw Error('온라인 상태의 일반 녹화 클립을 선택하세요.');
    return {
      path: await clip.getMediaFilePath(),
      in: (await item.getInPoint()).seconds,
      out: (await item.getOutPoint()).seconds,
    };
  }
  function validatePlan(plan) {
    if (
      !plan?.source?.path ||
      ![30, 60].includes(plan.fpsNum) ||
      plan.fpsDen !== 1 ||
      !Array.isArray(plan.clips) ||
      !plan.clips.length
    )
      throw Error('유효한 편집 계획이 필요합니다.');
    let cursor = 0,
      last = -1;
    for (const c of plan.clips) {
      if (
        ![c.inFrame, c.outFrame, c.outputInFrame, c.outputOutFrame, c.track].every(
          Number.isInteger,
        ) ||
        c.inFrame < 0 ||
        c.outFrame <= c.inFrame ||
        c.inFrame < last ||
        c.outputInFrame !== cursor ||
        c.outputOutFrame - c.outputInFrame !== c.outFrame - c.inFrame ||
        ![0, 1, 2].includes(c.track) ||
        c.inFrame < Math.ceil(plan.source.in * plan.fpsNum - 1e-7) ||
        c.outFrame > Math.floor(plan.source.out * plan.fpsNum + 1e-7)
      )
        throw Error('컷 계획의 범위 또는 시간축이 올바르지 않습니다.');
      cursor = c.outputOutFrame;
      last = c.outFrame;
    }
    if (cursor !== plan.frames) throw Error('편집 계획 길이가 일치하지 않습니다.');
  }
  async function generate(plan, { onProgress = () => {}, isCancelled = () => false } = {}) {
    validatePlan(plan);
    const project = await ppro.Project.getActiveProject();
    if (!project) throw Error('Premiere 프로젝트를 여세요.');
    const root = await project.getRootItem();
    let original = null;
    for (const item of await descendants(root)) {
      let clip;
      try {
        clip = ppro.ClipProjectItem.cast(item);
      } catch {}
      if (
        clip &&
        !(await clip.isSequence()) &&
        canonical(await clip.getMediaFilePath()) === canonical(plan.source.path)
      ) {
        original = clip;
        break;
      }
    }
    if (!original) throw Error('분석한 원본 파일을 현재 Premiere 프로젝트에 먼저 가져오세요.');
    if (await original.isOffline()) throw Error('원본 파일이 오프라인 상태입니다.');
    const rate = ppro.FrameRate.createWithValue(plan.fpsNum / plan.fpsDen),
      time = (f) => ppro.TickTime.createWithFrameAndFrameRate(f, rate);
    const uid = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const prefix = 'EOL_' + uid,
      names = plan.clips.map((c, i) => `${prefix}_${String(i + 1).padStart(3, '0')}_${c.type}`);
    let sequence = null;
    try {
      onProgress('소스 구간 생성', 0);
      transaction(
        project,
        'EditOfLegends: 컷 소스 생성',
        plan.clips.map((c, i) =>
          original.createSubClipAction(names[i], time(c.inFrame), time(c.outFrame), false, {
            takeVideo: true,
            takeAudio: true,
          }),
        ),
      );
      const all = await descendants(root);
      const media = names.map((name) => {
        const item = all.find((x) => x.name === name);
        if (!item) throw Error('생성한 서브클립을 찾을 수 없습니다: ' + name);
        return ppro.ClipProjectItem.cast(item);
      });
      if (isCancelled()) throw Error('시퀀스 생성을 취소했습니다.');
      sequence = await project.createSequenceFromMedia(prefix + '_INCOMPLETE', [original], root);
      if (!sequence) throw Error('새 시퀀스를 생성하지 못했습니다.');
      const editor = ppro.SequenceEditor.getEditor(sequence),
        initial = [];
      for (let i = 0; i < (await sequence.getVideoTrackCount()); i++)
        initial.push(
          ...(await (
            await sequence.getVideoTrack(i)
          ).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)),
        );
      for (let i = 0; i < (await sequence.getAudioTrackCount()); i++)
        initial.push(
          ...(await (
            await sequence.getAudioTrack(i)
          ).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)),
        );
      if (initial.length) {
        let selection;
        ppro.TrackItemSelection.createEmptySelection((s) => {
          selection = s;
          for (const item of initial) s.addItem(item, false);
        });
        transaction(project, 'EditOfLegends: 새 시퀀스 초기화', [
          editor.createRemoveItemsAction(selection, false, ppro.Constants.MediaType.VIDEO, false),
        ]);
      }
      for (let i = 0; i < plan.clips.length; i++) {
        if (isCancelled()) throw Error('시퀀스 생성을 취소했습니다.');
        const c = plan.clips[i];
        transaction(project, 'EditOfLegends: 컷 ' + (i + 1), [
          editor.createInsertProjectItemAction(media[i], time(c.outputInFrame), c.track, 0, true),
        ]);
        onProgress(`컷 ${i + 1} / ${plan.clips.length}`, (i + 1) / plan.clips.length);
      }
      // Inspect the resulting timeline; never report success on API return values alone.
      const actual = [];
      for (let i = 0; i < (await sequence.getVideoTrackCount()); i++) {
        const track = await sequence.getVideoTrack(i);
        if (i < 3)
          transaction(project, 'EditOfLegends: 트랙 이름', [
            track.createSetNameAction(['EOL · Kill', 'EOL · Assist', 'EOL · Death'][i]),
          ]);
        for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false))
          actual.push({
            track: i,
            start: (await item.getStartTime()).seconds,
            end: (await item.getEndTime()).seconds,
          });
      }
      actual.sort((a, b) => a.start - b.start);
      const fps = plan.fpsNum / plan.fpsDen,
        epsilon = 0.5 / fps;
      if (
        actual.length !== plan.clips.length ||
        actual.some(
          (a, i) =>
            a.track !== plan.clips[i].track ||
            Math.abs(a.start - plan.clips[i].outputInFrame / fps) > epsilon ||
            Math.abs(a.end - plan.clips[i].outputOutFrame / fps) > epsilon,
        )
      )
        throw Error('생성한 영상의 트랙 또는 길이 검증에 실패했습니다.');
      let audioTracks = 0;
      for (let i = 0; i < (await sequence.getAudioTrackCount()); i++) {
        const items = await (
          await sequence.getAudioTrack(i)
        ).getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
        if (!items.length) continue;
        audioTracks++;
        if (items.length !== plan.clips.length)
          throw Error('오디오 컷 수가 영상과 일치하지 않습니다.');
        for (let j = 0; j < items.length; j++)
          if (
            Math.abs((await items[j].getStartTime()).seconds - plan.clips[j].outputInFrame / fps) >
              epsilon ||
            Math.abs((await items[j].getEndTime()).seconds - plan.clips[j].outputOutFrame / fps) >
              epsilon
          )
            throw Error('오디오 동기화 검증에 실패했습니다.');
      }
      if (audioTracks < plan.source.audio.length)
        throw Error('일부 오디오 트랙이 누락되었습니다. 원본 오디오 채널 매핑을 확인하세요.');
      const name = 'EOL_' + plan.source.name.replace(/\.[^.]+$/, '') + '_' + uid;
      transaction(project, 'EditOfLegends: 생성 완료', [
        (await sequence.getProjectItem()).createSetNameAction(name),
      ]);
      await project.openSequence(sequence);
      await project.setActiveSequence(sequence);
      return { name, clips: actual.length, audioTracks };
    } catch (e) {
      throw Error(
        e.message +
          (sequence
            ? `\n${prefix}_INCOMPLETE 시퀀스는 미완료 상태입니다. 기존 시퀀스는 변경되지 않았습니다.`
            : '\n생성된 EOL 서브클립은 프로젝트에 남아 있을 수 있습니다.'),
      );
    }
  }
  return { selectedSource, generate, validatePlan };
}
module.exports = { adapter };
