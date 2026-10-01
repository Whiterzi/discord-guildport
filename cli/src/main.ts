#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Api, ApiError, id, type Message } from './api.js';
import { clearSession, loadSession, saveSession, serverUrl, type Session } from './config.js';
import { formatMessage, safeText } from './output.js';
import { interactive } from './interactive.js';
import { chat } from './chat.js';

async function passwordPrompt(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 512) throw new Error('Password input is too long.');
    }
    return text.replace(/[\r\n]+$/, '');
  }
  if (!process.stdin.isTTY) throw new Error('Use --password-stdin with piped input.');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stdout.write('GuildPort password: ');
    muted = true;
    const abort = new AbortController();
    rl.on('SIGINT', () => abort.abort());
    return await rl.question('', { signal: abort.signal });
  } finally { rl.close(); process.stdout.write('\n'); }
}

async function client(): Promise<Api> { return Api.session(await loadSession()); }

function print(value: unknown, json: boolean, render: () => string): void {
  process.stdout.write((json ? JSON.stringify(value) : render()) + '\n');
}

async function send(api: Api, channel: string, text: string, output = (line: string) => process.stdout.write(line + '\n')): Promise<void> {
  if (!text.trim() || [...text].length > 1800) throw new Error('Messages must contain 1–1800 characters.');
  const requestId = randomUUID();
  try {
    const message = await api.request<{ id: string }>(`/v1/channels/${id(channel)}/messages`,
      { content: text, request_id: requestId });
    output(`Sent ${message.id}`);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code === 'delivery_unknown') {
      throw new Error(`Delivery may be uncertain (request ${requestId}). Check channel history before resending. ${error instanceof Error ? error.message : ''}`);
    }
    throw error;
  }
}

async function watch(api: Api, channel: string, json: boolean, signal: AbortSignal,
                     output = (line: string) => process.stdout.write(line + '\n')): Promise<void> {
  let failures = 0;
  const seen = new Set<string>();
  function show(message: Message) {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 1000) seen.delete(seen.values().next().value!);
    output(json ? JSON.stringify({ type: 'message.created', message }) : formatMessage(message));
  }
  while (!signal.aborted) {
    try {
      for await (const event of api.events(channel, signal)) {
        if (event.event === 'ready') {
          const history = await api.request<{ messages: Message[] }>(`/v1/channels/${id(channel)}/messages?limit=100`);
          for (const message of history.messages) show(message);
          if (failures) process.stderr.write('Reconnected; refreshed the latest 100 messages. Longer gaps may require dcgp history.\n');
          failures = 0;
        } else if (event.event === 'revoked') {
          throw new ApiError(403, 'stream_revoked', 'Stream stopped: permissions or session changed. Reopen the channel after checking access.');
        } else if (event.data.type === 'resync_required') {
          throw new Error('Stream requires resynchronization.');
        } else if (event.data.type === 'message.created') {
          show(event.data.message as unknown as Message);
        } else {
          output(json ? JSON.stringify(event.data) : `[${safeText(event.data.type)}] ${safeText(event.data.message_id)}`);
        }
      }
      if (!signal.aborted) throw new Error('Event stream closed.');
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) throw error;
      failures++;
      process.stderr.write(`Connection interrupted: ${safeText(error instanceof Error ? error.message : error)}. Reconnecting…\n`);
      try { await delay(Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30_000), undefined, { signal }); }
      catch { return; }
    }
  }
}

const program = new Command().name('dcgp').description('Chat through a GuildPort Discord relay.').version('0.1.0-alpha.2');
program.action(async () => interactive(chat));
program.command('browse').description('Select servers and channels with arrow keys.').action(async () => interactive(chat));

program.command('login').requiredOption('--server <url>', 'relay HTTPS origin')
  .requiredOption('--username <name>', 'account from /register')
  .option('--password-stdin', 'read password from standard input, never a command argument')
  .option('--device <name>', 'device label', hostname())
  .action(async options => {
    const server = serverUrl(options.server);
    const password = await passwordPrompt(Boolean(options.passwordStdin));
    const result = await new Api(server).request<Omit<Session, 'server'>>('/v1/login',
      { username: options.username, password, device: options.device });
    await saveSession({ server, ...result });
    process.stdout.write(`Logged in as ${safeText(result.user.username)}.\n`);
  });

program.command('whoami').option('--json', 'output JSON').action(async options => {
  const me = await (await client()).request<{ discord_id: string; username: string }>('/v1/me');
  print(me, options.json, () => `${safeText(me.username)} (Discord ${me.discord_id})`);
});

program.command('guilds').option('--json', 'output JSON').action(async options => {
  const data = await (await client()).request<{ guilds: { id: string; name: string }[] }>('/v1/guilds');
  print(data, options.json, () => data.guilds.map(g => `${g.id}\t${safeText(g.name)}`).join('\n') || 'No enabled shared servers. Ask an admin to use /relay enable.');
});

program.command('channels <guild>').option('--json', 'output JSON').action(async (guild, options) => {
  const data = await (await client()).request<{ channels: { id: string; name: string; can_send: boolean }[] }>(`/v1/guilds/${id(guild)}/channels`);
  print(data, options.json, () => data.channels.map(c => `${c.id}\t#${safeText(c.name)}${c.can_send ? '' : ' [read only]'}`).join('\n') || 'No accessible channels.');
});

program.command('history <channel>').option('--limit <number>', '1–100 messages', '30')
  .option('--before <id>', 'messages older than this ID').option('--json', 'output JSON')
  .option('--details', 'include message IDs')
  .action(async (channel, options) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be between 1 and 100.');
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.before) query.set('before', id(options.before));
    const data = await (await client()).request<{ messages: Message[] }>(`/v1/channels/${id(channel)}/messages?${query}`);
    print(data, options.json, () => data.messages.map(message => formatMessage(message, options.details)).join('\n\n') || 'No messages.');
  });

program.command('send <channel> <message>').action(async (channel, text) => send(await client(), channel, text));

program.command('watch <channel>').option('--json', 'output newline-delimited JSON').action(async (channel, options) => {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await watch(await client(), id(channel), options.json, controller.signal); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
});

program.command('chat <channel>').description('Full-screen chat; Esc returns, PgUp/PgDn scroll.').action(async channel => chat(await client(), id(channel)));

program.command('logout').option('--all', 'revoke every device').option('--local-only', 'remove local session without server revocation')
  .action(async options => {
    if (!options.localOnly) await (await client()).request(options.all ? '/v1/logout-all' : '/v1/logout', {});
    await clearSession();
    process.stdout.write(options.localOnly ? 'Local session removed; server token was not revoked.\n' : 'Logged out.\n');
  });

program.parseAsync().catch(error => {
  if (error instanceof Error && error.name === 'ExitPromptError') return;
  process.stderr.write(`dcgp: ${safeText(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
