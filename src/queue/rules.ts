// 队列规则层：批次校验、版本比对、原子生效、失败重试、批次失效、字幕改绑。
// 纯函数，不触碰 localStorage，也不关心页面入口。

import type {
  BatchItem,
  ConferenceState,
  QueueBatch,
  Speech,
  SpeechStatus,
  SubmitResult
} from './types';

const now = () => new Date().toISOString();

const ALLOWED_TRANSITIONS: Record<SpeechStatus, SpeechStatus[]> = {
  queued: ['speaking', 'skipped'],
  speaking: ['done', 'skipped'],
  done: [],
  skipped: []
};

function canTransition(from: SpeechStatus, to: SpeechStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

function roomQueue(state: ConferenceState, roomId: string): Speech[] {
  return state.speechQueue.filter((s) => s.roomId === roomId);
}

/** 新建一个待生效批次，来源版本钉住当前队列版本。 */
export function createBatch(
  state: ConferenceState,
  roomId: string,
  items: Array<Omit<BatchItem, 'id' | 'processed'>>
): QueueBatch {
  const batch: QueueBatch = {
    id: crypto.randomUUID(),
    batchNumber: state.queueVersion + 1,
    roomId,
    sourceVersion: state.queueVersion,
    status: 'pending',
    items: items.map((item) => ({ ...item, id: crypto.randomUUID(), processed: false })),
    createdAt: now()
  };
  state.batches.unshift(batch);
  return batch;
}

/** 向已有待生效批次追加项；若批次已失效则新建。 */
export function appendToBatch(
  state: ConferenceState,
  roomId: string,
  item: Omit<BatchItem, 'id' | 'processed'>
): QueueBatch {
  const existing = state.batches.find((b) => b.roomId === roomId && b.status === 'pending');
  if (existing) {
    existing.items.push({ ...item, id: crypto.randomUUID(), processed: false });
    return existing;
  }
  return createBatch(state, roomId, [item]);
}

/** 批次内所有项一起校验，返回冲突项描述。 */
export function validateBatch(state: ConferenceState, batch: QueueBatch): string[] {
  const conflicts: string[] = [];
  let speakingTargets = 0;

  for (const item of batch.items) {
    if (item.processed) continue;

    if (item.kind === 'speech-order') {
      const speech = state.speechQueue.find((s) => s.id === item.speechId);
      if (!speech) {
        conflicts.push(`发言 ${item.speechId} 不存在，可能已被其他页签移除`);
        continue;
      }
      if (speech.roomId !== batch.roomId) {
        conflicts.push(`发言「${speech.speaker}」不属于本会议厅`);
        continue;
      }
      if (!item.targetStatus || !canTransition(speech.status, item.targetStatus)) {
        conflicts.push(`发言「${speech.speaker}」不能从 ${speech.status} 变为 ${item.targetStatus}`);
      }
      if (item.targetStatus === 'speaking') speakingTargets += 1;
    } else if (item.kind === 'interjection') {
      const interj = item.interjection!;
      const roomLen = roomQueue(state, batch.roomId).length;
      if (interj.insertAt < 0 || interj.insertAt > roomLen) {
        conflicts.push(`插话「${interj.speaker}」插入位置 ${interj.insertAt} 超出队列（0..${roomLen}）`);
      }
      if (interj.plannedSeconds < 60 || interj.plannedSeconds > 3600) {
        conflicts.push(`插话「${interj.speaker}」计划时长需在 60..3600 秒之间`);
      }
    } else if (item.kind === 'handoff') {
      const channel = state.channels.find((c) => c.id === item.handoff!.channelId);
      if (!channel) {
        conflicts.push(`频道 ${item.handoff!.channelId} 不存在`);
        continue;
      }
      if (channel.roomId !== batch.roomId) {
        conflicts.push(`频道「${channel.language}」不属于本会议厅`);
      }
    }
  }

  if (speakingTargets > 1) {
    conflicts.push(`一个批次内不能同时让 ${speakingTargets} 位发言人进入发言中`);
  }
  return conflicts;
}

function applySpeechOrder(state: ConferenceState, batch: QueueBatch, item: BatchItem): void {
  state.speechQueue = state.speechQueue.map((s) =>
    s.id === item.speechId ? { ...s, status: item.targetStatus!, updatedAt: now() } : s
  );
  if (item.targetStatus === 'speaking') {
    state.speechQueue = state.speechQueue.map((s) =>
      s.id !== item.speechId && s.roomId === batch.roomId && s.status === 'speaking'
        ? { ...s, status: 'done', updatedAt: now() }
        : s
    );
    // 发言人切换：未提交字幕改绑新发言人，已播出字幕保持原归属
    rebindDraftCaptions(state, batch.roomId);
  }
}

function applyInterjection(state: ConferenceState, batch: QueueBatch, item: BatchItem): void {
  const interj = item.interjection!;
  const speech: Speech = {
    id: crypto.randomUUID(),
    roomId: batch.roomId,
    speaker: interj.speaker,
    delegation: interj.delegation,
    language: interj.language,
    topic: interj.topic,
    plannedSeconds: interj.plannedSeconds,
    remainingSeconds: interj.plannedSeconds,
    status: 'queued',
    updatedAt: now()
  };
  const roomPositions = state.speechQueue
    .map((s, idx) => (s.roomId === batch.roomId ? idx : -1))
    .filter((idx) => idx >= 0);
  const at = roomPositions[interj.insertAt] ?? state.speechQueue.length;
  state.speechQueue = [
    ...state.speechQueue.slice(0, at),
    speech,
    ...state.speechQueue.slice(at)
  ];
}

function applyHandoff(state: ConferenceState, batch: QueueBatch, item: BatchItem): void {
  const handoff = item.handoff!;
  state.channels = state.channels.map((c) => {
    if (c.id !== handoff.channelId) return c;
    if (handoff.phase === 'start') {
      return { ...c, status: 'handoff' as const };
    }
    return { ...c, interpreter: handoff.interpreter, status: 'active' as const, health: Math.min(100, c.health + 2) };
  });
}

function applyItem(state: ConferenceState, batch: QueueBatch, item: BatchItem): void {
  if (item.kind === 'speech-order') applySpeechOrder(state, batch, item);
  else if (item.kind === 'interjection') applyInterjection(state, batch, item);
  else if (item.kind === 'handoff') applyHandoff(state, batch, item);
}

/** 原子生效批次：全部项一起应用，成功后队列版本 +1；失败项保留未处理状态。 */
function applyBatch(state: ConferenceState, batch: QueueBatch): { applied: BatchItem[]; failed: BatchItem[] } {
  const applied: BatchItem[] = [];
  const failed: BatchItem[] = [];

  for (const item of batch.items) {
    if (item.processed) {
      applied.push(item);
      continue;
    }
    try {
      applyItem(state, batch, item);
      item.processed = true;
      item.error = undefined;
      applied.push(item);
    } catch (err) {
      item.error = (err as Error).message;
      failed.push(item);
    }
  }

  if (failed.length === 0) {
    batch.status = 'applied';
    batch.appliedAt = now();
    batch.failureReason = undefined;
    state.queueVersion += 1;
    state.audits.unshift({
      id: crypto.randomUUID(),
      at: now(),
      roomId: batch.roomId,
      message: `批次 #${batch.batchNumber} 已生效（${applied.length} 项），队列版本 → ${state.queueVersion}`
    });
  } else {
    batch.status = 'failed';
    batch.failureReason = failed.map((f) => f.error ?? '未知错误').join('；');
  }
  return { applied, failed };
}

/**
 * 提交批次：先一起校验，来源版本没变再原子替换。
 * 冲突时只返回冲突项和最新版次，不回写队列。
 */
export function submitBatch(state: ConferenceState, batchId: string): SubmitResult {
  const batch = state.batches.find((b) => b.id === batchId) ?? null;
  if (!batch) {
    return { ok: false, conflicts: ['批次不存在或已被移除'], latestVersion: state.queueVersion, batch: null };
  }
  if (batch.status === 'invalidated') {
    return { ok: false, conflicts: ['批次已因会议厅 / 议题 / 频道状态变化失效'], latestVersion: state.queueVersion, batch };
  }

  // 1. 发言顺序、临时插话、译员交接先一起校验
  const conflicts = validateBatch(state, batch);
  if (conflicts.length > 0) {
    batch.status = 'failed';
    batch.failureReason = conflicts.join('；');
    return { ok: false, conflicts, latestVersion: state.queueVersion, batch };
  }

  // 2. 来源版本没变才原子替换当前队列
  if (batch.sourceVersion !== state.queueVersion) {
    batch.status = 'failed';
    batch.failureReason = `版本冲突：来源 ${batch.sourceVersion}，最新 ${state.queueVersion}`;
    return {
      ok: false,
      conflicts: [`队列已被其他页签更新（最新版次 ${state.queueVersion}），请重试以续做未处理项`],
      latestVersion: state.queueVersion,
      batch
    };
  }

  // 3. 原子应用
  const { failed } = applyBatch(state, batch);
  if (failed.length > 0) {
    return {
      ok: false,
      conflicts: failed.map((f) => f.error ?? '未知错误'),
      latestVersion: state.queueVersion,
      batch
    };
  }
  return { ok: true, batch };
}

/**
 * 重试失败批次：只续做没处理的发言 / 插话 / 交接，
 * 已处理项保持 processed，不重复排队或交接。
 */
export function retryBatch(state: ConferenceState, batchId: string): SubmitResult {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch) {
    return { ok: false, conflicts: ['批次不存在'], latestVersion: state.queueVersion, batch: null };
  }
  if (batch.status === 'invalidated') {
    return { ok: false, conflicts: ['批次已失效，不能重试'], latestVersion: state.queueVersion, batch };
  }
  // 只重置未处理项的错误，已处理项不动
  for (const item of batch.items) {
    if (!item.processed) item.error = undefined;
  }
  batch.status = 'pending';
  batch.failureReason = undefined;
  return submitBatch(state, batchId);
}

/** 作废待生效批次。 */
export function discardBatch(state: ConferenceState, batchId: string): void {
  const batch = state.batches.find((b) => b.id === batchId);
  if (batch && batch.status === 'pending') {
    batch.status = 'invalidated';
  }
}

/**
 * 会议厅、议题或频道状态变化后，该厅旧批次立即失效。
 * 切厅、改议题、频道交接状态变化时调用。
 */
export function invalidateBatchesForRoom(state: ConferenceState, roomId: string, reason: string): void {
  for (const batch of state.batches) {
    if (batch.roomId === roomId && batch.status === 'pending') {
      batch.status = 'invalidated';
      batch.failureReason = reason;
    }
  }
  state.audits.unshift({ id: crypto.randomUUID(), at: now(), roomId, message: `旧批次已失效：${reason}` });
}

/**
 * 未提交字幕改绑新发言人：该厅所有 draft 字幕切到当前发言人和对应频道译员；
 * 已播出（broadcast）字幕保持原归属不动。
 */
export function rebindDraftCaptions(state: ConferenceState, roomId: string): void {
  const current = state.speechQueue.find((s) => s.roomId === roomId && s.status === 'speaking');
  if (!current) return;
  const channel = state.channels.find((c) => c.roomId === roomId && c.language === '中文');
  state.captions = state.captions.map((c) => {
    if (c.roomId === roomId && c.status === 'draft') {
      return { ...c, speechId: current.id, interpreter: channel?.interpreter ?? c.interpreter };
    }
    return c;
  });
}

/** 发布字幕：草稿累积修订；播出后冻结为 broadcast，归属不再随发言人切换改变。 */
export function publishCaption(
  state: ConferenceState,
  speechId: string,
  text: string,
  broadcast: boolean
): void {
  const speech = state.speechQueue.find((s) => s.id === speechId);
  const channel = state.channels.find((c) => c.roomId === speech?.roomId && c.language === '中文');
  if (!speech || !channel || !text.trim()) return;

  const existing = state.captions.find((c) => c.speechId === speechId && c.language === channel.language);
  if (existing) {
    state.captions = state.captions.map((c) =>
      c.id === existing.id
        ? {
            ...c,
            text,
            revision: c.revision + 1,
            interpreter: channel.interpreter,
            status: broadcast ? 'broadcast' : c.status,
            at: now()
          }
        : c
    );
  } else {
    state.captions.unshift({
      id: crypto.randomUUID(),
      speechId,
      roomId: speech.roomId,
      language: channel.language,
      interpreter: channel.interpreter,
      text,
      revision: 1,
      at: now(),
      status: broadcast ? 'broadcast' : 'draft'
    });
  }
}

/** 迁移：旧数据没有批次号时，用当前队列快照建一个基准批，版本归 1。 */
export function ensureBaseline(state: ConferenceState): ConferenceState {
  if (typeof state.queueVersion !== 'number' || !Array.isArray(state.batches)) {
    state.queueVersion = 1;
    state.batches = [
      {
        id: crypto.randomUUID(),
        batchNumber: 1,
        roomId: state.activeRoomId,
        sourceVersion: 1,
        status: 'applied',
        items: [],
        createdAt: now(),
        appliedAt: now(),
        failureReason: undefined
      }
    ];
  }
  // 旧字幕没有 status 字段时，视为已播出，保持原归属
  state.captions = state.captions.map((c) =>
    c.status ? c : { ...c, status: 'broadcast' as const }
  );
  return state;
}
