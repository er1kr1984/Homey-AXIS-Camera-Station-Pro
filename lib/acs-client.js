'use strict';

// Minimal client for AXIS Camera Station Pro's local web-client stack:
// IAM on-prem login (OAuth2 PKCE), GraphQL camera list and WebRTC signaling.

const https = require('node:https');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const WEB_CLIENT_ID = 'c916fe4d-a425-4737-8037-8beeefac6d9f';

class AcsClient {
  constructor({
    host, port = 443, apiPort = 29204, username, password, log = () => {},
  }) {
    this.host = host;
    this.port = port;
    this.apiPort = apiPort;
    this.username = username;
    this.password = password;
    this.log = log;
    this.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
    this.token = null; // { access_token, refresh_token, expiresAt }
  }

  get origin() {
    return this.port === 443 ? `https://${this.host}` : `https://${this.host}:${this.port}`;
  }

  get redirectUri() {
    return `${this.origin}/web-client?iam=builtIn`;
  }

  _request(method, path, { headers = {}, body, port = this.port } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: this.host, port, method, path, agent: this.agent, headers, timeout: 15000,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('timeout', () => req.destroy(new Error(`Timeout ${method} ${path}`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  _postForm(path, fields, headers = {}) {
    const body = new URLSearchParams(fields).toString();
    return this._request('POST', path, {
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), ...headers },
      body,
    });
  }

  _storeToken(json) {
    this.token = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || (this.token && this.token.refresh_token),
      expiresAt: Date.now() + (json.expires_in || 900) * 1000,
    };
  }

  async login() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({
      code_challenge: challenge,
      code_challenge_method: 'S256',
      client_id: WEB_CLIENT_ID,
      response_type: 'code',
      scope: 'openid offline',
      redirect_uri: this.redirectUri,
      state: crypto.randomBytes(12).toString('base64url'),
    });
    const page = await this._request('GET', `/auth/v1/authorize?${query}`);
    const sessionId = /data-auth-session-id="([^"]+)"/.exec(page.body);
    if (page.status !== 200 || !sessionId) throw new Error(`ACS login page unavailable (HTTP ${page.status})`);

    const handled = await this._postForm('/auth/v1/authorize/handle', {
      username: this.username,
      password: this.password,
      redirect_uri: this.redirectUri,
      client_id: WEB_CLIENT_ID,
      auth_session_id: sessionId[1],
    });
    const location = handled.headers.location || '';
    const code = location && new URL(location, this.origin).searchParams.get('code');
    if (!code) throw new Error('ACS login failed: check username and password');

    const tok = await this._postForm('/auth/v1/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
      client_id: WEB_CLIENT_ID,
    });
    if (tok.status !== 200) throw new Error(`ACS token exchange failed (HTTP ${tok.status})`);
    this._storeToken(JSON.parse(tok.body));
    this.log('ACS login ok');
  }

  async refresh() {
    const tok = await this._postForm('/auth/v1/token', {
      grant_type: 'refresh_token',
      refresh_token: this.token.refresh_token,
      client_id: WEB_CLIENT_ID,
    });
    if (tok.status !== 200) throw new Error(`ACS token refresh failed (HTTP ${tok.status})`);
    this._storeToken(JSON.parse(tok.body));
  }

  // Returns a valid access token, refreshing or logging in again as needed. Concurrent
  // callers share one refresh: Camera Station rotates refresh tokens, so parallel
  // refreshes with the same token would fail.
  async getAccessToken() {
    if (this.token && Date.now() < this.token.expiresAt - 60000) return this.token.access_token;
    if (!this._tokenPromise) {
      this._tokenPromise = this._renewToken().finally(() => { this._tokenPromise = null; });
    }
    return this._tokenPromise;
  }

  // Forget the current token (e.g. Camera Station rejected it) so the next call logs in.
  invalidateToken() {
    if (this.token) this.token.expiresAt = 0;
  }

  async _renewToken() {
    if (this.token && this.token.refresh_token) {
      try {
        await this.refresh();
        return this.token.access_token;
      } catch (err) {
        this.log('Refresh failed, logging in again:', err.message);
      }
    }
    await this.login();
    return this.token.access_token;
  }

  async graphql(operationName, query, variables = {}) {
    const token = await this.getAccessToken();
    const body = JSON.stringify({ operationName, query, variables });
    const res = await this._request('POST', '/api/graphql', {
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${token}`,
      },
      body,
    });
    if (res.status !== 200) throw new Error(`ACS GraphQL ${operationName} failed (HTTP ${res.status})`);
    const json = JSON.parse(res.body);
    if (json.errors && json.errors.length) throw new Error(`ACS GraphQL ${operationName}: ${json.errors[0].message}`);
    return json.data;
  }

  // Resource groups as [{ orgId, resourceGroupArn }] in the form views2 expects.
  async _resourceGroups() {
    const orgs = await this.graphql('organizations3', `query organizations3 {
      organizations3 { organizations { arn name resourceGroups { name arn } } } }`);
    const out = [];
    for (const org of orgs.organizations3.organizations) {
      const orgId = org.arn.split(':')[2];
      for (const rg of org.resourceGroups) {
        // The web client sends the resource group ARN in the "org::group" form.
        const [, , rest] = rg.arn.split(':');
        const [o, g] = rest.split('/');
        out.push({ orgId, resourceGroupArn: `arn:resource-group:${o}::${g}` });
      }
    }
    return out;
  }

  // Split views ("View", "Outdoor cameras", ...) with the cameras in each tile:
  // [{ id, name, rows, columns, tiles: [{ row, column, rowSpan, columnSpan, camera }] }]
  async listViews() {
    const views = [];
    for (const { orgId, resourceGroupArn } of await this._resourceGroups()) {
      const data = await this.graphql('listViews', `query listViews($resourceGroupArn: Arn!) {
        views2(resourceGroupArn: $resourceGroupArn) {
          __typename arn name
          ... on SplitView2 { rowCount columnCount layoutItems { row column rowSpan columnSpan viewArn } }
          ... on VideoSourceView2 { videoSource { id capabilities } }
        } }`, { resourceGroupArn });
      const byArn = new Map(data.views2.map((v) => [v.arn, v]));
      for (const v of data.views2) {
        if (v.__typename !== 'SplitView2') continue;
        const tiles = [];
        for (const item of v.layoutItems) {
          const target = item.viewArn && byArn.get(item.viewArn);
          const source = target && target.videoSource;
          if (!source || !(source.capabilities || []).includes('WEBRTC_STREAMING')) continue;
          tiles.push({
            row: item.row,
            column: item.column,
            rowSpan: item.rowSpan,
            columnSpan: item.columnSpan,
            camera: { sourceId: source.id, name: target.name, orgId, targetId: source.id.split('_')[1] },
          });
        }
        if (!tiles.length) continue;
        views.push({
          id: v.arn.split(':').pop(), name: v.name, rows: v.rowCount, columns: v.columnCount, tiles,
        });
      }
    }
    return views;
  }

  // Lists cameras that support WebRTC: [{ sourceId, name, orgId, targetId }]
  async listCameras() {
    const orgs = await this.graphql('organizations3', `query organizations3 {
      organizations3 { organizations { arn name resourceGroups { name arn } } } }`);
    const cameras = new Map();
    for (const org of orgs.organizations3.organizations) {
      const orgId = org.arn.split(':')[2];
      for (const rg of org.resourceGroups) {
        // The web client sends the resource group ARN in the "org::group" form.
        const [, , rest] = rg.arn.split(':');
        const [o, g] = rest.split('/');
        const views = await this.graphql('standaloneResourceTreeListResources', `query standaloneResourceTreeListResources($resourceGroupArn: Arn!) {
          views2(resourceGroupArn: $resourceGroupArn) {
            __typename name
            ... on VideoSourceView2 { videoSource { id capabilities } }
          } }`, { resourceGroupArn: `arn:resource-group:${o}::${g}` });
        for (const v of views.views2) {
          if (!v.videoSource || cameras.has(v.videoSource.id)) continue;
          if (!(v.videoSource.capabilities || []).includes('WEBRTC_STREAMING')) continue;
          const targetId = v.videoSource.id.split('_')[1];
          cameras.set(v.videoSource.id, { sourceId: v.videoSource.id, name: v.name, orgId, targetId });
        }
      }
    }
    return [...cameras.values()];
  }

  // POST to the documented ACS API (Basic auth, port 29204). Returns parsed JSON or null.
  async api(path, payload = {}) {
    const body = JSON.stringify(payload);
    const res = await this._request('POST', `/Acs/Api/${path}`, {
      port: this.apiPort,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
      },
      body,
    });
    let json = null;
    try { json = res.body ? JSON.parse(res.body) : null; } catch (e) { /* no body */ }
    if (res.status !== 200) {
      const reason = (json && json.Message) || res.headers['x-reason'] || `HTTP ${res.status}`;
      throw new Error(`Camera Station: ${reason}`);
    }
    return json;
  }

  // { cameraId: 'ok' | 'unauthenticated' | 'unreachable' }
  async getCameraStatuses() {
    const names = { 1: 'ok', 2: 'unauthenticated', 3: 'unreachable' };
    const out = {};
    let start = 0;
    for (;;) {
      const page = await this.api('CameraListFacade/GetCameraList', { Range: { StartIndex: start, NumberOfElements: 100 } });
      for (const c of page.Cameras || []) out[c.CameraId.Id] = names[c.Status] || 'unknown';
      if (page.ContainsLastCamera !== false || !(page.Cameras || []).length) break;
      start += page.Cameras.length;
    }
    return out;
  }

  async isRecording(cameraId) {
    const r = await this.api('RecordingControlFacade/GetRecordingStatus', { cameraId: { Id: cameraId } });
    return !!(r && r.IsRecording);
  }

  async startRecording(cameraId) {
    await this.api('RecordingControlFacade/StartRecording', { cameraId: { Id: cameraId } });
  }

  async stopRecording(cameraId) {
    await this.api('RecordingControlFacade/StopRecording', { cameraId: { Id: cameraId } });
  }

  // Bookmark at the current time; returns the bookmark id.
  async addBookmark(cameraId, name, description) {
    const payload = { CameraId: { Id: cameraId }, Name: String(name).slice(0, 255) };
    if (description) payload.Description = String(description).slice(0, 255);
    const r = await this.api('BookmarkFacade/AddBookmark', payload);
    return r && r.Id;
  }

  async getPtzPresets(cameraId) {
    const r = await this.api('PtzFacade/GetPtzPresets', { cameraId: { Id: cameraId } });
    return (Array.isArray(r) ? r : []).map((p) => ({ id: p.Id, name: p.Name }));
  }

  async gotoPtzPreset(cameraId, presetId) {
    await this.api('PtzFacade/GotoPresetId', { cameraId: { Id: cameraId }, presetId: Number(presetId) });
  }

  async hasPtz(cameraId) {
    const r = await this.api('PtzFacade/GetPtzCapabilities', { Range: { StartIndex: 0, NumberOfElements: 500 } });
    const cap = ((r && r.Capabilities) || []).find((c) => c.Camera && c.Camera.Id === cameraId);
    return !!(cap && cap.HasPtz);
  }

  // Triggers defined in Camera Station action rules ("Activate trigger" etc.).
  async trigger(action, triggerName, seconds) {
    const paths = {
      activate: 'TriggerFacade/ActivateTrigger',
      deactivate: 'TriggerFacade/DeactivateTrigger',
      pulse: 'TriggerFacade/PulseTrigger',
      activateFor: 'TriggerFacade/ActivateDeactivateTrigger',
    };
    const payload = { triggerName: String(triggerName) };
    if (action === 'activateFor') payload.deactivateAfterSeconds = String(Math.max(0, Math.round(seconds)));
    await this.api(paths[action], payload);
  }

  // Per-camera quality profiles as configured in Camera Station:
  // { cameraId: { High: {Resolution, Framerate}, Medium: {...}, Low: {...} } }
  async getCameraProfiles() {
    const body = '{}';
    const res = await this._request('POST', '/Acs/Api/ServerConfigurationFacade/GetServerConfiguration', {
      port: this.apiPort,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
      },
      body,
    });
    if (res.status !== 200) throw new Error(`ACS server configuration failed (HTTP ${res.status})`);
    const out = {};
    for (const v of JSON.parse(res.body).VideoAudioSettings || []) {
      out[v.Id.Id] = { High: v.High, Medium: v.Medium, Low: v.Low };
    }
    return out;
  }

  // JPEG snapshot through the documented ACS API (Basic auth, port 29204).
  async getSnapshot(cameraId, width = 1280, height = 720) {
    const body = JSON.stringify({ cameraIds: [{ Id: cameraId }], preferredResolution: { Width: width, Height: height } });
    const res = await this._request('POST', '/Acs/Api/SnapshotFacade/GetSnapshot', {
      port: this.apiPort,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
      },
      body,
    });
    if (res.status !== 200) throw new Error(`ACS snapshot failed (HTTP ${res.status})`);
    const snap = (JSON.parse(res.body).Snapshots || [])[0];
    if (!snap || !snap.ImageData) throw new Error('No snapshot available');
    return Buffer.from(snap.ImageData, 'base64');
  }

  // Opens one live WebRTC session. ACS sends the SDP offer; `onOffer(offer, iceServers)`
  // must return the SDP answer. Remote ICE candidates go to `onRemoteCandidate`.
  // Returns { sendCandidate(candidate), close() }.
  async startLiveSession(options) {
    try {
      return await this._startLiveSession(options);
    } catch (err) {
      // Token rejected (expired or revoked on the server): log in again and retry once.
      if (!/\b(401|403)\b/.test(err.message)) throw err;
      this.log('Signaling server rejected the token, logging in again');
      this.invalidateToken();
      if (this.token) this.token.refresh_token = null;
      return this._startLiveSession(options);
    }
  }

  async _startLiveSession({ camera, streamProfile = 'high', onOffer, onRemoteCandidate, onClose }) {
    const token = await this.getAccessToken();
    const auth = `Bearer ${token}`;
    const clientTag = crypto.randomBytes(16).toString('base64url');
    const sessionId = crypto.randomUUID();
    const corr = () => `${sessionId};${crypto.randomUUID()}:${clientTag}`;
    const url = `wss://${this.host}${this.port === 443 ? '' : `:${this.port}`}/webrtc/signal-server/client`
      + `?authorization=${encodeURIComponent(auth)}`
      + `&x-axis-correlation-id=${encodeURIComponent(`0;${crypto.randomUUID()}:${clientTag}`)}`;

    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 10000 });
    let closed = false;
    let iceServers = [];
    const close = () => {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      if (onClose) onClose();
    };
    const sendSignaling = (data, extra = {}) => ws.send(JSON.stringify({
      type: 'signaling', targetId: camera.targetId, data: { apiVersion: '1.0', sessionId, ...data }, ...extra, authorization: auth,
    }));
    const respond = (method, context) => sendSignaling({ method, type: 'response', context, data: {} }, { correlationId: corr() });

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('error', (err) => { this.log('Signaling error:', err.message); close(); });
    ws.on('close', close);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'hello') {
        const context = corr();
        ws.send(JSON.stringify({
          type: 'initSession',
          targetId: camera.targetId,
          orgId: camera.orgId,
          data: {
            apiVersion: '1.0', context, method: 'initSession', type: 'request', sessionId,
            params: {
              authorization: auth,
              source: camera.sourceId,
              videoReceive: { streamProfile, codecPreference: ['H264'] },
              type: 'live',
            },
          },
          correlationId: context,
          authorization: auth,
        }));
        return;
      }
      if (msg.type === 'initSession') {
        iceServers = (msg.turnServers || []).map((t) => ({ urls: t.urls, username: t.username, credential: t.password }))
          .concat((msg.stunServers || []).map((s) => ({ urls: s.urls })));
        return;
      }
      if (msg.type === 'error' || (msg.data && msg.data.type === 'error')) {
        this.log('Signaling error message:', JSON.stringify(msg).slice(0, 500));
        close();
        return;
      }
      if (msg.type !== 'signaling' || !msg.data) return;
      const { method, type, params, context } = msg.data;
      if (type !== 'request') return;
      try {
        if (method === 'setSdpOffer') {
          respond('setSdpOffer', context || '');
          const answer = await onOffer(params.sdp, iceServers);
          const ctx = corr();
          sendSignaling({ context: ctx, method: 'setSdpAnswer', type: 'request', params: { type: 'answer', sdp: answer } }, { correlationId: ctx });
        } else if (method === 'addIceCandidate') {
          respond('addIceCandidate', context);
          if (onRemoteCandidate) await onRemoteCandidate(params);
        } else {
          respond(method, context);
        }
      } catch (err) {
        this.log(`Failed handling ${method}:`, err.message);
        close();
      }
    });

    ws.send(JSON.stringify({ type: 'hello', id: null, correlationId: `hello;${crypto.randomUUID()}:0;${crypto.randomUUID()}:${clientTag}` }));

    return {
      sessionId,
      sendCandidate: (cand) => {
        if (closed) return;
        const ctx = corr();
        sendSignaling({ context: ctx, method: 'addIceCandidate', type: 'request', params: cand }, { correlationId: ctx });
      },
      close,
    };
  }
}

module.exports = AcsClient;
