import { input, password, select } from '@inquirer/prompts';
import { hostname } from 'node:os';
import { Api, ApiError } from './api.js';
import { clearSession, loadSession, saveSession, serverUrl, type Session } from './config.js';
import { safeText } from './output.js';

type Chat = (api: Api, channel: string, title: string, readOnly: boolean) => Promise<void>;
type Guild = { id: string; name: string };
type Channel = { id: string; name: string; can_send: boolean; slowmode_seconds: number; send_block_reason?: string | null };

export async function interactiveLogin(): Promise<Session> {
  const server = serverUrl(await input({ message: 'Relay server URL:', validate: value => {
    try { serverUrl(value); return true; } catch { return 'Enter an HTTPS origin (or HTTP loopback for local development).'; }
  } }));
  const username = await input({ message: 'Account from /register:', validate: value => value.trim() ? true : 'Enter your GuildPort account.' });
  const secret = await password({ message: 'GuildPort password:', mask: '*' });
  const result = await new Api(server).request<Omit<Session, 'server'>>('/v1/login',
    { username: username.trim(), password: secret, device: hostname() });
  const session = { ...result, server };
  await saveSession(session);
  return session;
}

export async function browse(api: Api, chat: Chat): Promise<void> {
  while (true) {
    process.stdout.write('Loading shared servers…\n');
    const { guilds } = await api.request<{ guilds: Guild[] }>('/v1/guilds');
    const guildId = await select({ message: 'Select a server', choices: [
      ...guilds.map(g => ({ name: safeText(g.name).replace(/\n/g, ' '), value: g.id, description: g.id })),
      { name: '↻ Refresh servers', value: 'refresh' }, { name: '← Main menu', value: 'back' }
    ] });
    if (guildId === 'back') return;
    if (guildId === 'refresh') continue;
    const guild = guilds.find(g => g.id === guildId)!;
    while (true) {
      const { channels } = await api.request<{ channels: Channel[] }>(`/v1/guilds/${guildId}/channels`);
      const channelId = await select({ message: `${safeText(guild.name)} — select a channel`, choices: [
        ...channels.map(c => ({
          name: `#${safeText(c.name)}${c.can_send ? '' : ' [read only]'}`,
          value: c.id,
          description: c.can_send ? `${c.id}${c.slowmode_seconds ? ` · slowmode ${c.slowmode_seconds}s` : ''}` : (c.send_block_reason ?? 'Sending is unavailable.')
        })),
        { name: '↻ Refresh channels', value: 'refresh' }, { name: '← Servers', value: 'back' }
      ] });
      if (channelId === 'back') break;
      if (channelId === 'refresh') continue;
      const channel = channels.find(c => c.id === channelId)!;
      await chat(api, channelId, `${safeText(guild.name)} / #${safeText(channel.name)}`, !channel.can_send);
    }
  }
}

export async function interactive(chat: Chat): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive mode needs a terminal. Run dcgp --help for scriptable commands.');
  process.stdout.write('\nGuildPort · Discord in your terminal\nUse ↑/↓ to select and Enter to continue.\n\n');
  let session: Session | undefined;
  try { session = await loadSession(); } catch { /* Offer login below. */ }
  while (true) {
    if (!session) {
      const action = await select({ message: 'Welcome', choices: [
        { name: 'Log in to a relay', value: 'login' }, { name: 'Exit', value: 'exit' }
      ] });
      if (action === 'exit') return;
      try { session = await interactiveLogin(); }
      catch (error) {
        if (error instanceof Error && error.name === 'ExitPromptError') throw error;
        process.stderr.write(safeText(error instanceof Error ? error.message : error) + '\n');
        continue;
      }
    }
    const api = Api.session(session);
    const action = await select({ message: `GuildPort · ${safeText(session.user.username)}`, choices: [
      { name: 'Browse servers and channels', value: 'browse' },
      { name: 'Account details', value: 'account' },
      { name: 'Log out', value: 'logout' },
      { name: 'Exit', value: 'exit' }
    ] });
    try {
      if (action === 'exit') return;
      if (action === 'browse') await browse(api, chat);
      if (action === 'account') {
        const me = await api.request<{ username: string; discord_id: string; expires_at: number }>('/v1/me');
        process.stdout.write(`${safeText(me.username)} · Discord ${me.discord_id}\nServer: ${safeText(session.server)}\nExpires: ${new Date(me.expires_at * 1000).toLocaleString()}\n`);
      }
      if (action === 'logout') {
        await api.request('/v1/logout', {});
        await clearSession();
        session = undefined;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'ExitPromptError') throw error;
      process.stderr.write(safeText(error instanceof Error ? error.message : error) + '\n');
      if (error instanceof ApiError && error.status === 401) {
        await clearSession();
        session = undefined;
      }
    }
  }
}
