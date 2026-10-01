import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { Api, ApiError, id, type Message } from './api.js';
import { ChatInput } from './chat-input.js';
import { Draft, Timeline, frameAnsi, graphemes, renderFrame, type ChatState } from './chat-view.js';
import { safeText } from './output.js';

export async function chat(api: Api, channel: string, title=channel, readOnly=false): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM==='dumb')
    throw new Error('Full-screen chat needs a terminal. Use dcgp history or dcgp watch for plain output.');
  id(channel);
  const controller=new AbortController(), {signal}=controller;
  const state: ChatState={title,status:'Connecting…',notice:'',readOnly,details:false,
    timeline:new Timeline(),draft:new Draft(),top:null,unread:0};
  let closed=false, sending=false, uncertain=false, loading=false, exhausted=false;
  let failure: unknown, escapeTimer: NodeJS.Timeout | undefined, refreshTimer: NodeJS.Timeout | undefined;
  const pending=new Set<Promise<unknown>>();
  let finish!:()=>void;
  const finished=new Promise<void>(resolve=>finish=resolve);
  const size=()=>({columns:process.stdout.columns || 80,rows:process.stdout.rows || 24});
  const draw=()=>{
    if (closed) return;
    const {columns,rows}=size();
    process.stdout.write(frameAnsi(renderFrame(state,columns,rows,process.env.NO_COLOR===undefined)));
  };
  const update=(change:()=>void)=>{
    const {columns}=size();
    const anchor=state.top===null ? undefined : state.timeline.rows(columns-1,state.details)[state.top]?.key;
    change();
    if (anchor && state.top!==null) {
      const position=state.timeline.rows(columns-1,state.details).findIndex(row=>row.key===anchor);
      if (position>=0) state.top=position;
    }
    draw();
  };
  const background=(promise: Promise<unknown>)=>{
    pending.add(promise);
    void promise.finally(()=>pending.delete(promise)).catch(()=>{});
  };
  const close=()=>{
    if (closed) return;
    if (sending) failure=new Error('Send outcome may be uncertain. Check channel history before resending.');
    closed=true; controller.abort(); finish();
  };
  const history=async(before?:string)=>{
    const query=new URLSearchParams({limit:'100'});
    if (before) query.set('before',before);
    return (await api.request<{messages:Message[]}>(`/v1/channels/${channel}/messages?${query}`,undefined,signal)).messages;
  };
  const refresh=async()=>{
    try { const messages=await history(); if (!closed) update(()=>state.timeline.snapshot(messages)); }
    catch(error) {
      if (closed) return;
      if (error instanceof ApiError && [401,403,404].includes(error.status)) { failure=error; close(); }
      else { state.notice='Could not refresh edited messages. Reopen the channel to retry.'; draw(); }
    }
  };
  const older=async()=>{
    if (loading || exhausted || closed) return;
    if (state.timeline.messages.size>=500) { state.notice='500-message session limit. Use dcgp history --before for older messages.'; draw(); return; }
    const first=state.timeline.sorted()[0];
    if (!first) return;
    loading=true; state.notice='Loading older messages…'; draw();
    try {
      const messages=await history(first.id);
      if (!closed) update(()=>{
        exhausted=messages.length<100;
        // Respect the memory cap while retaining the current view and newest messages.
        for (const message of messages.slice(-(500-state.timeline.messages.size))) state.timeline.upsert(message);
        state.notice=messages.length ? 'Older messages loaded. PgUp to continue.' : 'Beginning of channel history.';
      });
    } catch(error) {
      if (!closed) {
        if (error instanceof ApiError && [401,403,404].includes(error.status)) { failure=error; close(); }
        else { state.notice='Could not load older messages. PgUp to retry.'; draw(); }
      }
    } finally { loading=false; }
  };
  const scroll=(amount:number)=>{
    const {columns,rows}=size(), frame=renderFrame(state,columns,rows,false);
    const maximum=Math.max(0,state.timeline.rows(columns-1,state.details).length-frame.height);
    const target=Math.max(0,Math.min(maximum,frame.top+amount));
    state.top=target>=maximum && amount>0 ? null : target;
    if (state.top===null) state.unread=0;
    draw();
    if (target===0 && amount<0) background(older());
  };
  const submit=async()=>{
    const text=state.draft.text;
    if (['/back','/quit'].includes(text.trim())) { close(); return; }
    if (sending || !text.trim()) return;
    if (state.readOnly) { state.notice='Read only. Esc returns to channels.'; draw(); return; }
    if (uncertain) { state.notice='Check history before resending. Ctrl+U clears the uncertain draft.'; draw(); return; }
    if ([...text].length>1800) { state.notice='Message is too long; shorten it to 1800 characters.'; draw(); return; }
    sending=true; state.notice='Sending…'; draw();
    try {
      await api.request(`/v1/channels/${channel}/messages`,{content:text,request_id:randomUUID()},signal);
      if (!closed) { state.draft.clear(); state.notice='Sent'; }
    } catch(error) {
      if (!closed) {
        uncertain=!(error instanceof ApiError) || error.code==='delivery_unknown';
        state.notice=uncertain ? 'Delivery uncertain. Check history; Ctrl+U clears this draft.' : safeText(error instanceof Error ? error.message : error);
      }
    } finally { sending=false; draw(); }
  };
  const input=new ChatInput(key=>{
    const height=Math.max(1,size().rows-8);
    if (key==='exit') close();
    else if (key==='up') scroll(-1);
    else if (key==='down') scroll(1);
    else if (key==='pageup') scroll(-height);
    else if (key==='pagedown') scroll(height);
    else if (key==='home') { state.top=0; draw(); }
    else if (key==='end') { state.top=null; state.unread=0; draw(); }
    else if (key==='details') { state.details=!state.details; state.top=null; state.unread=0; draw(); }
    else if (!sending) {
      if (key==='enter') background(submit());
      else if (key==='left') state.draft.move(-1);
      else if (key==='right') state.draft.move(1);
      else if (key==='start') state.draft.cursor=0;
      else if (key==='finish') state.draft.cursor=graphemes(state.draft.text).length;
      else if (key==='backspace') state.draft.erase(true);
      else if (key==='delete') state.draft.erase(false);
      else if (key==='clear') { state.draft.clear(); uncertain=false; state.notice=''; }
      else if (key==='newline') state.draft.insert('\n');
      draw();
    }
  },text=>{if(!sending){state.draft.insert(text);draw();}});
  const decoder=new StringDecoder('utf8');
  const onData=(chunk:Buffer|string)=>{
    if (closed) return;
    clearTimeout(escapeTimer);
    input.feed(typeof chunk==='string' ? chunk : decoder.write(chunk));
    escapeTimer=setTimeout(()=>input.flushEscape(),60);
  };
  const watch=async()=>{
    let failures=0;
    while (!closed) {
      try {
        for await (const event of api.events(channel,signal)) {
          if (event.event==='ready') {
            const messages=await history();
            if (closed) break;
            update(()=>{
              state.timeline.snapshot(messages); state.status='● Connected';
              if (failures) state.notice='Reconnected · refreshed latest 100 messages.';
            });
            failures=0;
          } else if (event.event==='revoked') {
            throw new ApiError(403,'stream_revoked','Channel access or session changed. Reopen the channel after checking access.');
          } else if (event.data.type==='resync_required') throw new Error('Resync required.');
          else if (event.data.type==='message.created') {
            update(()=>{if(state.timeline.upsert(event.data.message as unknown as Message) && state.top!==null) state.unread++;});
          } else if (event.data.type==='message.deleted') {
            update(()=>state.timeline.remove(String(event.data.message_id)));
          } else if (event.data.type==='message.updated') {
            update(()=>state.timeline.markEdited(String(event.data.message_id)));
            if (!refreshTimer) refreshTimer=setTimeout(()=>{refreshTimer=undefined;background(refresh());},500);
          }
        }
        if (!closed) throw new Error('Connection closed.');
      } catch(error) {
        if (closed) return;
        if (error instanceof ApiError && [401,403,404].includes(error.status)) { failure=error; close(); return; }
        const wait=Math.min(1000*2**Math.min(failures++,5),30000);
        state.status=`○ Reconnecting in ${wait/1000}s`; draw();
        try { await delay(wait,undefined,{signal}); } catch {return;}
      }
    }
  };
  const wasRaw=process.stdin.isRaw;
  let exitSignal=0;
  const interrupt=()=>{exitSignal=130;close();};
  const terminate=()=>{exitSignal=143;close();};
  let watching:Promise<void>|undefined;
  try {
    process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[2J');
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('data',onData);
    process.stdout.on('resize',draw);
    process.once('SIGINT',interrupt); process.once('SIGTERM',terminate);
    draw(); watching=watch(); await finished;
  } finally {
    closed=true; controller.abort();
    clearTimeout(escapeTimer); clearTimeout(refreshTimer);
    process.stdin.off('data',onData); process.stdout.off('resize',draw);
    process.off('SIGINT',interrupt); process.off('SIGTERM',terminate);
    process.stdin.setRawMode(Boolean(wasRaw));
    // A fresh stdin reports isPaused()=false even before it starts flowing.
    // Always release our read handle; the next picker resumes stdin itself.
    process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l');
    await watching;
    await Promise.allSettled([...pending]);
  }
  if (exitSignal) { process.exitCode=exitSignal; throw Object.assign(new Error('Interrupted'),{name:'ExitPromptError'}); }
  if (failure) throw failure;
}
