import type { Message } from './api.js';

export function safeText(value: unknown): string {
  // Strip terminal controls, OSC/ANSI introducers, carriage returns and bidi controls.
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function formatMessage(message: Message): string {
  const lines = [`[${safeText(message.created_at)}] ${safeText(message.author.name)} (${message.id})`,
    safeText(message.content)];
  for (const attachment of message.attachments ?? []) lines.push(`  ${safeText(attachment.name)}: ${safeText(attachment.url)}`);
  return lines.join('\n');
}
