import asyncio
import json
from pathlib import Path
import re
import tempfile
import unittest
import uuid

from aiohttp import CookieJar
from aiohttp.test_utils import TestClient, TestServer

from guildport.server import RelayService
from guildport.store import Store
from test_relay import FakeAdapter, ENCODED, PASSWORD, USER, GUILD, CHANNEL


class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'state' / 'relay.sqlite3')
        self.store.register(USER, ENCODED)
        self.store.enable(GUILD, CHANNEL, USER)
        self.adapter = FakeAdapter()
        self.service = RelayService(self.store, self.adapter, heartbeat=0.03, read_recheck_seconds=0)
        self.client = TestClient(TestServer(self.service.application()), cookie_jar=CookieJar(unsafe=True))
        await self.client.start_server()
        self.origin = str(self.client.make_url('')).rstrip('/')
        self.service.browser.configure(self.origin)
        self.headers = {'Origin': self.origin, 'X-GuildPort-Client': 'web', 'Sec-Fetch-Site': 'same-origin'}

    async def asyncTearDown(self):
        await self.client.close()
        self.store.close()
        self.tmp.cleanup()

    async def login(self, headers=None):
        return await self.client.post('/web-api/login', headers=self.headers if headers is None else headers,
                                      json={'username': 'gp_300', 'password': PASSWORD})

    async def test_static_shell_is_public_but_only_built_assets_are_served(self):
        response = await self.client.get('/')
        self.assertEqual(response.status, 200)
        self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
        self.assertNotIn('unsafe-inline', response.headers['Content-Security-Policy'])
        self.assertIn("img-src 'self' data: https:; media-src https:;", response.headers['Content-Security-Policy'])
        self.assertIn("connect-src 'self';", response.headers['Content-Security-Policy'])
        self.assertEqual(response.headers['Referrer-Policy'], 'no-referrer')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        html = await response.text()
        path = re.search(r'src="(/assets/[^\"]+\.js)"', html).group(1)
        asset = await self.client.get(path)
        self.assertEqual(asset.status, 200)
        for path in ('/assets/.env', '/assets/package.json', '/assets/index.js.map', '/assets/..%2F..%2Fstore.py'):
            self.assertNotEqual((await self.client.get(path)).status, 200)

    async def test_login_cookie_is_http_only_and_body_never_contains_token(self):
        response = await self.login()
        self.assertEqual(response.status, 200)
        result = await response.json()
        self.assertNotIn('token', result)
        self.assertNotIn('password', result)
        cookie = response.cookies['guildport_session']
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Strict')
        self.assertFalse(cookie['domain'])
        self.assertFalse(cookie['max-age'])
        me = await self.client.get('/web-api/me', headers=self.headers)
        self.assertEqual((await me.json())['discord_id'], USER)
        row = self.store.db.execute('SELECT device FROM sessions').fetchone()
        self.assertEqual(row['device'], 'Browser')

    async def test_https_cookie_uses_host_prefix_even_behind_loopback_proxy(self):
        self.service.browser.configure('https://relay.example.com')
        headers = dict(self.headers, Origin='https://relay.example.com')
        response = await self.login(headers)
        cookie = response.cookies['__Host-guildport_session']
        self.assertTrue(cookie['secure'])
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['path'], '/')
        self.assertFalse(cookie['domain'])

    async def test_cross_origin_simple_requests_and_missing_origin_cannot_login(self):
        for headers in ({}, {'Origin': self.origin}, {'X-GuildPort-Client': 'web'},
                        dict(self.headers, Origin='https://evil.example'), dict(self.headers, Origin='null'),
                        dict(self.headers, **{'Sec-Fetch-Site': 'same-site'})):
            response = await self.login(headers)
            self.assertEqual(response.status, 403, headers)
            self.assertNotIn('Access-Control-Allow-Origin', response.headers)
        response = await self.client.options('/web-api/login', headers={'Origin': 'https://evil.example',
            'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-GuildPort-Client'})
        self.assertEqual(response.status, 403)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)

    async def test_browser_auth_does_not_enable_cookie_auth_on_cli_api_or_query_tokens(self):
        response = await self.login()
        token = response.cookies['guildport_session'].value
        self.assertEqual((await self.client.get('/v1/me')).status, 401)
        self.client.session.cookie_jar.clear()
        for headers, path in ((self.headers, '/web-api/me?token='+token),
                              (dict(self.headers, Authorization='Bearer '+token), '/web-api/me')):
            self.assertEqual((await self.client.get(path, headers=headers)).status, 401)
        response = await self.client.get('/v1/me', headers={'Authorization': 'Bearer '+token})
        self.assertEqual(response.status, 200)

    async def test_send_history_and_guilds_use_same_permission_checks(self):
        await self.login()
        response = await self.client.get('/web-api/guilds', headers=self.headers)
        self.assertEqual((await response.json())['guilds'][0]['id'], GUILD)
        payload = {'content':'browser message', 'request_id':str(uuid.uuid4())}
        response = await self.client.post('/web-api/channels/200/messages', headers=self.headers, json=payload)
        self.assertEqual(response.status, 201)
        self.assertEqual(self.adapter.sent, [(USER, 'browser message')])
        # Cross-origin requests are blocked even with a valid session cookie.
        evil = dict(self.headers, Origin='https://evil.example')
        response = await self.client.post('/web-api/channels/200/messages', headers=evil, json=payload)
        self.assertEqual(response.status, 403)
        self.adapter.revoke_on_history = True
        response = await self.client.get('/web-api/channels/200/messages', headers=self.headers)
        self.assertEqual(response.status, 403)
        self.assertNotIn('private message', await response.text())

    async def test_browser_and_cli_share_rate_limits(self):
        await self.login()
        for _ in range(120):
            self.service.limits.check('api:'+USER, 120, 60)
        response = await self.client.get('/web-api/me', headers=self.headers)
        self.assertEqual(response.status, 429)

    async def test_login_rotates_session_logout_revokes_and_clears_cookie(self):
        first = await self.login()
        old = first.cookies['guildport_session'].value
        await self.login()
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM sessions').fetchone()[0], 1)
        response = await self.client.get('/v1/me', headers={'Authorization':'Bearer '+old})
        self.assertEqual(response.status, 401)
        response = await self.client.post('/web-api/logout', headers=self.headers, json={})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.cookies['guildport_session']['max-age'], '0')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
        self.assertEqual((await self.client.get('/web-api/me', headers=self.headers)).status, 401)
        self.assertEqual((await self.client.post('/web-api/logout', headers=self.headers, json={})).status, 200)

    async def test_logout_all_revokes_browser_stream_and_cli_session(self):
        token, _ = self.store.session(USER, 'CLI')
        await self.login()
        stream = await self.client.get('/web-api/channels/200/events', headers=self.headers)
        self.assertIn(b'event: ready', await stream.content.readuntil(b'\n\n'))
        await self.client.post('/web-api/logout-all', headers=self.headers, json={})
        frame = await asyncio.wait_for(stream.content.readuntil(b'\n\n'), 2)
        self.assertIn(b'event: revoked', frame)
        self.assertEqual((await self.client.get('/v1/me', headers={'Authorization':'Bearer '+token})).status, 401)
        stream.close()

    async def test_web_disabled_and_insecure_origins_rejected(self):
        self.service.browser.origin = None
        self.assertEqual((await self.login()).status, 404)
        self.assertEqual((await self.client.get('/')).status, 404)
        for origin in ('http://public.example', 'https://example.com/path', 'https://user:password@example.com'):
            with self.assertRaises(ValueError):
                self.service.browser.configure(origin)
