import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { QueryClient } from '@tanstack/query-core';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';

import type {
  CaptionDraft,
  ConferenceState,
  QueueOp,
  Room,
  Speech,
} from '../domain/types';
import { loadState, saveState } from '../domain/persistence';
import {
  commitBatch,
  createBatch,
  publishCaption,
  roomQueueOrdered,
} from '../domain/queue';
import {
  adjustRemaining,
  advanceSpeech,
  approveTerm,
  bumpQueueVersionExternally,
  currentSpeaking,
  selectRoom,
  setChannelStatus,
  touchCaptionDraft,
  updateRoomContext,
} from '../domain/state';

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600),
});
type QueueForm = z.infer<typeof queueSchema>;

const STATUS_LABEL: Record<Speech['status'], string> = {
  queued: '排队中',
  speaking: '发言中',
  done: '已完成',
  skipped: '已跳过',
};

const CHANNEL_STATUS_LABEL: Record<string, string> = {
  active: '在岗',
  handoff: '交接中',
  standby: '备班',
};

const queryClient = new QueryClient();

function initialCaptionDraft(state: ConferenceState): CaptionDraft {
  const speech = currentSpeaking(state, state.activeRoomId);
  const channel = state.channels.find(
    (item) => item.roomId === state.activeRoomId && item.language === '中文',
  );
  return {
    roomId: state.activeRoomId,
    language: '中文',
    text: '',
    boundSpeechId: speech?.id ?? null,
    boundInterpreter: channel?.interpreter ?? null,
    notice: null,
    updatedAt: new Date().toISOString(),
  };
}

function activeRoomOf(state: ConferenceState, roomId: string): Room {
  return state.rooms.find((room) => room.id === roomId) ?? state.rooms[0];
}

function channelsOf(state: ConferenceState, roomId: string) {
  return state.channels.filter((item) => item.roomId === roomId);
}

function queuedOf(state: ConferenceState, roomId: string): Speech[] {
  return roomQueueOrdered(state, roomId).filter((item) => item.status === 'queued');
}

/** 当前厅最近一个仍可操作的批次（待生效 / 确认中 / 冲突 / 失效） */
function activeBatchOf(state: ConferenceState, roomId: string) {
  const actionable = new Set(['pending', 'confirming', 'conflict', 'invalidated']);
  return [...state.batches].reverse().find((b) => b.roomId === roomId && actionable.has(b.status));
}

function describeOp(state: ConferenceState, op: QueueOp): string {
  if (op.kind === 'reorder') {
    const speech = state.speechQueue.find((item) => item.id === op.speechId);
    return `顺序：${speech?.speaker ?? '已离场发言人'} → 第 ${op.toIndex + 1} 位`;
  }
  if (op.kind === 'interject') {
    return `插话：${op.draft.speaker}（${op.draft.delegation} · ${op.draft.topic}）${op.atIndex === -1 ? ' 队尾' : ` 插入第 ${op.atIndex + 1} 位`}`;
  }
  const channel = state.channels.find((item) => item.id === op.channelId);
  return `交接：${channel?.language ?? op.channelId} 频道 → ${op.nextInterpreter}`;
}

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(
    loadState(new Date().toISOString(), new Date(Date.now() - 90000).toISOString()),
    { deep: true },
  );

  // 批次暂存区：顺序调整 / 临时插话 / 译员交接先攒在一起校验
  const staging = useStore<{ ops: QueueOp[]; reorderTarget: number; nextInterpreter: string }>({
    ops: [],
    reorderTarget: 1,
    nextInterpreter: '',
  });
  const commitMessage = useSignal<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const captionDraft = useSignal<CaptionDraft>(initialCaptionDraft(state));
  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema),
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema),
  });
  const topicDraft = useSignal('');

  useVisibleTask$(({ track }) => {
    track(() => state);
    saveState(state);
  });

  // 监听厅/发言人/频道变化：未提交字幕改绑新发言人；切厅后重建草稿
  useVisibleTask$(({ track }) => {
    track(() => state.speechQueue.map((s) => `${s.id}:${s.status}`).join(','));
    track(() => state.channels.map((c) => `${c.id}:${c.interpreter}:${c.status}`).join(','));
    track(() => state.activeRoomId);
    if (captionDraft.value.roomId !== state.activeRoomId) {
      captionDraft.value = initialCaptionDraft(state);
      topicDraft.value = activeRoomOf(state, state.activeRoomId).topic;
    } else {
      captionDraft.value = touchCaptionDraft(state, captionDraft.value);
    }
  });

  const activeRoom = () => activeRoomOf(state, state.activeRoomId);
  const roomQueue = (): Speech[] => roomQueueOrdered(state, state.activeRoomId);
  const roomChannels = () => channelsOf(state, state.activeRoomId);
  const queuedSpeeches = () => queuedOf(state, state.activeRoomId);
  const currentSpeech = () => currentSpeaking(state, state.activeRoomId);
  const activeBatch = () => activeBatchOf(state, state.activeRoomId);

  const selectRoom$ = $((roomId: string) => {
    selectRoom(state, roomId);
    topicDraft.value = state.rooms.find((room) => room.id === roomId)?.topic ?? '';
  });

  // 直接加入队尾：自身也推进版次，待生效批次会据此冲突
  const addSpeechTail$ = $((values: QueueForm) => {
    state.speechQueue.push({
      id: `speech-${crypto.randomUUID()}`,
      roomId: state.activeRoomId,
      ...values,
      remainingSeconds: values.plannedSeconds,
      status: 'queued',
      updatedAt: new Date().toISOString(),
      batchId: 'direct',
    });
    bumpQueueVersionExternally(state, state.activeRoomId, `${values.speaker} 直接加入队尾，队列版次已推进`);
    queueLoader.value = { speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 };
  });

  // ---- 批次暂存 ----

  const stageReorder$ = $((speechId: string) => {
    const queued = queuedOf(state, state.activeRoomId);
    const target = Math.min(Math.max(staging.reorderTarget, 1), queued.length) - 1;
    staging.ops.push({ kind: 'reorder', opId: `op-${crypto.randomUUID()}`, speechId, toIndex: target });
    commitMessage.value = null;
  });

  const stageInterject$ = $((values: QueueForm) => {
    const queued = queuedOf(state, state.activeRoomId);
    staging.ops.push({
      kind: 'interject',
      opId: `op-${crypto.randomUUID()}`,
      draft: { ...values },
      atIndex: Math.min(queued.length, queued.length), // 默认插到队尾，可在列表中前移
    });
    queueLoader.value = { speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 };
    commitMessage.value = null;
  });

  const stageHandoff$ = $((channelId: string) => {
    const language = channelsOf(state, state.activeRoomId).find((c) => c.id === channelId)?.language ?? '';
    staging.ops.push({
      kind: 'handoff',
      opId: `op-${crypto.randomUUID()}`,
      channelId,
      nextInterpreter: staging.nextInterpreter.trim() || `替补译员-${language}`,
    });
    staging.nextInterpreter = '';
    commitMessage.value = null;
  });

  const moveStaged$ = $((index: number, delta: number) => {
    const ops = staging.ops;
    const target = index + delta;
    if (target < 0 || target >= ops.length) return;
    const [item] = ops.splice(index, 1);
    ops.splice(target, 0, item);
  });

  const unstage$ = $((opId: string) => {
    staging.ops = staging.ops.filter((op) => op.opId !== opId);
  });

  const createBatch$ = $(() => {
    if (staging.ops.length === 0) {
      commitMessage.value = { tone: 'warn', text: '请先把顺序调整、临时插话或译员交接加入待生效批次。' };
      return;
    }
    const batch = createBatch(state, state.activeRoomId, staging.ops);
    state.batches.push(batch);
    staging.ops = [];
    commitMessage.value = {
      tone: 'warn',
      text: `批次 ${batch.id.slice(-6)} 已创建，来源版次 v${batch.baseVersion}，共 ${batch.ops.length} 项，等待提交。`,
    };
  });

  /**
   * 提交批次。simulate 参数：
   * - ok：正常提交，原子替换；
   * - fail-after-first：模拟下游确认在第 2 项前失败，保留未完成项；
   * - late-tab：模拟其他页签先提交，本批次来源版本变旧，只回冲突项与最新版次。
   */
  const submitBatch$ = $((simulate: 'ok' | 'fail-after-first' | 'late-tab') => {
    const batch = activeBatchOf(state, state.activeRoomId);
    if (!batch) return;
    if (simulate === 'late-tab') {
      // 其他页签晚提交：先让外部提交生效，推进版次
      bumpQueueVersionExternally(state, batch.roomId, '其他页签已先提交一版队列调整，版次推进');
    }
    const result = commitBatch(state, batch.id, {
      failBeforeIndex: simulate === 'fail-after-first' ? 1 : undefined,
    });
    if (result.ok) {
      commitMessage.value = {
        tone: 'ok',
        text: `批次已原子生效：队列已替换、译员交接完成，版次 v${result.batch.baseVersion} → v${result.batch.baseVersion + 1}。`,
      };
    } else if (result.batch.status === 'conflict' && result.conflict) {
      const detail = result.conflict.issues.length
        ? result.conflict.issues.map((issue) => `· ${issue.reason}`).join(' ')
        : '· 队列已被其他页签改动';
      commitMessage.value = {
        tone: 'error',
        text: `提交被拒（来源版本过期）：最新版次 v${result.conflict.latestVersion}，冲突项 ${result.conflict.issues.length} 条：${detail}。请刷新后基于最新队列重建批次。`,
      };
    } else if (result.batch.status === 'invalidated') {
      commitMessage.value = {
        tone: 'error',
        text: '会议厅、议题或频道状态已变化，该旧批次立即失效，未提交内容请基于当前状态重新整理。',
      };
    } else if (result.batch.status === 'confirming') {
      const remaining = result.batch.ops.length - result.batch.confirmedUpTo;
      commitMessage.value = {
        tone: 'warn',
        text: `下游确认失败：前 ${result.batch.confirmedUpTo} 项已确认，保留 ${remaining} 个未完成项。重试只会续做未处理的发言，不会重复排队或交接。`,
      };
    }
  });

  const retryBatch$ = $(() => {
    const batch = activeBatchOf(state, state.activeRoomId);
    if (!batch) return;
    const result = commitBatch(state, batch.id);
    if (result.ok) {
      commitMessage.value = {
        tone: 'ok',
        text: `重试成功：未完成项已续做完毕，批次原子生效，版次推进至 v${result.batch.baseVersion + 1}。`,
      };
    } else if (result.batch.status === 'conflict' && result.conflict) {
      commitMessage.value = {
        tone: 'error',
        text: `重试时发现版本已被改动：最新版次 v${result.conflict.latestVersion}，请重建批次。`,
      };
    }
  });

  const discardBatch$ = $(() => {
    const batch = activeBatchOf(state, state.activeRoomId);
    if (!batch) return;
    state.batches = state.batches.filter((item) => item.id !== batch.id);
    commitMessage.value = null;
  });

  const saveTopic$ = $(() => {
    updateRoomContext(state, state.activeRoomId, { topic: topicDraft.value.trim() || activeRoomOf(state, state.activeRoomId).topic });
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    captionDraft.value.text = values.text;
    captionDraft.value = touchCaptionDraft(state, captionDraft.value);
    const ok = await queryClient.fetchQuery({
      queryKey: ['caption-publish', captionDraft.value.boundSpeechId, values.text],
      queryFn: async () => values.text === values.text.trim() || values.text.trim().length > 0,
      staleTime: 0,
    });
    if (!ok) return;
    const caption = publishCaption(state, captionDraft.value);
    if (caption) {
      captionDraft.value = { ...captionDraft.value, text: '', notice: null, updatedAt: new Date().toISOString() };
      captionLoader.value = { text: '' };
    } else {
      captionDraft.value = {
        ...captionDraft.value,
        notice: '绑定的发言人已离场且当前无人发言，字幕未播出；待新发言人开始后自动改绑。',
      };
    }
  });

  const batch = activeBatch();
  const handoffChannels = roomChannels().filter((channel) => channel.status === 'handoff');

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div>
          <span class="pill">{locale.lang}</span>
          <h1>同声传译与发言队列</h1>
          <p>{activeRoom().name} · {activeRoom().topic}</p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>
            {state.rooms.map((room) => <option value={room.id} key={room.id}>{room.name}</option>)}
          </select>
          <button class="secondary" onClick$={() => (state.lowLatency = !state.lowLatency)}>
            {state.lowLatency ? '退出低延迟' : '低延迟模式'}
          </button>
        </div>
      </header>

      <section class="grid">
        {/* 发言队列 */}
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <h2>发言队列</h2>
            <span class="pill">
              当前版次 v{activeRoom().queueVersion} · {roomQueue().length} 条 · {activeRoom().simultaneousChannels} 频道
            </span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin:8px 0 12px">
            <input value={topicDraft.value} onInput$={(e) => (topicDraft.value = (e.target as HTMLInputElement).value)} placeholder="修改本厅议题" />
            <button class="secondary" onClick$={saveTopic$}>保存议题</button>
          </div>
          <p class="hint">议题/频道状态变化会让待生效批次立即失效；直接开始、结束发言也会推进版次。</p>

          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div style="color:#638087;font-size:13px">
                  {speech.delegation} · {speech.language} · {speech.topic}
                  <span class="pill" style="margin-left:6px">{speech.batchId === 'batch-baseline' ? '基准批' : speech.batchId === 'direct' ? '直接入队' : `批次 ${speech.batchId.slice(-6)}`}</span>
                </div>
              </div>
              <span class="pill">{STATUS_LABEL[speech.status]}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech(state, speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && (
                  <>
                    <button onClick$={() => advanceSpeech(state, speech.id, 'done')}>结束</button>
                    <button class="secondary" onClick$={() => adjustRemaining(state, speech.id, -60)}>减1分钟</button>
                  </>
                )}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech(state, speech.id, 'skipped')}>跳过</button>}
                {speech.status === 'queued' && (
                  <>
                    <input
                      class="pos-input"
                      type="number"
                      min={1}
                      max={Math.max(1, queuedSpeeches().length)}
                      value={staging.reorderTarget}
                      onInput$={(e) => (staging.reorderTarget = Number((e.target as HTMLInputElement).value))}
                      title="目标位次"
                    />
                    <button class="secondary" onClick$={() => stageReorder$(speech.id)}>加入重排</button>
                  </>
                )}
              </div>
            </div>
          ))}

          <h3 style="margin-top:18px">直接加入队尾（立即生效，会推进版次）</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
            <QueueForm onSubmit$={addSpeechTail$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => (field.value = Number((event.target as HTMLInputElement).value))} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          {/* 待生效批次工作台 */}
          <h2>待生效批次</h2>
          <p class="hint">顺序调整、临时插话、译员交接先一起校验，来源版本没变才原子替换当前队列。</p>

          <div class="batch-box">
            <h3>临时插话（入批次）</h3>
            <QueueForm onSubmit$={stageInterject$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="插话发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="插话议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => (field.value = Number((event.target as HTMLInputElement).value))} placeholder="计划秒数" />}</QueueField>
              <button type="submit" class="secondary">加入批次（队尾）</button>
            </QueueForm>

            <h3 style="margin-top:12px">译员交接（入批次）</h3>
            {handoffChannels.length === 0 && <p class="hint">当前没有“交接中”的频道。先在下方频道列表启动交接。</p>}
            {handoffChannels.map((channel) => (
              <div class="handoff-row" key={channel.id}>
                <span>{channel.language} · 当前 {channel.interpreter}</span>
                <input
                  value={staging.nextInterpreter}
                  onInput$={(e) => (staging.nextInterpreter = (e.target as HTMLInputElement).value)}
                  placeholder={`接替译员（默认 替补译员-${channel.language}）`}
                />
                <button class="secondary" onClick$={() => stageHandoff$(channel.id)}>加入交接</button>
              </div>
            ))}
          </div>

          <h3 style="margin-top:14px">暂存调整（{staging.ops.length}）</h3>
          {staging.ops.map((op, index) => (
            <div class="staged-row" key={op.opId}>
              <span>{describeOp(state, op)}</span>
              <span style="display:flex;gap:4px">
                <button class="secondary" disabled={index === 0} onClick$={() => moveStaged$(index, -1)}>↑</button>
                <button class="secondary" disabled={index === staging.ops.length - 1} onClick$={() => moveStaged$(index, 1)}>↓</button>
                <button class="danger" onClick$={() => unstage$(op.opId)}>移除</button>
              </span>
            </div>
          ))}
          <button style="margin-top:10px" disabled={staging.ops.length === 0} onClick$={createBatch$}>整理成待生效批次</button>

          {batch && (
            <div class={`batch-status status-${batch.status}`} style="margin-top:14px">
              <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">
                <b>批次 {batch.id.slice(-6)}</b>
                <span class="pill">
                  来源 v{batch.baseVersion} · 当前 v{activeRoom().queueVersion} ·{' '}
                  {batch.status === 'pending' && '待提交'}
                  {batch.status === 'confirming' && `确认中（${batch.confirmedUpTo}/${batch.ops.length}）`}
                  {batch.status === 'conflict' && '版本冲突'}
                  {batch.status === 'invalidated' && '已失效'}
                  {batch.status === 'applied' && '已生效'}
                </span>
              </div>
              {batch.ops.map((op, i) => (
                <div class="staged-row" key={op.opId}>
                  <span>{i < batch.confirmedUpTo ? '✅ ' : '⬜ '}{describeOp(state, op)}</span>
                </div>
              ))}
              {(batch.status === 'pending' || batch.status === 'confirming') && (
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
                  <button disabled={batch.status !== 'pending'} onClick$={() => submitBatch$('ok')}>提交并原子生效</button>
                  <button class="secondary" disabled={batch.status !== 'pending' || batch.ops.length < 2} onClick$={() => submitBatch$('fail-after-first')}>
                    模拟确认失败（第2项前中断）
                  </button>
                  <button class="secondary" disabled={batch.status !== 'pending'} onClick$={() => submitBatch$('late-tab')}>
                    模拟其他页签晚提交
                  </button>
                  <button disabled={batch.status !== 'confirming'} onClick$={retryBatch$}>
                    重试未完成项（{Math.max(0, batch.ops.length - batch.confirmedUpTo)}）
                  </button>
                  <button class="danger" onClick$={discardBatch$}>放弃</button>
                </div>
              )}
              {batch.status === 'conflict' && batch.conflict && (
                <div style="margin-top:8px">
                  <p class="hint">
                    最新版次 v{batch.conflict.latestVersion}；冲突项 {batch.conflict.conflictingOpIds.length} 条：
                  </p>
                  <ul style="margin:4px 0;padding-left:18px">
                    {batch.conflict.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                  </ul>
                  <button class="danger" onClick$={discardBatch$}>基于最新版次重建</button>
                </div>
              )}
              {batch.status === 'invalidated' && (
                <div style="margin-top:8px">
                  <p class="hint">会议厅、议题或频道状态变化后旧批次立即失效，未提交字幕会改绑新发言人，已播出字幕保持原归属。</p>
                  <button class="danger" onClick$={discardBatch$}>关闭失效批次</button>
                </div>
              )}
            </div>
          )}

          {commitMessage.value && (
            <p class={`commit-msg msg-${commitMessage.value.tone}`} style="margin-top:12px">
              {commitMessage.value.text}
            </p>
          )}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        {/* 频道与字幕 */}
        <article class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between">
                <b>{channel.language} · {channel.interpreter}</b>
                <span class="pill">{CHANNEL_STATUS_LABEL[channel.status]}</span>
              </div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
              <div style="display:flex;gap:8px">
                {channel.status !== 'handoff' && (
                  <button class="secondary" onClick$={() => setChannelStatus(state, channel.id, 'handoff')}>开始交接</button>
                )}
                {channel.status === 'handoff' && <span class="hint">交接已冻结旧译文归属，请在右侧批次工作台加入“译员交接”后统一生效。</span>}
              </div>
            </div>
          ))}
        </article>

        <article class="panel">
          <h2>实时字幕修正</h2>
          <p class="hint">
            绑定：{currentSpeech() ? `${currentSpeech()!.speaker}（${captionDraft.value.boundInterpreter ?? '无在岗译员'}）` : '当前无发言中代表'}
            {' '}· 已播出字幕的归属不再回改。
          </p>
          {captionDraft.value.notice && <p class="commit-msg msg-warn">{captionDraft.value.notice}</p>}
          <CaptionForm onSubmit$={publishCaption$}>
            <CaptionField name="text">{(field, props) => (
              <textarea
                {...props}
                rows={3}
                value={field.value}
                onInput$={(event) => {
                  field.value = (event.target as HTMLTextAreaElement).value;
                  captionDraft.value = { ...captionDraft.value, text: field.value, updatedAt: new Date().toISOString() };
                }}
                placeholder="输入或修正当前字幕（未提交时自动跟随发言人/译员改绑）"
              />
            )}</CaptionField>
            <button type="submit">播出新版字幕</button>
          </CaptionForm>
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).map((caption) => (
            <div class="caption-box" key={caption.id}>
              <b>{caption.interpreter} · v{caption.revision}（归属已冻结）</b>
              <p>{caption.text}</p>
            </div>
          ))}
        </article>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => (
            <div class="queue-row" key={term.id}>
              <span />
              <div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div>
              <span class="pill">{term.approved ? '已批准' : '待审'}</span>
              <button disabled={term.approved} onClick$={() => approveTerm(state, term.id)}>批准</button>
            </div>
          ))}
        </article>
        <article class="panel">
          <h2>批次与交接时间线</h2>
          {state.batches.filter((b) => b.roomId === state.activeRoomId).slice(-5).reverse().map((b) => (
            <div style="padding:8px 0;border-bottom:1px solid #e6efee" key={b.id}>
              <small>{new Date(b.updatedAt).toLocaleTimeString()}</small>
              <div>
                批次 {b.id.slice(-6)} · v{b.baseVersion} · {b.ops.length} 项 ·{' '}
                {b.status === 'pending' && '待提交'}
                {b.status === 'confirming' && `确认中 ${b.confirmedUpTo}/${b.ops.length}`}
                {b.status === 'conflict' && `冲突（最新 v${b.conflict?.latestVersion}）`}
                {b.status === 'invalidated' && '已失效'}
                {b.status === 'applied' && `已生效（v${b.baseVersion + 1}）`}
              </div>
            </div>
          ))}
          {state.audits.filter((item) => item.roomId === state.activeRoomId).slice(0, 8).map((item) => (
            <div style="padding:8px 0;border-bottom:1px solid #e6efee" key={item.id}>
              <small>{new Date(item.at).toLocaleTimeString()}</small>
              <div>{item.message}</div>
            </div>
          ))}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '待生效批次、版本校验、原子队列替换、译员交接与字幕改绑' }],
};
