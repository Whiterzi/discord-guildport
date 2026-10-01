const sequences: Record<string,string> = {
  '\x1b[A':'up','\x1b[B':'down','\x1b[C':'right','\x1b[D':'left',
  '\x1bOA':'up','\x1bOB':'down','\x1bOC':'right','\x1bOD':'left',
  '\x1b[5~':'pageup','\x1b[6~':'pagedown','\x1b[H':'home','\x1b[F':'end',
  '\x1bOH':'home','\x1bOF':'end','\x1b[1~':'home','\x1b[4~':'end',
  '\x1b[3~':'delete','\x1bOQ':'details','\x1b[12~':'details',
};
const controls: Record<string,string> = {'\r':'enter','\n':'newline','\x7f':'backspace','\b':'backspace',
  '\x03':'interrupt','\x04':'interrupt','\x01':'start','\x05':'finish','\x15':'clear','\x0c':'redraw','\x12':'refresh'};

/** Incremental parser: pasted line breaks never trigger message submission. */
export class ChatInput {
  private buffer='';
  private paste: string | null=null;
  constructor(private key: (name: string) => void, private text: (text: string) => void) {}
  private modified(code: number, modifier: number, event=1): void {
    if (event===3) return; // A release must never submit or insert a second newline.
    const mods=(modifier-1)&63; // Caps/Num Lock do not change shortcuts.
    if (code===13) {
      if (mods===1) this.key('newline');
      else if (mods===0 && event===1) this.key('enter');
    } else if (code===27 && mods===0) this.key('exit');
    else if (mods===4 && code>=97 && code<=122) {
      const control=controls[String.fromCharCode(code-96)];
      if (control) this.key(control);
    } else if (mods===0 && (code===127 || code===8)) this.key('backspace');
  }
  feed(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer) {
      if (this.paste !== null) {
        const end=this.buffer.indexOf('\x1b[201~');
        if (end<0) {
          // Keep a possible split closing delimiter for the next chunk.
          const keep=Math.min(5,this.buffer.length);
          this.paste=(this.paste+this.buffer.slice(0,this.buffer.length-keep)).slice(0,20000);
          this.buffer=this.buffer.slice(-keep);
          return;
        }
        this.text((this.paste+this.buffer.slice(0,end)).slice(0,20000).replace(/\r\n?/g,'\n'));
        this.paste=null; this.buffer=this.buffer.slice(end+6); continue;
      }
      if (this.buffer.startsWith('\x1b[200~')) { this.paste=''; this.buffer=this.buffer.slice(6); continue; }
      if (this.buffer[0]==='\x1b') {
        // Kitty/CSI-u and xterm modifyOtherKeys. Accept split packets and consume
        // unsupported control sequences whole, so they cannot become draft text.
        const csi=/^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.buffer)?.[0];
        if (csi) {
          const kitty=/^\x1b\[(\d+)(?:;(\d+)(?::([123]))?)?u$/.exec(csi);
          const xterm=/^\x1b\[27;(\d+);(\d+)~$/.exec(csi);
          if (kitty) this.modified(Number(kitty[1]),Number(kitty[2]??1),Number(kitty[3]??1));
          else if (xterm) this.modified(Number(xterm[2]),Number(xterm[1]));
          else if (sequences[csi]) this.key(sequences[csi]!);
          this.buffer=this.buffer.slice(csi.length); continue;
        }
        if (/^\x1b\[[0-?]*[ -/]*$/.test(this.buffer)) {
          if (this.buffer.length>128) this.buffer='';
          return;
        }
        const match=Object.keys(sequences).find(sequence=>this.buffer.startsWith(sequence));
        if (match) { this.key(sequences[match]!); this.buffer=this.buffer.slice(match.length); continue; }
        if (['\x1b[200~',...Object.keys(sequences)].some(sequence=>sequence.startsWith(this.buffer))) return;
        // Consume unknown terminal escape sequences, never insert them into a draft.
        const unknown=/^\x1b(?:\[[0-9;?]*[a-zA-Z~]|O.)/.exec(this.buffer);
        if (unknown) { this.buffer=this.buffer.slice(unknown[0].length); continue; }
        this.buffer=this.buffer.slice(1); continue;
      }
      const control=controls[this.buffer[0]!];
      if (control) { this.key(control); this.buffer=this.buffer.slice(1); continue; }
      const match=/^[^\x00-\x1f\x7f]+/.exec(this.buffer);
      if (match) { this.text(match[0]); this.buffer=this.buffer.slice(match[0].length); }
      else this.buffer=this.buffer.slice(1);
    }
  }
  flushEscape(): void { if (this.buffer==='\x1b' && this.paste===null) { this.buffer=''; this.key('exit'); } }
}
