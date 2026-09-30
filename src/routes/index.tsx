import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import type { BatchItem, ConferenceState, QueueBatch, SpeechStatus } from '../queue/types';
import {
  appendToBatch,
  createBatch,
  discardBatch,
  invalidateBatchesForRoom,
  publishCaption,
  retryBatch,
  submitBatch
} from '../queue/rules';
import { loadState, saveState } from '../queue/persistence';

const now = new Date().toISOString();
const seed: ConferenceState = {
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now, status: 'broadcast' }
  ],
  audits: [
    { id: 'audit-1', at: now, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
  ],
  lowLatency: false,
  queueVersion: 1,
  batches: []
};

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;
const interjectionSchema = queueSchema.extend({ insertAt: z.coerce.number().min(0) });
type InterjectionForm = z.infer<typeof interjectionSchema>;

const statusLabel: Record<SpeechStatus, string> = {
  queued: '排队中',
  speaking: '发言中',
  done: '已结束',
  skipped: '已跳过'
};

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(loadState(seed));
  const lastConflicts = useSignal<{ batchId: string; items: string[] } | null>(null);

  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });
  const interjectionLoader = useSignal<InterjectionForm>({ speaker: '', delegation: '', language: '中文', topic: '', plannedSeconds: 180, insertAt: 0 });
  const [interjectionForm, { Form: InterjectionForm, Field: InterjectionField }] = useForm<InterjectionForm>({
    loader: interjectionLoader,
    validate: zodForm$(interjectionSchema)
  });

  useVisibleTask$(({ track }) => {
    track(() => state);
    saveState(state);
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const pendingBatch = () => state.batches.find((b) => b.roomId === state.activeRoomId && b.status === 'pending');
  const roomBatches = () => state.batches.filter((b) => b.roomId === state.activeRoomId).slice(0, 8);

  const pushToBatch$ = $((item: Omit<BatchItem, 'id' | 'processed'>) => {
    appendToBatch(state, state.activeRoomId, item);
  });

  const selectRoom$ = $((roomId: string) => {
    if (roomId === state.activeRoomId) return;
    // 会议厅状态变化：旧批次立即失效
    invalidateBatchesForRoom(state, state.activeRoomId, '切换会议厅导致队列上下文变化');
    state.activeRoomId = roomId;
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message: `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}` });
  });

  const changeTopic$ = $((topic: string) => {
    const room = state.rooms.find((r) => r.id === state.activeRoomId);
    if (!room || room.topic === topic) return;
    // 议题变化：旧批次立即失效
    invalidateBatchesForRoom(state, state.activeRoomId, `议题变更为「${topic}」`);
    state.rooms = state.rooms.map((r) => r.id === state.activeRoomId ? { ...r, topic } : r);
  });

  const advanceSpeech$ = $((id: string, status: SpeechStatus) => {
    pushToBatch$({ kind: 'speech-order', speechId: id, targetStatus: status });
  });

  const addSpeech$ = $((values: QueueForm) => {
    pushToBatch$({
      kind: 'interjection',
      interjection: { ...values, insertAt: roomQueue().length }
    });
  });

  const addInterjection$ = $((values: InterjectionForm) => {
    pushToBatch$({
      kind: 'interjection',
      interjection: { speaker: values.speaker, delegation: values.delegation, language: values.language, topic: values.topic, plannedSeconds: values.plannedSeconds, insertAt: values.insertAt }
    });
  });

  const startHandoff$ = $((channelId: string) => {
    const channel = state.channels.find((c) => c.id === channelId);
    pushToBatch$({ kind: 'handoff', handoff: { channelId, interpreter: channel?.interpreter ?? '', phase: 'start' } });
  });

  const completeHandoff$ = $((channelId: string) => {
    // 频道交接状态变化：先让旧批次失效，再把新交接项放进新批次
    invalidateBatchesForRoom(state, state.activeRoomId, '频道交接状态变化');
    const channel = state.channels.find((c) => c.id === channelId);
    pushToBatch$({ kind: 'handoff', handoff: { channelId, interpreter: `替补译员-${channel?.language ?? ''}`, phase: 'complete' } });
  });

  const submitCurrentBatch$ = $(() => {
    const batch = pendingBatch();
    if (!batch) return;
    const result = submitBatch(state, batch.id);
    if (!result.ok) {
      lastConflicts.value = { batchId: batch.id, items: result.conflicts };
    } else {
      lastConflicts.value = null;
    }
  });

  const retryBatch$ = $((batchId: string) => {
    const result = retryBatch(state, batchId);
    if (!result.ok) {
      lastConflicts.value = { batchId, items: result.conflicts };
    } else {
      lastConflicts.value = null;
    }
  });

  const discardBatch$ = $((batchId: string) => {
    discardBatch(state, batchId);
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) return;
    publishCaption(state, speech.id, values.text, false);
  });

  const broadcastCaption$ = $(() => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) return;
    const caption = state.captions.find((c) => c.speechId === speech.id && c.roomId === state.activeRoomId);
    if (!caption) return;
    publishCaption(state, speech.id, caption.text, true);
  });

  const approveTerm$ = $((id: string) => {
    state.terms = state.terms.map((term) => term.id === id ? { ...term, approved: true } : term);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}` });
  });

  const batchStatusLabel = (b: QueueBatch) => {
    if (b.status === 'pending') return '待生效';
    if (b.status === 'applied') return '已生效';
    if (b.status === 'failed') return '失败/冲突';
    return '已失效';
  };

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div><span class="pill">{locale.lang}</span><h1>同声传译与发言队列</h1><p>{activeRoom().name} · {activeRoom().topic}</p></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <span class="pill">队列版本 v{state.queueVersion}</span>
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>{state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}</select>
          <button class="secondary" onClick$={() => state.lowLatency = !state.lowLatency}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <h2>发言队列</h2>
            <span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span>
          </div>

          <div style="display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap">
            <input
              value={activeRoom().topic}
              onChange$={(event) => changeTopic$((event.target as HTMLInputElement).value)}
              placeholder="修改议题后旧批次立即失效"
              style="flex:1;min-width:200px"
            />
            {pendingBatch() && (
              <>
                <span class="pill">待生效批次 #{pendingBatch()!.batchNumber} · {pendingBatch()!.items.length} 项</span>
                <button onClick$={submitCurrentBatch$}>提交批次</button>
                <button class="secondary" onClick$={() => discardBatch$(pendingBatch()!.id)}>作废</button>
              </>
            )}
          </div>

          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div><b>{speech.speaker}</b><div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div></div>
              <span class="pill">{statusLabel[speech.status]}</span>
              <div style="display:flex;gap:6px">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && <><button onClick$={() => advanceSpeech$(speech.id, 'done')}>结束</button><button class="secondary" onClick$={() => speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60)}>减1分钟</button></>}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(speech.id, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}

          <h3 style="margin-top:18px">临时插话</h3>
          <InterjectionForm onSubmit$={addInterjection$}>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <InterjectionField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</InterjectionField>
              <InterjectionField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</InterjectionField>
              <InterjectionField name="language">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="语言" />}</InterjectionField>
              <InterjectionField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</InterjectionField>
              <InterjectionField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</InterjectionField>
              <InterjectionField name="insertAt" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="插入位置(第几位)" />}</InterjectionField>
            </div>
            <button type="submit" style="margin-top:10px">加入插话到待生效批次</button>
          </InterjectionForm>

          <h3 style="margin-top:18px">加入发言队列</h3>
          <QueueForm onSubmit$={addSpeech$}>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
            </div>
            <button type="submit" style="margin-top:10px">加入待生效批次</button>
          </QueueForm>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{channel.status}</span></div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
              <div style="display:flex;gap:8px"><button class="secondary" onClick$={() => startHandoff$(channel.id)}>开始交接</button>{channel.status === 'handoff' && <button onClick$={() => completeHandoff$(channel.id)}>完成交接</button>}</div>
            </div>
          ))}

          <h3>实时字幕修正</h3>
          {currentSpeech() ? <CaptionForm onSubmit$={publishCaption$}><CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前字幕（草稿，切换发言人时改绑）" />}</CaptionField><div style="display:flex;gap:8px;margin-top:8px"><button type="submit">存为草稿</button><button type="button" class="secondary" onClick$={broadcastCaption$}>播出并冻结</button></div></CaptionForm> : <p>当前没有发言中的代表。</p>}
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).map((caption) => (
            <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}>
              <div style="display:flex;justify-content:space-between"><b>{caption.interpreter} · v{caption.revision}</b><span class="pill">{caption.status === 'broadcast' ? '已播出' : '草稿'}</span></div>
              <p>{caption.text}</p>
            </div>
          ))}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>批次中心</h2>
          {lastConflicts.value && (
            <div style="background:#fdeceb;border:1px solid #e5b6b2;border-radius:10px;padding:10px;margin-bottom:12px">
              <b>提交冲突（最新版次 v{state.queueVersion}）</b>
              <ul style="margin:6px 0 0 18px;padding:0">
                {lastConflicts.value.items.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          {roomBatches().length === 0 && <p style="color:#638087">暂无批次。旧数据已迁移为基准批。</p>}
          {roomBatches().map((batch) => (
            <div class="queue-row" style={{ gridTemplateColumns: '1fr auto', gap: '10px' }} key={batch.id}>
              <div>
                <b>批次 #{batch.batchNumber}</b>
                <div style="color:#638087;font-size:13px">
                  {batch.items.length} 项 · 来源 v{batch.sourceVersion} · {new Date(batch.createdAt).toLocaleTimeString()}
                  {batch.failureReason ? ` · ${batch.failureReason}` : ''}
                </div>
                {batch.status === 'failed' && (
                  <div style="color:#a83a35;font-size:13px;margin-top:4px">
                    未完成项将在重试时续做，已处理项不重复排队或交接。
                  </div>
                )}
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                <span class="pill">{batchStatusLabel(batch)}</span>
                {batch.status === 'pending' && <button onClick$={submitCurrentBatch$}>提交</button>}
                {batch.status === 'failed' && <button onClick$={() => retryBatch$(batch.id)}>重试</button>}
                {batch.status === 'pending' && <button class="secondary" onClick$={() => discardBatch$(batch.id)}>作废</button>}
              </div>
            </div>
          ))}
        </article>

        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span/><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button></div>)}
        </article>
      </section>

      <section class="panel" style="margin-top:18px">
        <h2>操作与交接时间线</h2>
        {state.audits.filter((audit) => audit.roomId === state.activeRoomId).slice(0, 10).map((audit) => <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}><small>{new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
