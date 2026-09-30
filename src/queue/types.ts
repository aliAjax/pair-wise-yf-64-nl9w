// 队列批次相关类型：发言顺序、临时插话、译员交接以「待生效批次」为单位一起校验、一起生效。

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type InterpreterStatus = 'active' | 'handoff' | 'standby';
export type BatchStatus = 'pending' | 'applied' | 'failed' | 'invalidated';
export type CaptionStatus = 'draft' | 'broadcast';

export type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
export type Speech = {
  id: string;
  roomId: string;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  updatedAt: string;
};
export type Channel = {
  id: string;
  roomId: string;
  language: string;
  interpreter: string;
  status: InterpreterStatus;
  health: number;
};
export type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
export type Caption = {
  id: string;
  speechId: string;
  roomId: string;
  language: string;
  interpreter: string;
  text: string;
  revision: number;
  at: string;
  status: CaptionStatus;
};
export type Audit = { id: string; at: string; roomId: string; message: string };

export type BatchItemKind = 'speech-order' | 'interjection' | 'handoff';

export type InterjectionInput = {
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  /** 插入到该厅队列的第几位（从 0 开始） */
  insertAt: number;
};

export type HandoffInput = {
  channelId: string;
  interpreter: string;
  /** start=启动交接（频道进入 handoff），complete=完成交接（新译员接续） */
  phase: 'start' | 'complete';
};

export type BatchItem = {
  id: string;
  kind: BatchItemKind;
  processed: boolean;
  error?: string;
  // speech-order
  speechId?: string;
  targetStatus?: SpeechStatus;
  // interjection
  interjection?: InterjectionInput;
  // handoff
  handoff?: HandoffInput;
};

export type QueueBatch = {
  id: string;
  /** 批次号，随队列版本递增 */
  batchNumber: number;
  roomId: string;
  /** 提交时来源队列的版本号 */
  sourceVersion: number;
  status: BatchStatus;
  items: BatchItem[];
  createdAt: string;
  appliedAt?: string;
  failureReason?: string;
};

export interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
  /** 当前队列版本号，批次来源版本与之相等才允许原子替换 */
  queueVersion: number;
  /** 待生效 / 已生效 / 失败 / 已失效的批次 */
  batches: QueueBatch[];
}

/** 提交结果：成功返回批次；冲突只返回冲突项与最新版次，不回写整份队列。 */
export type SubmitResult =
  | { ok: true; batch: QueueBatch }
  | { ok: false; conflicts: string[]; latestVersion: number; batch: QueueBatch | null };
