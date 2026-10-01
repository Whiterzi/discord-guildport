import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Api, ApiError, id } from '../dist/api.js';
import { serverUrl, saveSession, loadSession, clearSession, configPath } from '../dist/config.js';
import { safeText } from '../dist/output.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = fileURLToPath(new URL('../dist/main.js', import.meta.url));

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function run(args, config, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: { ...process.env, GUILDPORT_CONFIG_DIR: config }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', chunk => out += chunk);
    child.stderr.on('data', chunk => err += chunk);
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

test('server URLs prevent cleartext credentials and embedded URL authentication', () => {
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/a',
    'https://example.com?token=x', 'ftp://localhost', 'https://example.com#fragment']) {
    assert.throws(() => serverUrl(value));
  }
  assert.equal(serverUrl('https://relay.example/'), 'https://relay.example');
  assert.equal(serverUrl('http://127.0.0.1:8769'), 'http://127.0.0.1:8769');
});

test('snowflakes never pass through a JS number', () => {
  assert.equal(id('18446744073709551615'), '18446744073709551615');
  for (const value of ['18446744073709551616', '0', '01', '../x', '123?x']) assert.throws(() => id(value));
});

test('terminal controls and bidi escapes cannot execute from Discord content', () => {
  const text = safeText('\x1b[2J\x1b]52;c;c2VjcmV0\x07\r\u009b1A\u202ehello\u2066');
  assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
});

test('tokens are not forwarded through HTTP redirects', async t => {
  let stolen = false;
  const destination = await fixture(t, (request, response) => { stolen = true; response.end('{}'); });
  const origin = await fixture(t, (request, response) => { response.writeHead(302, { Location: destination }); response.end(); });
  await assert.rejects(new Api(origin, 'private-test-token').request('/v1/me'));
  assert.equal(stolen, false);
});

test('API error retains status/code without exposing credentials', async t => {
  const origin = await fixture(t, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer private-test-token');
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'cannot_send', message: 'Read only' } }));
  });
  await assert.rejects(new Api(origin, 'private-test-token').request('/v1/me'),
    error => error instanceof ApiError && error.status === 403 && error.code === 'cannot_send');
});

test('SSE parser handles chunk boundaries and heartbeat frames', async t => {
  const origin = await fixture(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: rea');
    setTimeout(() => {
      response.write('dy\ndata: {}\n\n: heartbeat\n\nevent: relay\ndata: {"type":"message.deleted",');
      response.end('"message_id":"123"}\n\n');
    }, 10);
  });
  const events = [];
  for await (const event of new Api(origin, 'test-token').events('200', new AbortController().signal)) events.push(event);
  assert.deepEqual(events.map(e => e.event), ['ready', 'relay']);
  assert.equal(events[1].data.message_id, '123');
});

test('session file is private, persisted, and removable', async t => {
  await mkdir(join(root, 'tmp'), { recursive: true });
  const dir = await mkdtemp(join(root, 'tmp', 'cli-session-'));
  const old = process.env.GUILDPORT_CONFIG_DIR;
  process.env.GUILDPORT_CONFIG_DIR = dir;
  t.after(async () => { if (old === undefined) delete process.env.GUILDPORT_CONFIG_DIR; else process.env.GUILDPORT_CONFIG_DIR = old; await rm(dir, { recursive: true, force: true }); });
  const session = { server: 'https://relay.example', token: 'test-token', expires_at: Date.now()/1000+100,
    user: { discord_id: '300', username: 'gp_300' } };
  await saveSession(session);
  assert.deepEqual(await loadSession(), session);
  if (process.platform !== 'win32') assert.equal((await stat(configPath())).mode & 0o777, 0o600);
  await clearSession();
  await assert.rejects(loadSession(), /login/);
});

test('CLI login, listing, send and logout run end-to-end against Python relay', { timeout: 30_000 }, async t => {
  await mkdir(join(root, 'tmp'), { recursive: true });
  const config = await mkdtemp(join(root, 'tmp', 'cli-e2e-'));
  const python = process.env.GUILDPORT_TEST_PYTHON ?? join(root, '.venv', 'bin', 'python');
  const child = spawn(python, [join(root, 'examples', 'demo.py')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => stderr += chunk);
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'close').catch(() => {});
    await rm(config, { recursive: true, force: true });
  });
  const info = await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Demo exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) {
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
  });
  let result = await run(['login', '--server', info.url, '--username', info.username, '--password-stdin'], config, info.password+'\n');
  assert.equal(result.code, 0, result.err);
  assert.doesNotMatch(result.out, new RegExp(info.password));
  result = await run(['guilds', '--json'], config);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).guilds[0].id, '100');
  result = await run(['channels', '100', '--json'], config);
  assert.equal(JSON.parse(result.out).channels[0].id, '200');
  result = await run(['send', '200', 'CLI integration works'], config);
  assert.equal(result.code, 0, result.err);
  result = await run(['history', '200', '--json'], config);
  assert.equal(JSON.parse(result.out).messages.at(-1).content, 'CLI integration works');
  const stored = JSON.parse(await readFile(join(config, 'session.json'), 'utf8'));
  result = await run(['logout'], config);
  assert.equal(result.code, 0, result.err);
  await assert.rejects(new Api(info.url, stored.token).request('/v1/me'), error => error.status === 401);
  result = await run(['guilds'], config);
  assert.equal(result.code, 1);
});
