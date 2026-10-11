'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomInt } = require('node:crypto');

const SITES = Object.freeze({ chatgpt: 'chatgpt', claude: 'claude', gemini: 'gemini' });
const BODY_LIMIT = 2 * 1024 * 1024;
const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 30;

function extensionOrigin(value) {
  return typeof value === 'string' && /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(value);
}

function localHost(value) { return typeof value === 'string' && /^127\.0\.0\.1(?::\d+)?$/.test(value); }

function sendJson(res, status, body, corsOrigin = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function createExtApi(options) {
  const {
    userDataPath, authenticateClientToken, getClientProfile, getMcpClientProfile,
    createToken, revokeToken, searchMemoriesForClient, addMemory, recordProxyEvent, isTokenActive = () => true,
    emitRetrieved = () => {}, emitAdded = () => {}, now = Date.now,
    importText = async (...args) => (await import('../src/lib/importers.js')).parseImportText(...args)
  } = options;
  const originsPath = path.join(userDataPath, 'extension-origins.json');
  const readOrigins = () => { try { return JSON.parse(fs.readFileSync(originsPath, 'utf8')); } catch { return {}; } };
  const saveOrigins = (origins) => {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(originsPath, `${JSON.stringify(origins, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(originsPath, 0o600);
  };
  let pairing = null;
  const rateLimits = new Map();

  function createPairCode() {
    const code = String(randomInt(100000, 1_000_000));
    pairing = { code, expiresAt: now() + 120_000, attempts: 0 };
    return { code, expiresAt: pairing.expiresAt };
  }

  async function revokeSite(site) {
    if (!Object.hasOwn(SITES, site)) throw new Error('Unsupported extension site.');
    const client = `ext:${site}`;
    revokeToken(client);
    const origins = readOrigins();
    if (origins[site]) { origins[site] = { ...origins[site], revokedAt: new Date(now()).toISOString() }; saveOrigins(origins); }
    return { site, revoked: true };
  }

  async function rotateSite(site) {
    await revokeSite(site);
    return createPairCode();
  }

  function status() {
    const origins = readOrigins();
    return Object.keys(SITES).map((site) => {
      const profile = getClientProfile(`ext:${site}`);
      const active = Boolean(origins[site] && isTokenActive(`ext:${site}`));
      return { site, paired: active, origin: origins[site]?.origin || null,
        label: origins[site]?.label || null, status: profile?.status || 'unpaired', active };
    });
  }

  async function readJson(req) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) { req.resume?.(); throw Object.assign(new Error('Request body is too large.'), { status: 413 }); }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) { req.resume?.(); throw Object.assign(new Error('Request body is too large.'), { status: 413 }); }
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_object');
      return value;
    }
    catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
  }

  function log(client, { ok, count = 0, error = null, latency = 0 } = {}, memoryIds = []) {
    try { recordProxyEvent({ client, provider: 'extension', query: '', memories_injected: count, latency_ms: latency, ok, error }, memoryIds); } catch {}
  }

  async function pair(req, res, origin) {
    const started = now();
    const body = await readJson(req);
    if (!extensionOrigin(origin) || body.origin !== origin || !Object.hasOwn(SITES, body.site)) {
      log(`ext:${Object.hasOwn(SITES, body.site) ? body.site : 'pair'}`, { ok: false, error: 'pair_origin_or_site', latency: now() - started });
      return sendJson(res, 403, { error: 'Pairing origin or site is invalid.' }, extensionOrigin(origin) ? origin : null);
    }
    if (!pairing || now() >= pairing.expiresAt) {
      pairing = null;
      log(`ext:${body.site}`, { ok: false, error: 'pair_code_expired', latency: now() - started });
      return sendJson(res, 401, { error: 'Pairing code expired. Generate a new code in One Brain.' }, origin);
    }
    if (pairing.attempts >= 5) {
      pairing = null;
      return sendJson(res, 429, { error: 'Pairing attempt limit reached.' }, origin);
    }
    if (String(body.code || '') !== pairing.code) {
      pairing.attempts += 1;
      const exhausted = pairing.attempts >= 5;
      if (exhausted) pairing = null;
      log(`ext:${body.site}`, { ok: false, error: exhausted ? 'pair_attempt_limit' : 'pair_code_invalid', latency: now() - started });
      return sendJson(res, exhausted ? 429 : 401, { error: exhausted ? 'Pairing attempt limit reached.' : 'Pairing code is incorrect.' }, origin);
    }
    const site = body.site;
    const client = `ext:${site}`;
    const label = String(body.label || `One Brain ${site} extension`).slice(0, 120);
    const profile = getMcpClientProfile(client, { verified: true, reported_name: label, eventClient: client });
    const token = await createToken(client);
    const origins = readOrigins();
    origins[site] = { origin, label, pairedAt: new Date(now()).toISOString() };
    try { saveOrigins(origins); }
    catch (error) { revokeToken(client); throw error; }
    pairing = null;
    log(client, { ok: true, latency: now() - started });
    return sendJson(res, 200, { token, site, status: profile?.status || 'pending' }, origin);
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/ext/')) return false;
    const origin = req.headers.origin || '';
    if (!localHost(req.headers.host)) return sendJson(res, 403, { error: 'Only the 127.0.0.1 host is accepted.' });
    const origins = readOrigins();
    const allowedOrigin = Object.values(origins).some((entry) => entry.origin === origin);
    const pairingOrigin = url.pathname === '/ext/pair' && extensionOrigin(origin);
    if (req.method === 'OPTIONS' && !allowedOrigin && !pairingOrigin) {
      log('ext:unknown', { ok: false, error: 'origin_denied' });
      return sendJson(res, 403, { error: 'This extension origin is not paired.' });
    }
    if (req.method === 'OPTIONS') return sendJson(res, 204, {}, origin);
    if (url.pathname === '/ext/pair' && req.method === 'POST') {
      if (!extensionOrigin(origin)) return sendJson(res, 403, { error: 'Pairing requires a browser extension origin.' });
      return pair(req, res, origin);
    }

    const started = now();
    const auth = /^Bearer ([a-f\d]{64})$/i.exec(req.headers.authorization || '');
    const identity = auth ? authenticateClientToken(auth[1]) : null;
    if (!identity || !/^ext:(chatgpt|claude|gemini)$/.test(identity.client)) {
      log(identity?.client || 'ext:unknown', { ok: false, error: 'unauthorized', latency: now() - started });
      return sendJson(res, 401, { error: 'A valid, active extension token is required.' }, allowedOrigin ? origin : null);
    }
    const site = identity.client.slice(4);
    const savedOrigin = readOrigins()[site]?.origin;
    if (!savedOrigin || savedOrigin !== origin || !allowedOrigin) {
      log(identity.client, { ok: false, error: 'origin_or_pairing_denied', latency: now() - started });
      return sendJson(res, 401, { error: 'This extension token is unpaired or revoked.' });
    }
    const tokenId = createHash('sha256').update(auth[1]).digest('hex');
    const time = now();
    if (rateLimits.size > 2000) for (const [key, entry] of rateLimits) if (time >= entry.startedAt + WINDOW_MS) rateLimits.delete(key);
    const window = rateLimits.get(tokenId);
    if (!window || time >= window.startedAt + WINDOW_MS) rateLimits.set(tokenId, { startedAt: time, count: 1 });
    else if (window.count >= REQUEST_LIMIT) {
      log(identity.client, { ok: false, error: 'rate_limited', latency: now() - started });
      return sendJson(res, 429, { error: 'Extension request limit reached. Try again in a minute.' }, origin);
    } else window.count += 1;

    const profile = getClientProfile(identity.client);
    if (!profile || profile.status === 'blocked') {
      log(identity.client, { ok: false, error: 'client_revoked', latency: now() - started });
      return sendJson(res, 401, { error: 'This extension token is revoked.' }, origin);
    }
    if (profile.status !== 'approved') {
      log(identity.client, { ok: false, error: 'client_pending', latency: now() - started });
      return sendJson(res, 403, { error: 'Approve this extension in One Brain before using it.' }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/ext/ping') {
      log(identity.client, { ok: true, latency: now() - started });
      return sendJson(res, 200, { ok: true, site, status: profile.status }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/ext/unpair') {
      await revokeSite(site);
      log(identity.client, { ok: true, latency: now() - started });
      return sendJson(res, 200, { ok: true, unpaired: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/ext/search') {
      const body = await readJson(req);
      const query = String(body.query || '').trim().slice(0, 4000);
      const limit = Math.max(1, Math.min(10, Math.floor(Number(body.limit) || 5)));
      const result = query ? await searchMemoriesForClient(query, 'all', limit, profile) : { memories: [] };
      const memories = (result.memories || []).filter((memory) => !memory.private && profile.allowedSources?.includes(memory.source)).map((memory) => ({
        id: memory.id, source: memory.source, title: memory.title || 'Untitled memory',
        snippet: String(memory.content || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        score: Number.isFinite(Number(memory.score)) ? Number(memory.score) : 0
      }));
      emitRetrieved(memories.map((memory) => memory.id));
      log(identity.client, { ok: true, count: memories.length, latency: now() - started }, memories.map((memory) => memory.id));
      return sendJson(res, 200, { memories }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/ext/save') {
      const body = await readJson(req);
      if (body.site !== site || !['message', 'chat'].includes(body.kind) || typeof body.text !== 'string' || !body.text.trim()) {
        log(identity.client, { ok: false, error: 'invalid_save', latency: now() - started });
        return sendJson(res, 400, { error: 'A valid site, kind, and text are required.' }, origin);
      }
      const title = String(body.title || `Saved from ${site}`).trim().slice(0, 200) || `Saved from ${site}`;
      const memory = addMemory({ source: site, title, content: body.text.trim() }, { handAdded: true });
      if (memory?.id != null) emitAdded(memory.id);
      log(identity.client, { ok: true, count: memory?.id == null ? 0 : 1, latency: now() - started }, memory?.id == null ? [] : [memory.id]);
      return sendJson(res, 200, { ok: true, id: memory?.id ?? null, source: site }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/ext/save-chat') {
      const body = await readJson(req);
      if (body.site !== site || !Array.isArray(body.messages) || body.messages.length > 1000) {
        log(identity.client, { ok: false, error: 'invalid_chat', latency: now() - started });
        return sendJson(res, 400, { error: 'A valid site and message list are required.' }, origin);
      }
      const includeAssistant = body.includeAssistant === true;
      const messages = body.messages.filter((message) => message && typeof message.text === 'string' &&
        (message.role === 'user' || message.role === 'human' || (includeAssistant && ['assistant', 'model'].includes(message.role))));
      const transcript = messages.map((message) => `${message.role}: ${message.text}`).join('\n\n');
      const parsed = await importText(transcript, 'Browser chat.txt', false, true);
      if (!parsed.items?.length) {
        log(identity.client, { ok: true, latency: now() - started });
        return sendJson(res, 200, { ok: true, inserted: 0, ids: [] }, origin);
      }
      const baseTitle = String(body.title || `Saved ${site} chat`).trim().slice(0, 160) || `Saved ${site} chat`;
      const memories = parsed.items.map((item) => addMemory({ source: site, title: item.title === 'Browser chat' ? baseTitle : `${baseTitle}${parsed.items.length > 1 ? ` (part ${parsed.items.indexOf(item) + 1}/${parsed.items.length})` : ''}`, content: item.content }, { handAdded: true }));
      const ids = memories.map((memory) => memory.id).filter((id) => id != null);
      for (const id of ids) emitAdded(id);
      log(identity.client, { ok: true, count: ids.length, latency: now() - started }, ids);
      return sendJson(res, 200, { ok: true, inserted: ids.length, ids, source: site }, origin);
    }
    log(identity.client, { ok: false, error: 'not_found', latency: now() - started });
    return sendJson(res, 404, { error: 'Unsupported extension endpoint.' }, origin);
  }

  async function handle(req, res) {
    const origin = req.headers.origin || '';
    try { return await handleRequest(req, res); }
    catch (error) {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const origins = readOrigins();
      const corsOrigin = Object.values(origins).some((entry) => entry.origin === origin) || (pathname === '/ext/pair' && extensionOrigin(origin)) ? origin : null;
      const statusCode = Number(error?.status) || 500;
      log('ext:unknown', { ok: false, error: statusCode === 413 ? 'body_too_large' : 'request_error' });
      return sendJson(res, statusCode, { error: statusCode < 500 ? error.message : 'Local extension request failed.' }, corsOrigin);
    }
  }

  return { handle, createPairCode, status, revokeSite, rotateSite };
}

module.exports = { SITES, BODY_LIMIT, REQUEST_LIMIT, extensionOrigin, localHost, createExtApi };
