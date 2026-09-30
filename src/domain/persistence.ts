// 持久化层：只管 localStorage 读写与旧版本数据迁移。
// 不包含任何队列规则（见 domain/queue.ts），也不包含页面入口（见 routes）。
// 旧数据没有批次号时：队列版次从基准版次 1 开始，全部存量发言迁移为基准批。

import type { ConferenceState, QueueBatch, Room, Speech } from './types';
import { BASELINE_BATCH_ID, BASELINE_VERSION } from './queue';

export const STORAGE_KEY = 'conference-interpretation-v2';
export const LEGACY_STORAGE_KEY = 'conference-interpretation-v1';
const CURRENT_SCHEMA = 2;

/** 演示用种子数据：入口在无存储时使用 */
export function seedState(nowIso: string, earlierIso: string): ConferenceState {
  return {
    schemaVersion: CURRENT_SCHEMA,
    rooms: [
      { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6, queueVersion: BASELINE_VERSION },
      { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4, queueVersion: BASELINE_VERSION },
    ],
    activeRoomId: 'hall-a',
    speechQueue: [
      { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: nowIso, batchId: BASELINE_BATCH_ID },
      { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: nowIso, batchId: BASELINE_BATCH_ID },
      { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: nowIso, batchId: BASELINE_BATCH_ID },
    ],
    channels: [
      { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
      { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
      { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
      { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 },
    ],
    terms: [
      { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
      { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
      { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false },
    ],
    captions: [
      { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: nowIso },
    ],
    audits: [
      { id: 'audit-1', at: nowIso, roomId: 'hall-a', message: '存量数据迁移为基准批（batch-baseline），队列起始版次 v1' },
      { id: 'audit-2', at: earlierIso, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
    ],
    batches: [],
    lowLatency: false,
  };
}

interface LegacyShape {
  schemaVersion?: number;
  rooms?: { id: string; queueVersion?: number }[];
  speechQueue?: Speech[];
  batches?: QueueBatch[];
}

/** 读取并迁移：v1 无批次号数据 → v2（基准批 + 起始版次） */
export function loadState(nowIso: string, earlierIso: string): ConferenceState {
  if (typeof localStorage === 'undefined') return seedState(nowIso, earlierIso);

  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ConferenceState;
      return normalize(parsed, nowIso);
    } catch {
      // 损坏数据落到迁移流程
    }
  }

  const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as LegacyShape;
      const migrated = migrateLegacy(legacy, nowIso);
      saveState(migrated);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return migrated;
    } catch {
      // 迁移失败不覆盖旧数据
    }
  }
  return seedState(nowIso, earlierIso);
}

export function saveState(state: ConferenceState): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** 旧数据没有批次号时迁移成基准批 */
function migrateLegacy(legacy: LegacyShape, nowIso: string): ConferenceState {
  const seed = seedState(nowIso, nowIso);
  const merged = { ...seed, ...(legacy as Partial<ConferenceState>) } as ConferenceState;
  merged.schemaVersion = CURRENT_SCHEMA;

  // 厅补齐版次：存量厅从基准版次开始
  merged.rooms = ((legacy.rooms ?? merged.rooms) as Room[]).map((room) => ({
    ...room,
    queueVersion: typeof room.queueVersion === 'number' ? room.queueVersion : BASELINE_VERSION,
  }));

  // 存量发言没有批次号 → 归属基准批
  merged.speechQueue = (legacy.speechQueue ?? merged.speechQueue).map((speech) => ({
    ...speech,
    batchId: speech.batchId ?? BASELINE_BATCH_ID,
  }));

  merged.batches = Array.isArray(legacy.batches) ? legacy.batches : [];
  merged.audits = [
    {
      id: `audit-${crypto.randomUUID()}`,
      at: nowIso,
      roomId: merged.activeRoomId,
      message: '旧版数据已迁移：无批次号队列归入基准批，版次从 v1 起算',
    },
    ...(merged.audits ?? []),
  ];
  return normalize(merged, nowIso);
}

/** 防御性补齐：防止半版本数据缺字段 */
function normalize(state: Partial<ConferenceState>, nowIso: string): ConferenceState {
  const base = seedState(nowIso, nowIso);
  const merged = { ...base, ...state } as ConferenceState;
  merged.schemaVersion = CURRENT_SCHEMA;
  merged.rooms = (state.rooms ?? base.rooms).map((room) => ({
    ...room,
    queueVersion: typeof room.queueVersion === 'number' ? room.queueVersion : BASELINE_VERSION,
  }));
  merged.speechQueue = (state.speechQueue ?? base.speechQueue).map((speech) => ({
    ...speech,
    batchId: speech.batchId ?? BASELINE_BATCH_ID,
  }));
  merged.batches = state.batches ?? [];
  merged.captions = state.captions ?? [];
  merged.audits = state.audits ?? [];
  return merged;
}
