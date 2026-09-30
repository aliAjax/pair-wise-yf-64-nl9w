// 队列规则：待生效批次的创建、校验、原子替换、失效与幂等续做。
// 纯函数模块：不读 localStorage、不依赖 Qwik，便于单独测试与复用。
// 持久化（persistence.ts）与页面入口（routes）只调用这里导出的规则。

import type {
  Caption,
  CaptionDraft,
  Channel,
  ConferenceState,
  InterjectOp,
  QueueBatch,
  QueueOp,
  Room,
  Speech,
} from './types';

export const BASELINE_BATCH_ID = 'batch-baseline';
export const BASELINE_VERSION = 1;

export interface QueueSnapshot {
  /** 提交生效时使用的队列版次 */
  version: number;
  orderedIds: string[];
}

export interface ValidationIssue {
  opId: string;
  reason: string;
}

export interface CommitResult {
  ok: boolean;
  batch: QueueBatch;
  /** 冲突时只带冲突项与最新版次，便于晚提交页签展示 */
  conflict?: { latestVersion: number; issues: ValidationIssue[] };
}

// ---------- 快照与上下文指纹 ----------

/** 当前厅队列快照：speaking 在前，queued 按数组顺序，其后 done/skipped */
export function snapshotQueue(state: ConferenceState, roomId: string): QueueSnapshot {
  const room = state.rooms.find((item) => item.id === roomId);
  const list = roomQueueOrdered(state, roomId);
  return {
    version: room?.queueVersion ?? BASELINE_VERSION,
    orderedIds: list.map((item) => item.id),
  };
}

/** 页面渲染用：发言中 → 排队中（含批次生效后的新顺序）→ 完成/跳过 */
export function roomQueueOrdered(state: ConferenceState, roomId: string): Speech[] {
  return state.speechQueue
    .filter((item) => item.roomId === roomId)
    .sort(compareQueueOrder);
}

function compareQueueOrder(a: Speech, b: Speech): number {
  const rank = (s: Speech['status']) => (s === 'speaking' ? 0 : s === 'queued' ? 1 : 2);
  const diff = rank(a.status) - rank(b.status);
  if (diff !== 0) return diff;
  return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
}

/** 厅级上下文指纹：厅名、议题、频道（译员 + 状态 + 语言集合）任一变化都会改变 */
export function roomFingerprint(room: Room, channels: Channel[]): string {
  const compact = channels
    .filter((channel) => channel.roomId === room.id)
    .map((channel) => `${channel.id}:${channel.language}:${channel.interpreter}:${channel.status}`)
    .sort()
    .join('|');
  return `${room.name}#${room.topic}#${compact}`;
}

// ---------- 批次创建 ----------

export function createBatch(state: ConferenceState, roomId: string, ops: QueueOp[]): QueueBatch {
  const room = state.rooms.find((item) => item.id === roomId);
  const snap = snapshotQueue(state, roomId);
  const ts = new Date().toISOString();
  return {
    id: `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    roomId,
    baseVersion: snap.version,
    contextFingerprint: room ? roomFingerprint(room, state.channels) : '',
    ops: ops.map((op) => ({ ...op })),
    status: 'pending',
    confirmedUpTo: 0,
    deliveredKeys: [],
    handedOffChannelIds: [],
    failures: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

// ---------- 失效：会议厅 / 议题 / 频道状态变化后旧批次立即失效 ----------

export function invalidateStaleBatches(
  batches: QueueBatch[],
  state: ConferenceState,
  roomId: string,
  nowIso = new Date().toISOString(),
): QueueBatch[] {
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room) return batches;
  const fingerprint = roomFingerprint(room, state.channels);
  return batches.map((batch) =>
    batch.roomId === roomId &&
    (batch.status === 'pending' || batch.status === 'confirming' || batch.status === 'conflict') &&
    (batch.baseVersion !== room.queueVersion || batch.contextFingerprint !== fingerprint)
      ? { ...batch, status: 'invalidated', updatedAt: nowIso }
      : batch,
  );
}

// ---------- 校验：顺序、临时插话、译员交接先一起校验 ----------

function validateAgainst(state: ConferenceState, batch: QueueBatch, version: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const room = state.rooms.find((item) => item.id === batch.roomId);
  if (!room) {
    return batch.ops.map((op) => ({ opId: op.opId, reason: '会议厅不存在' }));
  }
  if (room.queueVersion !== version) {
    // 版本不一致：逐操作找出与当前队列冲突的项，只返回冲突项
    const queued = state.speechQueue
      .filter((item) => item.roomId === batch.roomId && item.status === 'queued')
      .sort(compareQueueOrder);
    for (const op of batch.ops) {
      if (op.kind === 'reorder') {
        const speech = state.speechQueue.find((item) => item.id === op.speechId);
        if (!speech) issues.push({ opId: op.opId, reason: '发言人已离场，顺序调整无目标' });
        else if (speech.roomId !== batch.roomId || speech.status !== 'queued')
          issues.push({ opId: op.opId, reason: `发言人当前状态为 ${speech.status}，不能参与重排` });
        else if (op.toIndex < 0 || op.toIndex >= queued.length)
          issues.push({ opId: op.opId, reason: `目标位次 ${op.toIndex + 1} 超出当前排队区间（1-${queued.length}）` });
      } else if (op.kind === 'handoff') {
        const channel = state.channels.find((item) => item.id === op.channelId);
        if (!channel || channel.roomId !== batch.roomId)
          issues.push({ opId: op.opId, reason: '频道不存在或属于其他会议厅' });
        else if (channel.status !== 'handoff')
          issues.push({ opId: op.opId, reason: `频道当前为 ${channel.status}，未处于交接中` });
      }
    }
    return issues;
  }

  // 版本一致：再做业务规则整体校验
  const queued = state.speechQueue
    .filter((item) => item.roomId === batch.roomId && item.status === 'queued')
    .sort(compareQueueOrder);
  const interjectTargets = new Set<string>();
  for (const op of batch.ops) {
    if (op.kind === 'reorder') {
      const speech = state.speechQueue.find((item) => item.id === op.speechId);
      if (!speech || speech.roomId !== batch.roomId || speech.status !== 'queued')
        issues.push({ opId: op.opId, reason: '仅排队中的发言可以调整顺序' });
      else if (op.toIndex < 0 || op.toIndex >= queued.length)
        issues.push({ opId: op.opId, reason: `目标位次 ${op.toIndex + 1} 超出排队区间（1-${queued.length}）` });
    } else if (op.kind === 'interject') {
      const { speaker, delegation, topic, plannedSeconds } = op.draft;
      if (!speaker.trim() || !delegation.trim() || !topic.trim())
        issues.push({ opId: op.opId, reason: '临时插话缺少发言人、代表团或议题' });
      if (!Number.isFinite(plannedSeconds) || plannedSeconds < 60 || plannedSeconds > 3600)
        issues.push({ opId: op.opId, reason: '计划时长需在 60–3600 秒之间' });
      const upper = op.atIndex === -1 ? queued.length : op.atIndex;
      if (op.atIndex !== -1 && (upper < 0 || upper > queued.length))
        issues.push({ opId: op.opId, reason: `插位次 ${upper + 1} 超出排队区间（1-${queued.length + 1}）` });
      const key = interjectKey(op);
      if (interjectTargets.has(key)) issues.push({ opId: op.opId, reason: '同一插话在批次内重复' });
      interjectTargets.add(key);
    } else if (op.kind === 'handoff') {
      const channel = state.channels.find((item) => item.id === op.channelId);
      if (!channel || channel.roomId !== batch.roomId)
        issues.push({ opId: op.opId, reason: '频道不存在或属于其他会议厅' });
      else if (channel.status !== 'handoff')
        issues.push({ opId: op.opId, reason: '频道未处于交接中，不能完成交接' });
      else if (!op.nextInterpreter.trim())
        issues.push({ opId: op.opId, reason: '未指定接替译员' });
      const sameChannel = batch.ops.filter(
        (other) => other.kind === 'handoff' && other.channelId === op.channelId,
      );
      if (sameChannel.length > 1) issues.push({ opId: op.opId, reason: '同一频道在批次内重复交接' });
    }
  }
  return issues;
}

export function interjectKey(op: InterjectOp): string {
  return `${op.draft.speaker}|${op.draft.delegation}|${op.draft.topic}`;
}

// ---------- 原子提交：来源版本没变才替换当前队列 ----------

/**
 * 提交批次：
 * 1. 来源版本变化 → 批次置 conflict，只返回冲突项与最新版次，不改动队列；
 * 2. 上下文指纹变化 → 批次立即失效（厅/议题/频道状态变化）；
 * 3. 全部校验通过 → 在一次原子更新内替换队列、完成交接、版次 +1；
 * 4. 下游确认失败 → 保留未完成项，批次停留 confirming，重试只续做。
 *
 * failBeforeIndex 模拟/注入下游确认失败：0 基下标，确认到该操作前中断。
 * 真实入口可在外部逐步推进 confirmedUpTo；这里保证已确认操作幂等不重复。
 */
export function commitBatch(
  draft: ConferenceState,
  batchId: string,
  options: { failBeforeIndex?: number } = {},
): CommitResult {
  const batchIndex = draft.batches.findIndex((item) => item.id === batchId);
  if (batchIndex < 0) throw new Error(`批次不存在：${batchId}`);
  const batch = draft.batches[batchIndex];
  const nowIso = new Date().toISOString();
  const room = draft.rooms.find((item) => item.id === batch.roomId);

  if (!room) {
    const failed = failBatch(batch, 'invalidated', nowIso, [], '会议厅已删除');
    draft.batches[batchIndex] = failed;
    return { ok: false, batch: failed };
  }

  // 厅 / 议题 / 频道状态变化：旧批次立即失效
  if (batch.contextFingerprint !== roomFingerprint(room, draft.channels)) {
    const invalidated = failBatch(batch, 'invalidated', nowIso, [], '会议厅、议题或频道状态已变化');
    draft.batches[batchIndex] = invalidated;
    return { ok: false, batch: invalidated };
  }

  // 来源版本已变：只返回冲突项和最新版次
  if (room.queueVersion !== batch.baseVersion) {
    const issues = validateAgainst(draft, batch, room.queueVersion);
    const conflicted = {
      ...batch,
      status: 'conflict' as const,
      conflict: {
        latestVersion: room.queueVersion,
        conflictingOpIds: issues.map((issue) => issue.opId),
        reasons: issues.map((issue) => issue.reason),
      },
      failures: mergeFailures(batch.failures, issues),
      updatedAt: nowIso,
    };
    draft.batches[batchIndex] = conflicted;
    return {
      ok: false,
      batch: conflicted,
      conflict: { latestVersion: room.queueVersion, issues },
    };
  }

  // 来源版本未变，整体校验
  const issues = validateAgainst(draft, batch, batch.baseVersion);
  if (issues.length > 0) {
    const rejected = {
      ...batch,
      status: 'conflict' as const,
      conflict: {
        latestVersion: room.queueVersion,
        conflictingOpIds: issues.map((issue) => issue.opId),
        reasons: issues.map((issue) => issue.reason),
      },
      failures: mergeFailures(batch.failures, issues),
      updatedAt: nowIso,
    };
    draft.batches[batchIndex] = rejected;
    return {
      ok: false,
      batch: rejected,
      conflict: { latestVersion: room.queueVersion, issues },
    };
  }

  // 幂等续做：跳过已确认操作；遇注入失败点保留未完成项
  let confirmedUpTo = batch.confirmedUpTo;
  const deliveredKeys = [...batch.deliveredKeys];
  const handedOffChannelIds = [...batch.handedOffChannelIds];
  for (let i = confirmedUpTo; i < batch.ops.length; i++) {
    if (options.failBeforeIndex !== undefined && i >= options.failBeforeIndex) break;
    const op = batch.ops[i];
    if (op.kind === 'interject') deliveredKeys.push(interjectKey(op));
    if (op.kind === 'handoff') handedOffChannelIds.push(op.channelId);
    confirmedUpTo = i + 1;
  }
  const downstreamFailed = confirmedUpTo < batch.ops.length;

  if (downstreamFailed) {
    // 确认失败：保留未完成项，等待重试，不做任何队列替换
    const confirming: QueueBatch = {
      ...batch,
      status: 'confirming',
      confirmedUpTo,
      deliveredKeys,
      handedOffChannelIds,
      updatedAt: nowIso,
    };
    draft.batches[batchIndex] = confirming;
    return { ok: false, batch: confirming };
  }

  // 全部确认：原子替换当前队列 + 交接频道，版次 +1
  applyOpsAtomically(draft, batch, nowIso, handedOffChannelIds);

  const applied: QueueBatch = {
    ...batch,
    status: 'applied',
    confirmedUpTo: batch.ops.length,
    deliveredKeys,
    handedOffChannelIds,
    failures: [],
    conflict: undefined,
    updatedAt: nowIso,
    appliedAt: nowIso,
  };
  draft.batches[batchIndex] = applied;
  draft.audits.unshift({
    id: crypto.randomUUID(),
    at: nowIso,
    roomId: batch.roomId,
    message: `批次 ${applied.id.slice(-6)} 已生效（${batch.ops.length} 项调整，版次 v${batch.baseVersion} → v${batch.baseVersion + 1}）`,
  });
  return { ok: true, batch: applied };
}

/** 重试：只续做没处理的发言，不重复排队或交接 */
export function retryBatch(state: ConferenceState, batchId: string): CommitResult {
  const batch = state.batches.find((item) => item.id === batchId);
  if (!batch) throw new Error(`批次不存在：${batchId}`);
  if (batch.status !== 'confirming' && batch.status !== 'conflict') {
    return { ok: false, batch };
  }
  if (batch.status === 'conflict') {
    // 晚提交冲突不允许盲目重试，需要以最新版次重建批次
    return { ok: false, batch };
  }
  // 从 confirmedUpTo 继续：已排队插话、已交接频道通过 delivered/handoff 记录去重
  return commitBatch(state, batchId);
}

function applyOpsAtomically(
  draft: ConferenceState,
  batch: QueueBatch,
  nowIso: string,
  handedOffChannelIds: string[],
): void {
  const roomId = batch.roomId;
  const queue = draft.speechQueue
    .filter((item) => item.roomId === roomId)
    .sort(compareQueueOrder);
  const others = draft.speechQueue.filter((item) => item.roomId !== roomId);

  const speaking = queue.filter((item) => item.status === 'speaking');
  const finished = queue.filter((item) => item.status === 'done' || item.status === 'skipped');

  // 在同一工作列表上按批次顺序依次应用：先插入的插话会参与后续重排，位次实时钳制
  let working = queue.filter((item) => item.status === 'queued');
  for (const op of batch.ops) {
    if (op.kind === 'interject') {
      const speech: Speech = {
        id: `speech-${crypto.randomUUID()}`,
        roomId,
        speaker: op.draft.speaker,
        delegation: op.draft.delegation,
        language: op.draft.language,
        topic: op.draft.topic,
        plannedSeconds: op.draft.plannedSeconds,
        remainingSeconds: op.draft.plannedSeconds,
        status: 'queued',
        updatedAt: nowIso,
        batchId: batch.id,
      };
      const index = op.atIndex === -1 ? working.length : Math.min(op.atIndex, working.length);
      working.splice(index, 0, speech);
      draft.audits.unshift({
        id: crypto.randomUUID(),
        at: nowIso,
        roomId,
        message: `临时插话 ${speech.speaker} 已排队（批次 ${batch.id.slice(-6)}）`,
      });
    } else if (op.kind === 'reorder') {
      const from = working.findIndex((item) => item.id === op.speechId);
      if (from < 0) continue;
      const [moved] = working.splice(from, 1);
      moved.updatedAt = nowIso;
      working.splice(Math.min(op.toIndex, working.length), 0, moved);
    }
  }
  const queued = working;

  // 译员交接：原子更新频道；重试时 handedOffChannelIds 保证不重复交接
  for (const op of batch.ops) {
    if (op.kind !== 'handoff') continue;
    if (!handedOffChannelIds.includes(op.channelId)) continue;
    const channel = draft.channels.find((item) => item.id === op.channelId);
    if (!channel) continue;
    draft.channels = draft.channels.map((item) =>
      item.id === op.channelId
        ? { ...item, interpreter: op.nextInterpreter, status: 'active' as const, health: Math.min(100, item.health + 2) }
        : item,
    );
    draft.audits.unshift({
      id: crypto.randomUUID(),
      at: nowIso,
      roomId,
      message: `${op.nextInterpreter} 接续 ${channel.language} 频道（批次 ${batch.id.slice(-6)}）`,
    });
  }

  draft.speechQueue = [...others, ...speaking, ...queued, ...finished];
  draft.rooms = draft.rooms.map((room) =>
    room.id === roomId ? { ...room, queueVersion: room.queueVersion + 1 } : room,
  );
}

// ---------- 字幕：未提交改绑新发言人，已播出保持原归属 ----------

export function rebindCaptionDraft(draft: CaptionDraft, state: ConferenceState): CaptionDraft {
  const current = state.speechQueue.find(
    (item) => item.roomId === draft.roomId && item.status === 'speaking',
  );
  const channel = state.channels.find(
    (item) => item.roomId === draft.roomId && item.language === draft.language,
  );
  const next: CaptionDraft = {
    ...draft,
    boundSpeechId: current?.id ?? null,
    boundInterpreter: channel?.interpreter ?? null,
    updatedAt: new Date().toISOString(),
  };
  if (draft.boundSpeechId && current && draft.boundSpeechId !== current.id) {
    next.notice = `原发言人已离场，未提交字幕已改绑 ${current.speaker}`;
  } else if (draft.boundInterpreter && channel && draft.boundInterpreter !== channel.interpreter) {
    next.notice = `频道已交接，未提交字幕将归属 ${channel.interpreter}`;
  } else {
    next.notice = null;
  }
  return next;
}

/** 播出字幕：归属定格为播出时的发言人/译员，后续状态变化不回改 */
export function publishCaption(
  state: ConferenceState,
  draft: CaptionDraft,
  nowIso = new Date().toISOString(),
): Caption | null {
  const speech = state.speechQueue.find((item) => item.id === draft.boundSpeechId);
  if (!speech || speech.status !== 'speaking' || speech.roomId !== draft.roomId) return null;
  const channel = state.channels.find(
    (item) => item.roomId === draft.roomId && item.language === draft.language,
  );
  if (!channel || !draft.text.trim()) return null;

  const interpreter = channel.interpreter;
  const existing = state.captions.find(
    (item) => item.speechId === speech.id && item.language === channel.language,
  );
  let caption: Caption;
  if (existing) {
    caption = { ...existing, text: draft.text, revision: existing.revision + 1, interpreter, at: nowIso };
    state.captions = state.captions.map((item) => (item.id === existing.id ? caption : item));
  } else {
    caption = {
      id: `caption-${crypto.randomUUID()}`,
      speechId: speech.id,
      roomId: draft.roomId,
      language: channel.language,
      interpreter,
      text: draft.text,
      revision: 1,
      at: nowIso,
    };
    state.captions.unshift(caption);
  }
  return caption;
}

// ---------- 内部工具 ----------

function failBatch(
  batch: QueueBatch,
  status: QueueBatch['status'],
  nowIso: string,
  issues: ValidationIssue[],
  reason: string,
): QueueBatch {
  return {
    ...batch,
    status,
    failures: mergeFailures(
      batch.failures,
      issues.length ? issues : batch.ops.map((op) => ({ opId: op.opId, reason })),
    ),
    updatedAt: nowIso,
  };
}

function mergeFailures(
  prev: QueueBatch['failures'],
  issues: ValidationIssue[],
): QueueBatch['failures'] {
  const byOp = new Map<string, { opId: string; reason: string }>();
  for (const failure of prev) byOp.set(failure.opId, failure);
  for (const issue of issues) {
    if (issue.reason) byOp.set(issue.opId, { opId: issue.opId, reason: issue.reason });
  }
  return [...byOp.values()];
}
