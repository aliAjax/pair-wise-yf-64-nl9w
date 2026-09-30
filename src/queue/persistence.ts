// 持久化层：localStorage 读写与旧数据迁移。与队列规则、页面入口分开维护。

import type { ConferenceState } from './types';
import { ensureBaseline } from './rules';

export const STORAGE_KEY = 'conference-interpretation-v2';
const LEGACY_KEY = 'conference-interpretation-v1';

export function loadState(seed: ConferenceState): ConferenceState {
  if (typeof localStorage === 'undefined') return ensureBaseline(structuredClone(seed));
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return ensureBaseline(structuredClone(seed));
    const parsed = JSON.parse(raw) as Partial<ConferenceState>;
    const merged: ConferenceState = {
      ...seed,
      ...parsed,
      rooms: parsed.rooms ?? seed.rooms,
      speechQueue: parsed.speechQueue ?? seed.speechQueue,
      channels: parsed.channels ?? seed.channels,
      captions: parsed.captions ?? seed.captions,
      audits: parsed.audits ?? seed.audits,
      batches: parsed.batches ?? seed.batches
    };
    return ensureBaseline(merged);
  } catch {
    return ensureBaseline(structuredClone(seed));
  }
}

export function saveState(state: ConferenceState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储写满或不可用时静默失败，不影响当前会话
  }
}
