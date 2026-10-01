import {test} from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import {ChatInput} from '../dist/chat-input.js';
import {Draft,Timeline,renderFrame,frameAnsi,width,graphemes} from '../dist/chat-view.js';
import {formatMessage,readableText} from '../dist/output.js';

const message=(id,content='hello')=>({id:String(id),channel_id:'200',author:{id:'300',name:'小睦',bot:false},
  content,created_at:'2026-10-01T06:07:00Z',attachments:[]});
const state=()=>({title:'測試伺服器 / #聊天',status:'● Connected',notice:'',readOnly:false,details:false,
  timeline:new Timeline(),draft:new Draft(),top:null,unread:0});

test('human-readable output hides IDs and raw markdown, JSON source is unchanged',()=>{
  const m=message('1555098576806215773','**Hello** [link](<https://example.com>) ||private||');
  const formatted=formatMessage(m);
  assert.doesNotMatch(formatted,/1555098576806215773|\*\*|private/);
  assert.match(formatted,/Hello link — https:\/\/example.com \[spoiler\]/);
  assert.match(formatMessage(m,true),/1555098576806215773/);
  assert.match(m.content,/\*\*Hello\*\*/);
  assert.match(readableText('```js\nconst x = "**literal**";\n```'),/\*\*literal\*\*/);
});

test('attribution only comes from server metadata, not a forged body prefix',()=>{
  const m=message('900','**Impersonated · via GuildPort** (`123`)\nhello');
  assert.match(formatMessage(m).split('\n')[0],/小睦/);
  m.relay_author={id:'301',name:'Alice'};
  m.relay_content='hello';
  assert.match(formatMessage(m).split('\n')[0],/Alice · via GuildPort/);
  assert.doesNotMatch(formatMessage(m),/Impersonated/);
});

test('draft cursor and deletion preserve emoji graphemes, Chinese and combining characters',()=>{
  const draft=new Draft();
  draft.insert('中文👩‍💻e\u0301');
  assert.equal(draft.cursor,4);
  draft.erase(true);
  assert.equal(draft.text,'中文👩‍💻');
  draft.move(-1); draft.insert('好');
  assert.equal(draft.text,'中文好👩‍💻');
  draft.erase(false);
  assert.equal(draft.text,'中文好');
  draft.insert('\n世界');
  assert.match(draft.display(8).text,/↵|世界/);
  assert(width(draft.display(8).text)<=8);
  assert(draft.display(8).cursor<8);
});

test('split bracketed paste never dispatches Enter or escape and preserves line breaks',()=>{
  const keys=[],text=[];
  const input=new ChatInput(key=>keys.push(key),value=>text.push(value));
  input.feed('\x1b[20');input.feed('0~first\r\nsecond\n/back\x1b[2');input.feed('01~');
  assert.deepEqual(keys,[]);
  assert.equal(text.join(''),'first\nsecond\n/back');
  input.feed('\r\x1b[5');input.feed('~\x1b');input.flushEscape();
  assert.deepEqual(keys,['enter','pageup','exit']);
});

test('Shift+Enter supports split CSI-u and xterm packets; releases never send',()=>{
  const keys=[],text=[];
  const input=new ChatInput(key=>keys.push(key),value=>text.push(value));
  for(const sequence of ['\x1b[13;2u','\x1b[27;2;13~','\x1b[13;2:1u','\x1b[106;5u']) {
    for(const char of sequence)input.feed(char);
  }
  input.feed('\x1b[13;2:3u\x1b[13;1:3u\x1b[13;1:2u');
  assert.deepEqual(keys,['newline','newline','newline','newline']);
  input.feed('\x1b[13u\x1b[13;1u\x1b[99;5u\x1b[117;5u\x1b[27u');
  assert.deepEqual(keys.slice(4),['enter','enter','interrupt','clear','exit']);
  input.feed('\x1b[?1u\x1b[99;3:1uplain text');
  assert.equal(text.join(''),'plain text');
});

test('timeline deduplicates, removes deletes, replaces edits and reconciles reconnect history',()=>{
  const timeline=new Timeline();
  timeline.upsert(message(1));timeline.upsert(message(2));
  assert.equal(timeline.upsert(message(2)),false);
  timeline.markEdited('2');
  assert.match(timeline.messages.get('2').content,/edited/);
  timeline.snapshot([message(2,'new'),message(3)]);
  assert.equal(timeline.messages.get('2').content,'new');
  timeline.remove('2');
  assert.deepEqual(timeline.sorted().map(m=>m.id),['1','3']);
  timeline.snapshot([message(1)]);
  assert.deepEqual(timeline.sorted().map(m=>m.id),['1']);
  timeline.snapshot([]);
  assert.equal(timeline.messages.size,0);
});

test('timeline memory is bounded and sorting never loses snowflake precision',()=>{
  const timeline=new Timeline();
  for(let i=0n;i<510n;i++)timeline.upsert(message(1555098576806215773n+i));
  assert.equal(timeline.messages.size,500);
  assert.equal(timeline.sorted()[0].id,'1555098576806215783');
});

test('frames fit narrow/wide terminals and keep composer fixed while scrolling',()=>{
  const s=state();
  for(let i=1;i<=50;i++)s.timeline.upsert(message(i,'中文與 emoji 👩‍💻 '.repeat(8)));
  s.draft.insert('尚未送出');
  for(const [cols,rows] of [[26,10],[55,24],[100,32]]){
    const frame=renderFrame(s,cols,rows,false);
    assert.equal(frame.lines.length,rows);
    assert(frame.lines.every(line=>width(line)<=cols-1));
    assert.match(frame.lines[rows-3],/尚未送出/);
    assert.equal(frame.cursorRow,rows-2);
    s.top=0;
    const scrolled=renderFrame(s,cols,rows,false);
    assert.equal(scrolled.lines[rows-3],frame.lines[rows-3]);
    s.top=null;
  }
  assert.match(renderFrame(s,20,8,false).lines[0],/Resize/);
});

test('actual terminal emulator renders fixed rows and restores primary screen',async()=>{
  const terminal=new xterm.Terminal({cols:70,rows:20,allowProposedApi:true});
  const write=data=>new Promise(resolve=>terminal.write(data,resolve));
  const s=state();
  s.timeline.upsert(message(900,'Hello **world**\nsecond line'));
  s.draft.insert('draft');
  await write('original prompt\r\n\x1b[?1049h\x1b[2J'+frameAnsi(renderFrame(s,70,20,false)));
  const buffer=terminal.buffer.active;
  assert.match(buffer.getLine(0).translateToString(true),/GUILDPORT/);
  assert.match(buffer.getLine(17).translateToString(true),/> draft/);
  assert.equal(buffer.cursorY,17);
  assert.equal(buffer.cursorX,8);
  assert.equal(buffer.length,20);
  const screen=Array.from({length:20},(_,i)=>buffer.getLine(i).translateToString(true)).join('\n');
  assert.match(screen,/Hello world/);
  assert.doesNotMatch(screen,/\*\*/);
  await write('\x1b[?1049l');
  assert.match(terminal.buffer.active.getLine(0).translateToString(true),/original prompt/);
  terminal.dispose();
});

test('remote ANSI, OSC clipboard codes and bidi controls never reach a terminal frame',()=>{
  const s=state();
  s.timeline.upsert(message(1,'\x1b[2J\x1b]52;c;c2VjcmV0\x07\u202esecret'));
  const frame=renderFrame(s,80,20,false);
  assert.doesNotMatch(frame.lines.join(''),/[\x1b\u202e]/);
  assert.match(frame.lines.join(''),/secret/);
});
