import { input, password } from '@inquirer/prompts';
import { hostname } from 'node:os';
import { Api, ApiError } from './api.js';
import { clearSession, loadSession, saveSession, serverUrl, type Session } from './config.js';
import { safeText } from './output.js';
import { menu } from './menu.js';

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
  let lastGuild: string|undefined;
  const lastChannels=new Map<string,string>();
  while (true) {
    let guilds: Guild[]=[];
    const guildId = await menu({title:'Select a server',path:'Home › Servers',search:true,
      subtitle:'Servers you can access',backLabel:'main menu',selected:lastGuild,
      empty:'No shared servers. Ask an admin to enable a channel with /relay enable.',
      items:async signal=>{
        ({guilds}=await api.request<{guilds:Guild[]}>('/v1/guilds',undefined,signal));
        return [...guilds.map(g=>({name:g.name,value:g.id,description:'Open the channels available to your account.'})),
          {name:'↻ Refresh servers',value:'refresh',action:true},{name:'← Main menu',value:'back',action:true}];
      }});
    if (guildId === 'back') return;
    if (guildId === 'refresh') continue;
    const guild = guilds.find(g => g.id === guildId)!;
    lastGuild=guildId;
    while (true) {
      let channels: Channel[]=[];
      const channelId = await menu({title:'Select a channel',path:`Home › Servers › ${safeText(guild.name)}`,
        subtitle:'Enabled text channels',search:true,backLabel:'servers',selected:lastChannels.get(guildId),
        empty:'No accessible channels. Ask an admin about /relay enable.',
        items:async signal=>{
          ({channels}=await api.request<{channels:Channel[]}>(`/v1/guilds/${guildId}/channels`,undefined,signal));
          return [...channels.map(c=>({name:`#${safeText(c.name)}${c.can_send?'':'  [read only]'}`,value:c.id,
            description:c.can_send?`Read and send messages${c.slowmode_seconds?` · slowmode ${c.slowmode_seconds}s`:''}. Enter opens chat.`
              :(c.send_block_reason??'Sending is unavailable. You can still read messages.')})),
            {name:'↻ Refresh channels',value:'refresh',action:true},{name:'← Servers',value:'back',action:true}];
        }});
      if (channelId === 'back') break;
      if (channelId === 'refresh') continue;
      const channel = channels.find(c => c.id === channelId)!;
      lastChannels.set(guildId,channelId);
      await chat(api, channelId, `${safeText(guild.name)} / #${safeText(channel.name)}`, !channel.can_send);
    }
  }
}

export async function interactive(chat: Chat): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM==='dumb') throw new Error('Interactive mode needs a terminal. Run dcgp --help for scriptable commands.');
  let session: Session | undefined;
  try { session = await loadSession(); } catch { /* Offer login below. */ }
  while (true) {
    if (!session) {
      const action = await menu({title:'Welcome',subtitle:'Discord in your terminal',back:'exit',backLabel:'exit',items:[
        {name:'Log in to a relay',value:'login',description:'Use /register in Discord to create your GuildPort account.'},
        {name:'Exit',value:'exit',action:true}]});
      if (action === 'exit') return;
      try { session = await interactiveLogin(); }
      catch (error) {
        if (error instanceof Error && error.name === 'ExitPromptError') throw error;
        await showError(error);
        continue;
      }
    }
    const api = Api.session(session);
    const action = await menu({title:'Home',subtitle:session.server,back:'exit',backLabel:'exit',items:[
      {name:'Browse servers and channels',value:'browse',description:'Select a server, then a channel. Esc returns one level.'},
      {name:'Account details',value:'account',description:'View your account, relay and session expiry.'},
      {name:'Log out',value:'logout',description:'Revoke this device session and remove its saved login.'},
      {name:'Exit',value:'exit',action:true}]});
    try {
      if (action === 'exit') return;
      if (action === 'browse') await browse(api, chat);
      if (action === 'account') {
        const server=session.server;
        await menu({title:'Account details',path:'Home › Account',subtitle:server,backLabel:'main menu',items:async signal=>{
          const me=await api.request<{username:string;discord_id:string;expires_at:number}>('/v1/me',undefined,signal);
          return [{name:'← Main menu',value:'back',action:true,
            description:`${me.username} · Discord ${me.discord_id} · Expires: ${new Date(me.expires_at*1000).toLocaleString()}`}];
        }});
      }
      if (action === 'logout') {
        await api.request('/v1/logout', {});
        await clearSession();
        session = undefined;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'ExitPromptError') throw error;
      await showError(error);
      if (error instanceof ApiError && error.status === 401) {
        await clearSession();
        session = undefined;
      }
    }
  }
}

async function showError(error:unknown):Promise<void> {
  await menu({title:'Unable to continue',backLabel:'back',items:[{name:'← Back',value:'back',action:true,
    description:safeText(error instanceof Error?error.message:error)}]});
}
