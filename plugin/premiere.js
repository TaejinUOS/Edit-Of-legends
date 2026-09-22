/* Host adapter. All edits target a newly created sequence and newly created subclips. */
function adapter(ppro) {
  function transaction(project, label, createActions) {
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((compound) => {
        const actions = createActions();
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
        ![0, 1, 2, 3].includes(c.track) ||
        c.inFrame < Math.ceil(plan.source.in * plan.fpsNum - 1e-7) ||
        c.outFrame > Math.floor(plan.source.out * plan.fpsNum + 1e-7)
      )
        throw Error('컷 계획의 범위 또는 시간축이 올바르지 않습니다.');
      cursor = c.outputOutFrame;
      last = c.outFrame;
    }
    if (cursor !== plan.frames) throw Error('편집 계획 길이가 일치하지 않습니다.');
  }
  async function findSource(root, mediaPath, excludedNames = []) {
    for (const item of await descendants(root)) {
      let clip;
      try {
        clip = ppro.ClipProjectItem.cast(item);
      } catch {}
      if (
        clip &&
        !excludedNames.includes(item.name) &&
        !(await clip.isSequence()) &&
        canonical(await clip.getMediaFilePath()) === canonical(mediaPath)
      )
        return clip;
    }
    return null;
  }
  async function sequenceByGuid(project, guid) {
    if (!guid) return null;
    return (
      (await project.getSequences()).find((sequence) => String(sequence.guid) === String(guid)) ??
      null
    );
  }
  async function cleanupArtifacts(projectGuid, artifactNames, sequenceGuid, previousSequenceGuid) {
    const failures = [];
    let project = ppro.Project.getProject(projectGuid);
    if (sequenceGuid) {
      try {
        let sequence = await sequenceByGuid(project, sequenceGuid);
        if (previousSequenceGuid) {
          const previousSequence = await sequenceByGuid(project, previousSequenceGuid);
          if (previousSequence) {
            await project.openSequence(previousSequence);
            await project.setActiveSequence(previousSequence);
          }
        }
        project = ppro.Project.getProject(projectGuid);
        sequence = await sequenceByGuid(project, sequenceGuid);
        if (sequence) {
          await project.closeSequence(sequence);
          if (!(await project.deleteSequence(sequence))) failures.push('미완료 시퀀스');
        }
      } catch {
        failures.push('미완료 시퀀스');
      }
    }
    try {
      project = ppro.Project.getProject(projectGuid);
      const root = await project.getRootItem();
      const leftovers = (await descendants(root)).filter((item) =>
        artifactNames.includes(item.name),
      );
      if (leftovers.length) {
        const entries = leftovers.map((item) => ({ item, parent: item.getParentBin() }));
        transaction(project, 'EditOfLegends: 실패 항목 정리', () =>
          entries.map(({ item, parent }) => parent.createRemoveItemAction(item)),
        );
      }
    } catch {
      failures.push('EOL 서브클립');
    }
    return failures;
  }
  async function generate(plan, { onProgress = () => {}, isCancelled = () => false } = {}) {
    validatePlan(plan);
    let project = await ppro.Project.getActiveProject();
    if (!project) throw Error('Premiere 프로젝트를 여세요.');
    const projectGuid = project.guid;
    const previousSequenceGuid = (await project.getActiveSequence())?.guid ?? null;
    let root = await project.getRootItem();
    let original = await findSource(root, plan.source.path);
    if (!original) throw Error('분석한 원본 파일을 현재 Premiere 프로젝트에 먼저 가져오세요.');
    if (await original.isOffline()) throw Error('원본 파일이 오프라인 상태입니다.');
    const time = (f) =>
      ppro.TickTime.createWithFrameAndFrameRate(
        f,
        ppro.FrameRate.createWithValue(plan.fpsNum / plan.fpsDen),
      );
    const uid = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const prefix = 'EOL_' + uid;
    const eventLabels = {
      opening: '오프닝',
      kill: '킬',
      assist: '어시',
      death: '데스',
      flash: '점멸',
    };
    const names = plan.clips.map(
      (clip, index) => `EOL_${index + 1}번클립(${eventLabels[clip.type] ?? clip.type})_${uid}`,
    );
    let sequenceGuid = null,
      stage = '서브클립 생성';
    try {
      onProgress('소스 구간 생성', 0);
      transaction(project, 'EditOfLegends: 컷 소스 생성', () =>
        plan.clips.map((c, i) =>
          original.createSubClipAction(names[i], time(c.inFrame), time(c.outFrame), false, {
            takeVideo: true,
            takeAudio: true,
          }),
        ),
      );
      stage = '서브클립 다시 불러오기';
      project = ppro.Project.getProject(projectGuid);
      root = await project.getRootItem();
      const all = await descendants(root);
      let media = names.map((name) => {
        const item = all.find((x) => x.name === name);
        if (!item) throw Error('생성한 서브클립을 찾을 수 없습니다: ' + name);
        // Validate that this is a clip, but retain the base ProjectItem wrapper.
        // SequenceEditor insert/overwrite actions reject a ClipProjectItem cast
        // wrapper in some Premiere 26.x builds even though it represents the
        // same underlying project item.
        ppro.ClipProjectItem.cast(item);
        return item;
      });
      original = await findSource(root, plan.source.path, names);
      if (!original) throw Error('원본 클립을 다시 찾을 수 없습니다.');
      if (isCancelled()) throw Error('시퀀스 생성을 취소했습니다.');
      stage = '새 시퀀스 생성';
      let sequence = await project.createSequenceFromMedia(
        prefix + '_INCOMPLETE',
        [original],
        root,
      );
      if (!sequence) throw Error('새 시퀀스를 생성하지 못했습니다.');
      sequenceGuid = sequence.guid;

      stage = '새 시퀀스 활성화';
      if (!(await project.openSequence(sequence)) || !(await project.setActiveSequence(sequence)))
        throw Error('새 시퀀스를 활성화하지 못했습니다.');

      stage = '활성 시퀀스 다시 불러오기';
      project = ppro.Project.getProject(projectGuid);
      sequence = await project.getActiveSequence();
      if (!sequence || String(sequence.guid) !== String(sequenceGuid))
        throw Error('새 시퀀스가 활성 상태가 아닙니다.');
      stage = '컷 배치 항목 다시 불러오기';
      root = await project.getRootItem();
      const freshItems = await descendants(root);
      media = names.map((name) => {
        const item = freshItems.find((x) => x.name === name);
        if (!item) throw Error('배치할 서브클립을 다시 찾을 수 없습니다: ' + name);
        ppro.ClipProjectItem.cast(item);
        return item;
      });
      const initialVideo = [];
      stage = '초기 비디오 클립 조회';
      for (let i = 0; i < (await sequence.getVideoTrackCount()); i++)
        initialVideo.push(
          ...(await (
            await sequence.getVideoTrack(i)
          ).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)),
        );
      if (initialVideo.length) {
        // Premiere 26.5 can reject a detached TrackItemSelection created with
        // createEmptySelection() when it is passed to createRemoveItemsAction().
        // Build the selection from the sequence-owned live object instead.
        stage = '초기 비디오 선택 초기화';
        if (!(await sequence.clearSelection())) throw Error('시퀀스 선택을 초기화하지 못했습니다.');
        const videoSelection = await sequence.getSelection();
        if (!videoSelection) throw Error('시퀀스 선택 객체를 가져오지 못했습니다.');
        stage = '초기 비디오 선택 구성';
        for (const item of initialVideo)
          if (!videoSelection.addItem(item, true))
            throw Error('초기 비디오 클립을 선택하지 못했습니다.');
        stage = '초기 비디오 클립 제거';
        transaction(project, 'EditOfLegends: 초기 비디오 제거', () => [
          ppro.SequenceEditor.getEditor(sequence).createRemoveItemsAction(
            videoSelection,
            false,
            ppro.Constants.MediaType.VIDEO,
          ),
        ]);
      }

      project = ppro.Project.getProject(projectGuid);
      sequence = await project.getActiveSequence();
      const initialAudio = [];
      stage = '초기 오디오 클립 조회';
      for (let i = 0; i < (await sequence.getAudioTrackCount()); i++)
        initialAudio.push(
          ...(await (
            await sequence.getAudioTrack(i)
          ).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)),
        );
      if (initialAudio.length) {
        stage = '초기 오디오 선택 초기화';
        if (!(await sequence.clearSelection())) throw Error('시퀀스 선택을 초기화하지 못했습니다.');
        const audioSelection = await sequence.getSelection();
        if (!audioSelection) throw Error('시퀀스 선택 객체를 가져오지 못했습니다.');
        stage = '초기 오디오 선택 구성';
        for (const item of initialAudio)
          if (!audioSelection.addItem(item, true))
            throw Error('초기 오디오 클립을 선택하지 못했습니다.');
        stage = '초기 오디오 클립 제거';
        transaction(project, 'EditOfLegends: 초기 오디오 제거', () => [
          ppro.SequenceEditor.getEditor(sequence).createRemoveItemsAction(
            audioSelection,
            false,
            ppro.Constants.MediaType.AUDIO,
          ),
        ]);
      }

      if (isCancelled()) throw Error('시퀀스 생성을 취소했습니다.');
      project = ppro.Project.getProject(projectGuid);
      sequence = await project.getActiveSequence();
      for (let i = 0; i < plan.clips.length; i++) {
        if (isCancelled()) throw Error('시퀀스 생성을 취소했습니다.');
        const c = plan.clips[i];
        stage = `컷 ${i + 1}/${plan.clips.length} 배치`;
        onProgress(stage, 0.2 + (0.6 * i) / plan.clips.length);
        transaction(project, `EditOfLegends: 컷 ${i + 1} 배치`, () => [
          ppro.SequenceEditor.getEditor(sequence).createInsertProjectItemAction(
            media[i],
            time(c.outputInFrame),
            c.track,
            0,
            true,
          ),
        ]);
      }
      onProgress('생성 결과 검증', 0.8);

      stage = '생성 결과 검증';
      project = ppro.Project.getProject(projectGuid);
      sequence = await project.getActiveSequence();
      if (!sequence || String(sequence.guid) !== String(sequenceGuid))
        throw Error('생성한 시퀀스가 활성 상태가 아닙니다.');
      // Inspect the resulting timeline; never report success on API return values alone.
      const actual = [],
        tracksToRename = [];
      for (let i = 0; i < (await sequence.getVideoTrackCount()); i++) {
        const track = await sequence.getVideoTrack(i);
        if (i < 4) tracksToRename.push({ track, index: i });
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
      stage = '이름 지정';
      const name = 'EOL_하이라이트_' + plan.source.name.replace(/\.[^.]+$/, '') + '_' + uid;
      const sequenceItem = await sequence.getProjectItem();
      transaction(project, 'EditOfLegends: 생성 완료', () => [
        ...tracksToRename.map(({ track, index }) =>
          track.createSetNameAction(
            ['EOL · 오프닝/킬', 'EOL · 어시', 'EOL · 데스', 'EOL · 점멸'][index],
          ),
        ),
        sequenceItem.createSetNameAction(name),
      ]);
      project = ppro.Project.getProject(projectGuid);
      sequence = await project.getActiveSequence();
      await project.openSequence(sequence);
      await project.setActiveSequence(sequence);
      return { name, clips: actual.length, audioTracks };
    } catch (e) {
      const cleanupFailures = await cleanupArtifacts(
        projectGuid,
        names,
        sequenceGuid,
        previousSequenceGuid,
      );
      throw Error(
        `${stage}: ${e.message}` +
          (cleanupFailures.length
            ? `\n정리하지 못한 항목: ${cleanupFailures.join(', ')}. 프로젝트 패널에서 ${prefix} 항목을 삭제하세요.`
            : '\n실패 중 생성된 EOL 항목을 정리했습니다. 기존 시퀀스는 변경되지 않았습니다.'),
      );
    }
  }
  return { selectedSource, generate, validatePlan };
}
module.exports = { adapter };
