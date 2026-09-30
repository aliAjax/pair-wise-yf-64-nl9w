// 状态变更动作：页面入口调用的命令式操作。
// 规则仍在 queue.ts；这里只做“改状态 + 记审计 + 失效旧批次”的编排。

import {
  invalidateStaleBatches,
  rebindCaptionDraft,
  roomFingerprint,
} from './queue';
import type {
  CaptionDraft,
  ConferenceState,
  InterpreterStatus,
  SpeechStatus,
} from './types';

const iso = () => new Date().toISOString();
const audit = (state: ConferenceState, roomId: string, message: string) => {
  state.audits.unshift({ id: `audit-${crypto.randomUUID()}`, at: iso(), roomId, message });
};

/** 任何改动后调用：厅 / 议题 / 频道状态变化会让待生效批次立即失效 */
function refreshBatchValidity(state: ConferenceState, roomId: string): void {
  state.batches = invalidateStaleBatches(state.batches, state, roomId);
}

/** 会议厅上下文变化（改名 / 改议题）：旧批次立即失效 */
export function updateRoomContext(
  state: ConferenceState,
  roomId: string,
  patch: { name?: string; topic?: string },
): void {
  state.rooms = state.rooms.map((room) => (room.id === roomId ? { ...room, ...patch } : room));
  refreshBatchValidity(state, roomId);
  audit(state, roomId, `会议厅上下文更新（${[patch.name, patch.topic].filter(Boolean).join(' / ')}），待生效批次已重新校验`);
}

export function selectRoom(state: ConferenceState, roomId: string): void {
  state.activeRoomId = roomId;
  audit(state, roomId, `切换到 ${state.rooms.find((room) => room.id === roomId)?.name ?? roomId}`);
}

export function advanceSpeech(
  state: ConferenceState,
  speechId: string,
  status: SpeechStatus,
): void {
  const target = state.speechQueue.find((item) => item.id === speechId);
  if (!target) return;
  state.speechQueue = state.speechQueue.map((item) =>
    item.id === speechId ? { ...item, status, updatedAt: iso() } : item,
  );
  if (status === 'speaking') {
    // 同一厅同时只能有一名发言中：其他人置为 done
    state.speechQueue = state.speechQueue.map((item) =>
      item.id !== speechId && item.roomId === target.roomId && item.status === 'speaking'
        ? { ...item, status: 'done', updatedAt: iso() }
        : item,
    );
  }
  audit(state, target.roomId, `${target.speaker} 状态更新为 ${status}`);
  refreshBatchValidity(state, target.roomId);
}

export function adjustRemaining(state: ConferenceState, speechId: string, deltaSeconds: number): void {
  const target = state.speechQueue.find((item) => item.id === speechId);
  if (!target) return;
  state.speechQueue = state.speechQueue.map((item) =>
    item.id === speechId
      ? { ...item, remainingSeconds: Math.max(0, item.remainingSeconds + deltaSeconds), updatedAt: iso() }
      : item,
  );
}

/** 频道状态变化（开始交接 / 改状态）：旧批次立即失效 */
export function setChannelStatus(
  state: ConferenceState,
  channelId: string,
  status: InterpreterStatus,
): void {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return;
  state.channels = state.channels.map((item) =>
    item.id === channelId ? { ...item, status } : item,
  );
  audit(state, channel.roomId, `${channel.language} 频道状态变为 ${status}，原译文归属已冻结`);
  refreshBatchValidity(state, channel.roomId);
}

export function approveTerm(state: ConferenceState, termId: string): void {
  const term = state.terms.find((item) => item.id === termId);
  state.terms = state.terms.map((item) => (item.id === termId ? { ...item, approved: true } : item));
  if (term) audit(state, state.activeRoomId, `术语已批准：${term.phrase}`);
}

// ---------- 字幕草稿：未提交随发言人/频道改绑 ----------

export function touchCaptionDraft(state: ConferenceState, draft: CaptionDraft): CaptionDraft {
  return rebindCaptionDraft(draft, state);
}

/** 外部/其他页签改动后：刷新厅版次，让拿着旧版本的批次在提交时撞到冲突 */
export function bumpQueueVersionExternally(state: ConferenceState, roomId: string, message: string): void {
  state.rooms = state.rooms.map((room) =>
    room.id === roomId ? { ...room, queueVersion: room.queueVersion + 1 } : room,
  );
  refreshBatchValidity(state, roomId);
  audit(state, roomId, message);
}

export function currentFingerprint(state: ConferenceState, roomId: string): string {
  const room = state.rooms.find((item) => item.id === roomId);
  return room ? roomFingerprint(room, state.channels) : '';
}

/** 当前发言中代表；未提交字幕以此为绑定/改绑目标 */
export function currentSpeaking(state: ConferenceState, roomId: string) {
  return state.speechQueue.find(
    (item) => item.roomId === roomId && item.status === 'speaking',
  );
}
