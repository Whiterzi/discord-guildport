import { StringDecoder } from 'node:string_decoder';
import wrapAnsi from 'wrap-ansi';
import { ChatInput } from './chat-input.js';
import { clip, graphemes, oneLine, width } from './chat-view.js';

export interface MenuItem { value: string; name: string; description?: string; action?: boolean }
export interface MenuOptions {
  title: string; path?: string; subtitle?: string; back?: string; backLabel?: string;
  selected?: string; search?: boolean; empty?: string;
  items: MenuItem[] | ((signal: AbortSignal) => Promise<MenuItem[]>);
}
export class MenuState {
  items: MenuItem[]=[];
  query='';
  index=0;
  loading=true;
  filtered(): MenuItem[] {
    const query=this.query.toLocaleLowerCase();
    return this.items.filter(item=>item.action || oneLine(item.name).toLocaleLowerCase().includes(query));
  }
  move(delta: number): void {
    this.index=Math.max(0,Math.min(this.filtered().length-1,this.index+delta));
  }
  search(text: string): void { this.query=graphemes(oneLine(text)).slice(0,120).join(''); this.index=0; }
}

export function renderMenu(options: MenuOptions, state: MenuState, columns: number, rows: number, color=true): string[] {
  const w=Math.max(1,columns-1), h=Math.max(1,rows);
  const paint=(text:string,code:string)=>color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const line=(text:string,code='0')=>paint(clip(oneLine(text),w),code);
  if(w<30 || h<12) return [line('Resize terminal (30 × 12). Esc back.')];
  const items=state.filtered(), capacity=h-11;
  const top=Math.max(0,Math.min(state.index-Math.floor(capacity/2),items.length-capacity));
  const count=items.filter(item=>!item.action).length;
  const summary=state.loading ? 'Loading… · Esc cancels' : state.query && !count ? 'No matches · Ctrl+U clears search'
    : !count && options.empty ? options.empty : `${oneLine(options.subtitle??'')}${count ? ` · ${count} available` : ''}`;
  const lines=[line(` GUILDPORT  /  ${options.title}`,'1;36'),line(` ${options.path??'Home'}`,'2'),
    line(` ${summary}`,'2'),line('─'.repeat(w),'2')];
  for(let i=0;i<capacity;i++) {
    const item=items[top+i], selected=top+i===state.index;
    const text=item ? clip(`${selected?' › ':'   '}${oneLine(item.name)}`,w) : '';
    lines.push(selected && item ? paint(text+' '.repeat(w-width(text)),'1;30;46') : line(text,item?.action?'2':'0'));
  }
  lines.push(line('─'.repeat(w),'2'));
  const detail=oneLine(items[state.index]?.description??'');
  const details=wrapAnsi(detail,Math.max(1,w-2),{hard:true}).split('\n');
  for(let i=0;i<3;i++)lines.push(line(` ${details[i]??''}`,'2'));
  lines.push(line(options.search ? ` Search: ${state.query || 'type to filter…'}` : '',state.query?'36':'2'));
  lines.push(line(` ↑/↓ select · Enter open · Esc ${options.backLabel??'back'}`,'2'));
  lines.push(line(` PgUp/PgDn page${options.search?' · Ctrl+U clear search':''} · Ctrl+C exit`,'2'));
  return lines;
}

/** Each picker replaces its screen and restores the shell on all exit paths. */
export async function menu(options: MenuOptions): Promise<string> {
  const state=new MenuState(), controller=new AbortController();
  const wasRaw=process.stdin.isRaw;
  let closed=false, failure:unknown, timer:NodeJS.Timeout|undefined, result=options.back??'back';
  let finish!:()=>void;
  const finished=new Promise<void>(resolve=>finish=resolve);
  const close=(value=result)=>{if(!closed){result=value;closed=true;controller.abort();finish();}};
  const draw=()=>{
    if(closed)return;
    const lines=renderMenu(options,state,process.stdout.columns||80,process.stdout.rows||24,process.env.NO_COLOR===undefined);
    process.stdout.write('\x1b[?25l'+lines.map((line,i)=>`\x1b[${i+1};1H\x1b[2K${line}`).join('')+'\x1b[J');
  };
  const interrupt=(code=130)=>{
    process.exitCode=code;
    failure=Object.assign(new Error('Interrupted'),{name:'ExitPromptError'});
    close();
  };
  const onInterrupt=()=>interrupt(), onTerminate=()=>interrupt(143);
  const input=new ChatInput(key=>{
    if(closed)return;
    if(key==='exit'){close();return;}
    if(key==='interrupt'){interrupt();return;}
    if(state.loading)return;
    if(key==='up')state.move(-1);
    else if(key==='down')state.move(1);
    else if(key==='pageup')state.move(-Math.max(1,(process.stdout.rows||24)-11));
    else if(key==='pagedown')state.move(Math.max(1,(process.stdout.rows||24)-11));
    else if(key==='home')state.index=0;
    else if(key==='end')state.index=Math.max(0,state.filtered().length-1);
    else if(key==='clear')state.search('');
    else if(key==='backspace')state.search(graphemes(state.query).slice(0,-1).join(''));
    else if(key==='enter'){
      const selected=state.filtered()[state.index];
      if(selected)close(selected.value);
    }
    draw();
  },text=>{if(!closed && !state.loading && options.search){state.search(state.query+text);draw();}});
  const decoder=new StringDecoder('utf8');
  const onData=(chunk:Buffer|string)=>{
    clearTimeout(timer);
    input.feed(typeof chunk==='string'?chunk:decoder.write(chunk));
    if(!closed)timer=setTimeout(()=>input.flushEscape(),60);
  };
  try {
    process.stdout.write('\x1b[?1049h\x1b[>1u\x1b[?2004h\x1b[2J');
    process.stdin.setRawMode(true);process.stdin.resume();
    process.stdin.on('data',onData);process.stdout.on('resize',draw);
    process.once('SIGINT',onInterrupt);process.once('SIGTERM',onTerminate);
    draw();
    void Promise.resolve().then(()=>typeof options.items==='function'?options.items(controller.signal):options.items)
      .then(items=>{
        if(closed)return;
        state.items=items;state.loading=false;
        state.index=Math.max(0,items.findIndex(item=>item.value===options.selected));draw();
      }).catch(error=>{if(!closed){failure=error;close();}});
    await finished;
  } finally {
    closed=true;controller.abort();clearTimeout(timer);
    process.stdin.off('data',onData);process.stdout.off('resize',draw);
    process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);
    process.stdin.setRawMode(Boolean(wasRaw));process.stdin.pause();
    process.stdout.write('\x1b[<u\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }
  if(failure)throw failure;
  return result;
}
