import test from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import { MenuState, renderMenu } from '../dist/menu.js';
import { width } from '../dist/chat-view.js';

const options={title:'Select a channel',path:'Home › Servers › 測試伺服器',search:true,backLabel:'servers',items:[]};
function state(){
  const s=new MenuState();s.loading=false;
  s.items=Array.from({length:45},(_,i)=>({name:`# 頻道 ${i} 🌿`,value:String(i),description:'Read and send messages.'}));
  s.items.push({name:'← Servers',value:'back',action:true});return s;
}
test('filtering retains navigation, supports Unicode and clamps selection',()=>{
  const s=state();s.move(35);s.search('頻道 24');
  assert.equal(s.index,0);assert.deepEqual(s.filtered().map(i=>i.value),['24','back']);
  s.move(100);assert.equal(s.index,1);s.move(-100);assert.equal(s.index,0);
  s.search('missing');assert.deepEqual(s.filtered().map(i=>i.value),['back']);
  assert.match(renderMenu(options,s,80,24,false).join('\n'),/No matches/);
});
test('menu layout fits terminals, keeps selected row visible and sanitizes remote names',()=>{
  const s=state();s.move(24);
  s.items[24].name+='\x1b[2J\u202e';
  for(const [cols,rows] of [[32,12],[55,24],[110,30]]){
    const lines=renderMenu(options,s,cols,rows,false);
    assert.equal(lines.length,rows);assert(lines.every(line=>width(line)<=cols-1));
    assert.match(lines.join('\n'),/› # 頻道 24/);
    assert.doesNotMatch(lines.join('\n'),/[\x1b\u202e]/);
  }
});
test('terminal selection changes replace the screen without leaving old prompts',async()=>{
  const terminal=new xterm.Terminal({cols:80,rows:24,allowProposedApi:true});
  const write=value=>new Promise(resolve=>terminal.write(value,resolve));
  const draw=s=>'\x1b[?25l'+renderMenu(options,s,80,24,true).map((line,i)=>`\x1b[${i+1};1H\x1b[2K${line}`).join('')+'\x1b[J';
  const s=state();
  await write('shell prompt\r\n\x1b[?1049h'+draw(s));
  s.search('頻道 24');await write(draw(s));
  const buffer=terminal.buffer.active;
  const screen=Array.from({length:24},(_,i)=>buffer.getLine(i).translateToString(true)).join('\n');
  assert.equal(buffer.length,24);assert.match(screen,/› # 頻道 24/);assert.doesNotMatch(screen,/# 頻道 0/);
  await write('\x1b[?1049l');assert.match(terminal.buffer.active.getLine(0).translateToString(true),/shell prompt/);
  terminal.dispose();
});
