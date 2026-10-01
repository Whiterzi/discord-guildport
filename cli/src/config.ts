import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Session {
  server: string;
  token: string;
  expires_at: number;
  user: { discord_id: string; username: string };
}

export function serverUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Relay server must be an HTTPS origin. HTTP is allowed only on loopback.');
  }
  return url.origin;
}

export function configPath(): string {
  const root = process.env.GUILDPORT_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'guildport');
  return join(root, 'session.json');
}

export async function saveSession(session: Session): Promise<void> {
  session.server = serverUrl(session.server);
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dirname(path), 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(session) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function loadSession(): Promise<Session> {
  let data: Session;
  try {
    data = JSON.parse(await readFile(configPath(), 'utf8'));
  } catch {
    throw new Error('No usable session. Run dcgp login first.');
  }
  if (!data || typeof data.token !== 'string' || !data.token || typeof data.expires_at !== 'number' ||
      !data.user || typeof data.user.discord_id !== 'string') {
    throw new Error('Invalid session file. Run dcgp login again.');
  }
  data.server = serverUrl(data.server);
  if (data.expires_at * 1000 <= Date.now()) throw new Error('Session expired. Run dcgp login again.');
  return data;
}

export async function clearSession(): Promise<void> {
  await unlink(configPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
