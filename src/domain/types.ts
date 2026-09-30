// 领域模型：会议厅 / 发言队列 / 同传频道 / 字幕 / 待生效批次
// 规则模块与持久化模块共用，不依赖 Qwik。

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type InterpreterStatus = 'active' | 'handoff' | 'standby';

export interface Room {
  id: string;
  name: string;
  topic: string;
  simultaneousChannels: number;
  /** 队列当前版次，每次原子替换 +1，乐观锁依据 */
  queueVersion: number;
}

export interface Speech {
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
  /** 生效时所属批次；迁移数据归属基准批 */
  batchId: string;
}

export interface Channel {
  id: string;
  roomId: string;
  language: string;
  interpreter: string;
  status: InterpreterStatus;
  health: number;
}

export interface Term {
  id: string;
  phrase: string;
  translation: string;
  language: string;
  approved: boolean;
}

export interface Caption {
  id: string;
  speechId: string;
  roomId: string;
  language: string;
  /** 播出时归属，之后不再改写 */
  interpreter: string;
  text: string;
  revision: number;
  at: string;
}

export interface Audit {
  id: string;
  at: string;
  roomId: string;
  message: string;
}

// ---- 待生效批次 ----

/** 发言顺序调整：仅在 queued 项之间重排 */
export interface ReorderOp {
  kind: 'reorder';
  opId: string;
  speechId: string;
  /** 目标位次（0 基，作用于当时的 queued 列表） */
  toIndex: number;
}

/** 临时插话：创建一条新的 queued 发言并插入指定位次 */
export interface InterjectOp {
  kind: 'interject';
  opId: string;
  draft: {
    speaker: string;
    delegation: string;
    language: string;
    topic: string;
    plannedSeconds: number;
  };
  /** 插入位次（0 基），-1 表示队尾 */
  atIndex: number;
}

/** 译员交接：把交接中频道的译员原子替换 */
export interface HandoffOp {
  kind: 'handoff';
  opId: string;
  channelId: string;
  nextInterpreter: string;
}

export type QueueOp = ReorderOp | InterjectOp | HandoffOp;

export type BatchStatus =
  | 'pending' // 待校验/待生效
  | 'confirming' // 确认进行中，部分操作已完成
  | 'applied' // 已原子生效
  | 'conflict' // 来源版本被改，仅返回冲突项与最新版次
  | 'invalidated'; // 会议厅/议题/频道状态变化，旧批次立即失效

export interface QueueBatch {
  id: string;
  roomId: string;
  /** 批次创建时的队列版次（来源版本） */
  baseVersion: number;
  /** 批次创建时的会议厅上下文指纹（名称/议题/频道状态） */
  contextFingerprint: string;
  ops: QueueOp[];
  status: BatchStatus;
  /** 已通过下游确认的操作数；重试只续做其后的操作 */
  confirmedUpTo: number;
  /** 已排过队的插话发言人，防止重试重复排队 */
  deliveredKeys: string[];
  /** 已交接过的频道，防止重试重复交接 */
  handedOffChannelIds: string[];
  /** 提交失败 / 校验失败原因，按操作保留 */
  failures: { opId: string; reason: string }[];
  conflict?: {
    latestVersion: number;
    conflictingOpIds: string[];
    reasons: string[];
  };
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export interface ConferenceState {
  schemaVersion: 2;
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  batches: QueueBatch[];
  lowLatency: boolean;
}

export interface CaptionDraft {
  roomId: string;
  language: string;
  text: string;
  /** 起草时绑定的发言；未提交时跟随当前发言中代表改绑 */
  boundSpeechId: string | null;
  boundInterpreter: string | null;
  notice: string | null;
  updatedAt: string;
}
