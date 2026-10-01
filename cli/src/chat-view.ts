import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { Message } from './api.js';
import { displayAuthor, localDate, localTime, readableText, safeText } from './output.js';

const segmenter = new Intl.Segmenter(undefined, {granularity:'grapheme'});
export const graphemes = (text: string): string[] => [...segmenter.segment(text)].map(part => part.segment);
export const width = stringWidth;
export function clip(text: string, columns: number): string {
  let result = '', used = 0;
  for (const char of graphemes(text)) {
    const size = width(char);
    if (used + size > columns) break;
    result += char; used += size;
  }
  return result;
}
export function oneLine(text: string): string { return safeText(text).replace(/[\n\t]/g, ' '); }

export interface Row { key: string; text: string; kind: 'date' | 'author' | 'body' | 'muted' }
export class Timeline {
  messages = new Map<string, Message>();
  private edited = new Set<string>();
  private cached: {key:string; rows:Row[]} | undefined;
  upsert(message: Message): boolean {
    this.cached=undefined;
    const fresh = !this.messages.has(message.id);
    this.messages.set(message.id, message);
    this.edited.delete(message.id);
    if (this.messages.size > 500) this.remove(this.sorted()[0]!.id);
    return fresh;
  }
  sorted(): Message[] {
    return [...this.messages.values()].sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
  }
  snapshot(messages: Message[]): void {
    // Reconcile deletions during disconnection within the refreshed history window.
    const ids = new Set(messages.map(m => m.id));
    const oldest = messages.length ? messages.reduce((a,m) => BigInt(m.id) < a ? BigInt(m.id) : a, BigInt(messages[0]!.id)) : null;
    for (const key of this.messages.keys()) {
      if ((oldest === null || BigInt(key) >= oldest) && !ids.has(key)) this.remove(key);
    }
    for (const message of messages) this.upsert(message);
  }
  remove(id: string): void { this.cached=undefined; this.messages.delete(id); this.edited.delete(id); }
  markEdited(id: string): void {
    this.cached=undefined;
    const previous = this.messages.get(id);
    if (previous) {
      this.messages.set(id, {...previous, content:'[Message edited — reload history to view]', relay_content:undefined, attachments:[]});
      this.edited.add(id);
    }
  }
  rows(columns: number, details = false): Row[] {
    const key=`${columns}:${details}`;
    if (this.cached?.key===key) return this.cached.rows;
    const rows: Row[] = [];
    let date = '';
    const add = (key: string, text: string, kind: Row['kind'], indent = '  ') => {
      const lines = wrapAnsi(text, Math.max(2, columns - width(indent)), {hard:true, trim:false}).split('\n');
      lines.forEach((line,i) => rows.push({key:`${key}:${i}`,text:indent + line,kind}));
    };
    for (const message of this.sorted()) {
      const day = localDate(message.created_at);
      if (day !== date) { add(`date:${day}`, `── ${day} ──`, 'date'); date = day; }
      add(`${message.id}:author`, `${localTime(message.created_at)}  ${displayAuthor(message)}${details ? `  [${safeText(message.id)}]` : ''}`, 'author');
      const body = this.edited.has(message.id) ? message.content
        : readableText(message.relay_author ? message.relay_content ?? message.content : message.content);
      if (body) add(`${message.id}:body`, body, this.edited.has(message.id) ? 'muted' : 'body', '    ');
      for (const [i,attachment] of (message.attachments ?? []).entries())
        add(`${message.id}:file:${i}`, `↳ ${oneLine(attachment.name)} · ${safeText(attachment.url)}`, 'muted', '    ');
      if (!body && !message.attachments?.length) add(`${message.id}:empty`, '[No text content]', 'muted', '    ');
      rows.push({key:`${message.id}:gap`,text:'',kind:'body'});
    }
    this.cached={key,rows};
    return rows;
  }
}

export class Draft {
  text = '';
  cursor = 0;
  insert(text: string): void {
    const parts = graphemes(this.text);
    parts.splice(this.cursor, 0, safeText(text).replace(/\t/g, '    '));
    const before = parts.slice(0,this.cursor+1).join('');
    this.text = parts.join('').slice(0,20000);
    this.cursor = Math.min(graphemes(before).length, graphemes(this.text).length);
  }
  move(delta: number): void { this.cursor = Math.max(0,Math.min(graphemes(this.text).length,this.cursor+delta)); }
  erase(backward: boolean): void {
    const parts = graphemes(this.text);
    if (backward && this.cursor) parts.splice(--this.cursor,1);
    else if (!backward) parts.splice(this.cursor,1);
    this.text = parts.join('');
  }
  clear(): void { this.text=''; this.cursor=0; }
  display(columns: number): {text: string; cursor: number} {
    const parts = graphemes(this.text).map(c => c === '\n' ? ' ↵ ' : c);
    let start = 0;
    while (start < this.cursor && width(parts.slice(start,this.cursor).join('')) >= columns-1) start++;
    const prefix = start ? '‹' : '';
    return {text:prefix + clip(parts.slice(start).join(''), Math.max(0,columns-width(prefix))),
      cursor:width(prefix + parts.slice(start,this.cursor).join(''))};
  }
}

export interface ChatState {
  title: string; status: string; notice: string; readOnly: boolean; details: boolean;
  timeline: Timeline; draft: Draft; top: number | null; unread: number;
}
export interface Frame { lines: string[]; cursorRow: number; cursorColumn: number; height: number; top: number }
export function renderFrame(state: ChatState, columns: number, rows: number, color = true): Frame {
  const w = Math.max(1,columns-1), h = Math.max(1,rows);
  const paint = (text: string, code: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  if (w < 24 || h < 10) return {lines:[clip('Resize terminal (24 × 10). Esc returns.',w)],cursorRow:1,cursorColumn:1,height:1,top:0};
  const height = h-8;
  const content = state.timeline.rows(w,state.details);
  const top = state.top === null ? Math.max(0,content.length-height) : Math.max(0,Math.min(state.top,Math.max(0,content.length-height)));
  const lines = [paint(clip(` GUILDPORT  ${oneLine(state.title)}`,w),'1;36'),
    paint(clip(` ${oneLine(state.status)}${state.readOnly ? ' · READ ONLY' : ''} · ${state.timeline.messages.size} messages`,w),'2'),
    paint('─'.repeat(w),'2')];
  const visible = content.slice(top,top+height);
  if (!content.length) visible.push({key:'empty',text:'  No messages yet. Start the conversation.',kind:'muted'});
  for (let i=0; i<height; i++) {
    const row = visible[i];
    lines.push(row ? paint(clip(row.text,w),row.kind==='author' ? '1;36' : row.kind==='date' ? '2;36' : row.kind==='muted' ? '2' : '0') : '');
  }
  lines.push(paint('─'.repeat(w),'2'));
  lines.push(paint(clip(` ${state.unread ? `${state.unread} new · End: latest · ` : ''}${oneLine(state.notice)}`,w),'33'));
  const draft = state.draft.display(w-3);
  lines.push(' > ' + draft.text);
  lines.push(paint(clip(` Enter send · Esc back · PgUp/PgDn scroll · End latest · F2 IDs`,w),'2'));
  lines.push(paint(clip(` ${[...state.draft.text].length}/1800${state.draft.text.includes('\n') ? ' · multiline draft' : ''} · Shift+Enter / Ctrl+J newline · Ctrl+U clear · /back returns`,w),'2'));
  return {lines,cursorRow:h-2,cursorColumn:Math.min(w,4+draft.cursor),height,top};
}

export function frameAnsi(frame: Frame): string {
  return '\x1b[?25l' + frame.lines.map((line,i) => `\x1b[${i+1};1H\x1b[2K${line}`).join('')
    + `\x1b[J\x1b[${frame.cursorRow};${frame.cursorColumn}H\x1b[?25h`;
}
