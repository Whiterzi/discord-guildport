const sequences: Record<string,string> = {
  '\x1b[A':'up','\x1b[B':'down','\x1b[C':'right','\x1b[D':'left',
  '\x1b[5~':'pageup','\x1b[6~':'pagedown','\x1b[H':'home','\x1b[F':'end',
  '\x1bOH':'home','\x1bOF':'end','\x1b[1~':'home','\x1b[4~':'end',
  '\x1b[3~':'delete','\x1bOQ':'details','\x1b[12~':'details',
};
const controls: Record<string,string> = {'\r':'enter','\n':'newline','\x7f':'backspace','\b':'backspace',
  '\x03':'exit','\x04':'exit','\x01':'start','\x05':'finish','\x15':'clear','\x0c':'redraw'};

/** Incremental parser: pasted line breaks never trigger message submission. */
export class ChatInput {
  private buffer='';
  private paste: string | null=null;
  constructor(private key: (name: string) => void, private text: (text: string) => void) {}
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
