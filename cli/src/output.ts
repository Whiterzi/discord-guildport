import type { Message } from './api.js';
import { stripVTControlCharacters } from 'node:util';

export function safeText(value: unknown): string {
  // Strip terminal controls, OSC/ANSI introducers, carriage returns and bidi controls.
  return stripVTControlCharacters(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function readableText(value: string): string {
  let code = false;
  return safeText(value).replace(/\t/g, '    ').split('\n').map(line => {
    if (/^\s*```/.test(line)) { code = !code; return code ? '┌ code' : '└'; }
    if (code) return '│ ' + line;
    return line.replace(/\|\|.*?\|\|/g, '[spoiler]')
      .replace(/\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/g, '$1 — $2')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/<a?:([\w]+):\d+>/g, ':$1:')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1').replace(/`([^`\n]+)`/g, '$1')
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1$2')
      .replace(/\\([\\*_~`])/g, '$1');
  }).join('\n');
}

export function localDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

export function localTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false});
}

export function displayAuthor(message: Message): string {
  // Only server-supplied attribution is trusted, never a user-written body prefix.
  return safeText(message.relay_author?.name ?? message.author.name).replace(/[\n\t]/g, ' ')
    + (message.relay_author ? ' · via GuildPort' : message.author.bot ? ' · bot' : '');
}

export function formatMessage(message: Message, details = false): string {
  const lines = [`${localDate(message.created_at)} ${localTime(message.created_at)}  ${displayAuthor(message)}${details ? `  [${safeText(message.id)}]` : ''}`,
    readableText(message.relay_author ? message.relay_content ?? message.content : message.content) || ((message.attachments ?? []).length ? '' : '[No text content]')];
  for (const attachment of message.attachments ?? []) lines.push(`  ${safeText(attachment.name)}: ${safeText(attachment.url)}`);
  return lines.join('\n');
}
