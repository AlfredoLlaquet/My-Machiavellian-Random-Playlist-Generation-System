/* YouTube Random Sample 1.0.1 — self-contained, no external dependencies. */
function makeSamplerCore(deps) {
  'use strict';
  const fail = (message) => {
    throw new Error(message);
  };
  const checkpoint = () => {
    if (deps.cancelled?.()) fail('Stopped.');
  };
  const say = (message) => deps.progress?.(message);
  const textOf = (value) =>
    typeof value === 'string' ? value : value?.simpleText || value?.runs?.map((r) => r.text || '').join('') || '';

  function find(node, key, found = []) {
    if (!node || typeof node !== 'object') return found;
    if (Object.prototype.hasOwnProperty.call(node, key)) found.push(node[key]);
    for (const value of Object.values(node)) find(value, key, found);
    return found;
  }

  function sourceId(value) {
    let id = String(value).trim();
    if (/^https?:\/\//i.test(id)) {
      const url = new URL(id);
      if (
        !['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(
          url.hostname
        )
      )
        fail('Use a YouTube playlist address.');
      id = url.searchParams.get('list') || '';
    }
    if (!/^[A-Za-z0-9_-]{2,150}$/.test(id)) fail('Enter a playlist address containing list=, or a playlist ID.');
    if (id.startsWith('RD'))
      fail('YouTube Mixes change as they play. Choose a saved playlist with a fixed video list.');
    return id;
  }

  function unpack(scope) {
    const rows = [],
      tokens = [];
    if (!Array.isArray(scope.contents))
      fail('YouTube returned an unfamiliar playlist layout. Nothing further was changed.');
    for (const item of scope.contents) {
      if (item.playlistVideoRenderer) {
        const r = item.playlistVideoRenderer;
        const id = r.videoId || '';
        const title = textOf(r.title);
        const endpoint = r.navigationEndpoint?.watchEndpoint;
        const unavailable =
          !/^[A-Za-z0-9_-]{11}$/.test(id) ||
          r.isPlayable === false ||
          /^(\[?)(private video|deleted video|unavailable video)(\]?)$/i.test(title.trim()) ||
          (r.isPlayable !== true && endpoint?.videoId !== id);
        rows.push({ id, title: title || id, available: !unavailable });
      } else if (item.continuationItemRenderer) {
        const commands = find(item.continuationItemRenderer, 'continuationCommand');
        if (!commands.length || commands.some((c) => !c.token))
          fail('The playlist continuation could not be read.');
        tokens.push(...commands.map((c) => c.token));
      } else if (!item.messageRenderer) {
        fail('YouTube returned an unsupported playlist entry. Stopped to avoid sampling an incomplete list.');
      }
    }
    for (const entry of scope.continuations || []) {
      const token = entry.nextContinuationData?.continuation;
      if (!token) fail('An unsupported continuation was returned.');
      tokens.push(token);
    }
    const unique = [...new Set(tokens)];
    if (unique.length > 1) fail('The playlist returned ambiguous pagination. Nothing further was changed.');
    return { rows, next: unique[0] || null };
  }
  async function readPlaylist(id, label = 'Reading source') {
    checkpoint();
    let json = await deps.post('browse', { browseId: 'VL' + id });
    const errors = find(json.alerts, 'alertRenderer').filter((a) => a.type === 'ERROR');
    if (errors.length) fail(textOf(errors[0].text) || 'YouTube could not open this playlist.');
    const lists = find(json.contents, 'playlistVideoListRenderer').filter(
      (r) => !r.playlistId || r.playlistId === id
    );
    if (lists.length !== 1)
      fail('The playlist could not be read. Check the address and access in the selected YouTube account.');
    let scope = lists[0];
    const targetId = scope.targetId || 'playlist-video-list';
    const rows = [],
      seen = new Set();
    for (let page = 0; page < 1000; page++) {
      checkpoint();
      const parsed = unpack(scope);
      rows.push(...parsed.rows);
      say(label + ': ' + rows.length.toLocaleString() + ' entries');
      if (!parsed.next) return rows;
      if (seen.has(parsed.next)) fail('YouTube repeated a playlist page. Stopped to avoid an incomplete sample.');
      seen.add(parsed.next);
      json = await deps.post('browse', { continuation: parsed.next });
      const legacy = json.continuationContents?.playlistVideoListContinuation;
      if (legacy) {
        scope = legacy;
        continue;
      }
      const actions = [
        ...find(json.onResponseReceivedActions, 'appendContinuationItemsAction'),
        ...find(json.onResponseReceivedEndpoints, 'appendContinuationItemsAction'),
        ...find(json.onResponseReceivedCommands, 'appendContinuationItemsAction')
      ];
      let matches = actions.filter((a) => a.targetId === targetId);
      if (!matches.length) matches = actions.filter((a) => !a.targetId && Array.isArray(a.continuationItems));
      if (matches.length !== 1)
        fail('The next playlist page could not be identified. Nothing further was changed.');
      scope = { contents: matches[0].continuationItems };
    }
    fail('The playlist did not finish loading. Nothing further was changed.');
  }

  function uniqueAvailable(rows) {
    const videos = new Map();
    let unavailable = 0,
      duplicates = 0;
    for (const row of rows) {
      if (!row.available) {
        unavailable++;
        continue;
      }
      if (videos.has(row.id)) {
        duplicates++;
        continue;
      }
      videos.set(row.id, row);
    }
    return { videos: [...videos.values()], unavailable, duplicates };
  }

  function shuffled(items) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = deps.randomInt(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function playbackStatus(json) {
    const p = json.playabilityStatus;
    if (!p || !p.status) fail('YouTube did not return a playback result. Nothing was created.');
    if (p.status === 'OK') return true;
    const reason = [p.reason || '', ...find(p, 'reason').map(textOf), ...find(p, 'subreason').map(textOf)].join(
      ' '
    );
    if (/confirm.*not a bot|unusual traffic|automated|too many requests/i.test(reason))
      fail(
        'YouTube blocked the playback checks. Open a video normally, then run the tool again. Nothing was created.'
      );
    if (p.status === 'LIVE_STREAM_OFFLINE') return false;
    if (
      ['ERROR', 'UNPLAYABLE', 'LOGIN_REQUIRED'].includes(p.status) &&
      /private|deleted|removed|unavailable|not available|not exist|copyright|blocked|terminated|members.only|join this channel|purchase|rent this/i.test(
        reason
      )
    )
      return false;
    fail(
      'Playback could not be confirmed (' +
        p.status +
        '). ' +
        (reason.trim() || 'YouTube supplied no reason.') +
        ' Nothing was created. The faster mode can use playlist availability flags instead.'
    );
  }
  async function select(rows, count, checkPlayback) {
    const pool = uniqueAvailable(rows);
    if (pool.videos.length < count)
      fail(
        'Only ' +
          pool.videos.length +
          ' distinct eligible videos were found; ' +
          count +
          ' were requested. Nothing was created.'
      );
    const candidates = shuffled(pool.videos),
      selected = [];
    let checked = 0,
      rejected = 0;
    if (!checkPlayback) return { ...pool, selected: candidates.slice(0, count), rejected };
    for (let pos = 0; pos < candidates.length && selected.length < count; ) {
      checkpoint();
      const batch = candidates.slice(pos, pos + Math.min(3, count - selected.length));
      pos += batch.length;
      const verdicts = await Promise.all(
        batch.map(async (row) => playbackStatus(await deps.post('player', { videoId: row.id })))
      );
      checkpoint();
      batch.forEach((row, i) => {
        if (verdicts[i]) selected.push(row);
        else rejected++;
      });
      checked += batch.length;
      say('Checking playback: ' + selected.length + ' of ' + count + ' ready · ' + checked + ' checked');
    }
    if (selected.length !== count)
      fail(
        'Only ' +
          selected.length +
          ' videos passed playback checks; ' +
          count +
          ' were requested. Nothing was created.'
      );
    return { ...pool, selected, rejected };
  }

  function validateJob(job) {
    if (
      !job ||
      job.version !== 1 ||
      sourceId(job.source) !== job.source ||
      !Array.isArray(job.ids) ||
      !job.ids.length ||
      job.ids.length > 5000 ||
      job.ids.some((id) => !/^[A-Za-z0-9_-]{11}$/.test(id)) ||
      new Set(job.ids).size !== job.ids.length ||
      typeof job.title !== 'string' ||
      !job.title.trim() ||
      [...job.title].length > 150
    )
      fail('The saved selection is invalid. Nothing was changed.');
    if (job.destination && (!/^[A-Za-z0-9_-]{2,150}$/.test(job.destination) || job.destination === job.source))
      fail('The destination is invalid. Nothing was changed.');
  }
  async function verifyPrefix(job, exact = false) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await deps.delay(750 * attempt);
      try {
        const rows = await readPlaylist(job.destination, 'Checking new playlist');
        if (rows.length > job.ids.length || rows.some((r, i) => r.id !== job.ids[i]))
          fail('The new playlist differs from the saved selection. Automatic changes stopped.');
        if (rows.length < (job.confirmedCount || 0))
          fail(
            'YouTube has not exposed the last confirmed batch yet. Wait briefly before continuing the saved playlist.'
          );
        if (exact && rows.length !== job.ids.length)
          fail(
            'The new playlist currently contains ' + rows.length + ' of ' + job.ids.length + ' expected videos.'
          );
        if (!rows.length) fail('The new playlist is not visible yet.');
        return rows.length;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  async function finish(job, newlyCreated = false) {
    validateJob(job);
    if (!job.destination)
      fail('The creation result is unknown. Check YouTube playlists before starting another copy.');
    checkpoint();
    // Re-read after any interruption. A lost response can still mean a successful write.
    let offset = await verifyPrefix(job);
    // A fresh destination can contain only the batch sent at creation, even after a reload.
    if ((newlyCreated || job.phase === 'created') && offset > Math.min(50, job.ids.length))
      fail('Unexpected creation result. Automatic changes stopped.');
    while (offset < job.ids.length) {
      checkpoint();
      const batch = job.ids.slice(offset, offset + 50);
      say('Adding videos: ' + offset + ' of ' + job.ids.length);
      deps.save({ ...job, phase: 'adding' });
      const response = await deps.post(
        'browse/edit_playlist',
        {
          playlistId: job.destination,
          actions: batch.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id }))
        },
        { write: true, destination: job.destination, source: job.source }
      );
      if (response.status !== 'STATUS_SUCCEEDED')
        fail('YouTube did not confirm the last batch. The saved playlist can be checked and continued.');
      offset += batch.length;
      job.confirmedCount = offset;
      deps.save({ ...job, phase: 'adding' });
    }
    checkpoint();
    say('Verifying the complete video order…');
    await verifyPrefix(job, true);
    deps.save(null);
    return job;
  }
  async function run(options) {
    const source = sourceId(options.source),
      title = options.title.trim(),
      count = Number(options.count);
    if (!Number.isSafeInteger(count) || count < 1 || count > 5000) fail('Choose a whole number from 1 to 5,000.');
    if (!title || [...title].length > 150) fail('Use a playlist name of 1 to 150 characters.');
    const rows = await readPlaylist(source);
    const selection = await select(rows, count, options.checkPlayback);
    deps.summary?.(
      rows.length +
        ' entries · ' +
        selection.duplicates +
        ' repeated IDs skipped · ' +
        selection.unavailable +
        ' unavailable entries skipped · ' +
        selection.rejected +
        ' failed playback checks'
    );
    checkpoint();
    const job = {
      version: 1,
      source,
      title,
      ids: selection.selected.map((r) => r.id),
      phase: 'creating',
      destination: null,
      account: deps.account
    };
    validateJob(job);
    deps.save(job);
    say('Creating the new private playlist…');
    const response = await deps.post(
      'playlist/create',
      {
        title,
        privacyStatus: 'PRIVATE',
        videoIds: job.ids.slice(0, 50)
      },
      { write: true, source }
    );
    if (typeof response.playlistId !== 'string' || !response.playlistId)
      fail(
        'YouTube did not return a new playlist address. Creation may have succeeded; check YouTube playlists before trying again.'
      );
    // Keep the original creation record intact until the returned destination passes validation.
    const createdJob = {
      ...job,
      destination: response.playlistId,
      phase: 'created',
      confirmedCount: Math.min(50, job.ids.length)
    };
    validateJob(createdJob);
    deps.save(createdJob);
    await finish(createdJob, true);
    return createdJob;
  }
  return { sourceId, readPlaylist, uniqueAvailable, shuffled, playbackStatus, select, validateJob, finish, run };
}

function launchYouTubeSampler(makeCore) {
  'use strict';
  const ORIGIN = 'https://www.youtube.com';
  const ROOT_ID = 'youtube-random-sample-panel';
  const STORE = 'youtube-random-sample-job-v1';
  if (location.origin !== ORIGIN) {
    alert(
      'Open the source playlist at https://www.youtube.com while signed in, then click the ⤨ bookmark for Random Sample.'
    );
    return;
  }
  if (document.getElementById(ROOT_ID)) return;
  const cfg = (key) => window.ytcfg?.get?.(key) ?? window.yt?.config_?.[key];
  const identity = () =>
    JSON.stringify([cfg('SESSION_INDEX') ?? 0, cfg('DELEGATED_SESSION_ID') || '', cfg('DATASYNC_ID') || '']);
  const account = identity();
  const originalContext = cfg('INNERTUBE_CONTEXT');
  if (!originalContext?.client || cfg('LOGGED_IN') === false) {
    alert('Sign in to YouTube and reload the playlist page, then click the ⤨ bookmark for Random Sample again.');
    return;
  }
  const context = JSON.parse(JSON.stringify(originalContext));
  // English response reasons allow explicit classification without changing the page language.
  context.client.hl = 'en';
  let running = false,
    stopped = false,
    writing = false,
    journal = null;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cookie = (name) =>
    document.cookie
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(name + '='))
      ?.slice(name.length + 1);
  const randomInt = (bound) => {
    const ceiling = Math.floor(4294967296 / bound) * bound;
    const value = new Uint32Array(1);
    do {
      crypto.getRandomValues(value);
    } while (value[0] >= ceiling);
    return value[0] % bound;
  };
  async function auth() {
    const sid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (!sid) throw new Error('The current YouTube sign-in could not be used. Sign in and reload the page.');
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(timestamp + ' ' + sid + ' ' + ORIGIN)
    );
    return (
      'SAPISIDHASH ' +
      timestamp +
      '_' +
      Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('')
    );
  }
  async function post(endpoint, payload, options = {}) {
    const isWrite = ['playlist/create', 'browse/edit_playlist'].includes(endpoint);
    if (
      !['browse', 'player', 'playlist/create', 'browse/edit_playlist'].includes(endpoint) ||
      isWrite !== !!options.write
    )
      throw new Error('An unsupported request was blocked.');
    if (
      isWrite &&
      endpoint === 'playlist/create' &&
      (payload.privacyStatus !== 'PRIVATE' || payload.videoIds?.length > 50 || !payload.videoIds?.length)
    )
      throw new Error('An invalid creation request was blocked.');
    if (
      isWrite &&
      endpoint === 'browse/edit_playlist' &&
      (!options.destination ||
        payload.playlistId !== options.destination ||
        payload.playlistId === options.source ||
        journal?.destination !== payload.playlistId ||
        !payload.actions?.length ||
        payload.actions.length > 50 ||
        payload.actions.some((a) => a.action !== 'ACTION_ADD_VIDEO' || !journal.ids.includes(a.addedVideoId)))
    )
      throw new Error('A request outside the new playlist was blocked.');
    for (let attempt = 0; attempt < (isWrite ? 1 : 3); attempt++) {
      if (stopped) throw new Error('Stopped.');
      if (identity() !== account || cfg('LOGGED_IN') === false)
        throw new Error('The selected YouTube account changed. Reload before continuing.');
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': await auth(),
        'X-Origin': ORIGIN,
        'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
        'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
        'X-Youtube-Client-Version': context.client.clientVersion
      };
      if (cfg('DELEGATED_SESSION_ID')) headers['X-Goog-PageId'] = cfg('DELEGATED_SESSION_ID');
      if (context.client.visitorData) headers['X-Goog-Visitor-Id'] = context.client.visitorData;
      const key = cfg('INNERTUBE_API_KEY');
      const url =
        ORIGIN +
        '/youtubei/v1/' +
        endpoint +
        '?prettyPrint=false' +
        (key ? '&key=' + encodeURIComponent(key) : '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let response;
      try {
        writing = isWrite;
        response = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          headers,
          body: JSON.stringify({ context, ...payload }),
          signal: controller.signal
        });
        if (!response.ok) {
          if (!isWrite && attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
            await delay(1000 * (attempt + 1));
            continue;
          }
          throw new Error('YouTube returned HTTP ' + response.status + '.');
        }
        const json = await response.json();
        if (json.error) throw new Error('YouTube: ' + (json.error.message || 'request rejected'));
        if (json.responseContext?.visitorData) context.client.visitorData = json.responseContext.visitorData;
        return json;
      } catch (error) {
        // Writes are never blindly retried: a timeout can happen after YouTube committed them.
        if (!isWrite && attempt < 2 && (error instanceof TypeError || error.name === 'AbortError')) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        if (error.name === 'AbortError') throw new Error('The YouTube request timed out.');
        throw error;
      } finally {
        clearTimeout(timer);
        writing = false;
      }
    }
  }
  const host = document.createElement('div');
  host.id = ROOT_ID;
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{font:16px/1.5 system-ui,sans-serif;color:#eaf0f4;color-scheme:dark}
    *{box-sizing:border-box} .veil{height:100%;padding:24px;background:#000a;display:grid;place-items:center}
    .box{width:min(540px,100%);max-height:92vh;overflow:auto;background:#151b24;border:1px solid #47515e;border-radius:18px;padding:26px;box-shadow:0 24px 80px #0008}
    h2{font-size:25px;line-height:1.2;margin:8px 0 12px} .eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;color:#7fe0ce}
    p{margin:10px 0;color:#b8c4d1}label{display:block;font-size:13px;font-weight:650;margin:17px 0 6px}
    input[type=text],input[type=number]{display:block;width:100%;font:inherit;color:#fff;background:#0c1119;border:1px solid #506071;border-radius:7px;padding:10px 12px}
    input:focus,button:focus-visible,a:focus-visible{outline:2px solid #7fe0ce;outline-offset:3px}
    .checks{display:flex;gap:9px;align-items:flex-start;font-weight:400}.checks input{margin-top:4px;accent-color:#7fe0ce}
    small{display:block;font-size:12px;color:#a4b3c2;margin-top:5px}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}button{border:1px solid #566271;border-radius:8px;padding:10px 15px;font:600 14px system-ui;cursor:pointer;background:#26303d;color:#fff}
    button.primary{background:#8de8d6;color:#10231f;border-color:#8de8d6}button:disabled{opacity:.45;cursor:default}
    .status{white-space:pre-wrap;padding-top:12px;color:#eaf0f4;font-size:14px;overflow-wrap:anywhere}
    .result{display:block;margin-top:12px;color:#8de8d6;font-weight:650} .summary{font-size:12px;color:#a4b3c2;overflow-wrap:anywhere}
    .recovery{margin-top:16px;padding:14px;border:1px solid #796337;border-radius:10px}.recovery p{font-size:13px;margin:0 0 10px}
    [hidden]{display:none!important}
    @media(max-width:500px){.veil{padding:10px}.box{padding:20px}}
  `;
  shadow.append(style);

  function element(tag, parent, text, attrs = {}) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (parent) parent.append(el);
    return el;
  }
  const veil = element('div', shadow, '', { class: 'veil' });
  const box = element('section', veil, '', {
    class: 'box',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'sampler-title'
  });
  element('div', box, 'YOUTUBE · RANDOM SAMPLE · 1.0.1', { class: 'eyebrow' });
  element('h2', box, 'A fresh playlist.', { id: 'sampler-title' });
  element('p', box, 'Choose how many distinct videos to copy in random order. The new playlist will be private.');
  const form = element('form', box);

  function input(label, id, type, value) {
    element('label', form, label, { for: id });
    const field = element('input', form, '', { id, type, required: '', autocomplete: 'off' });
    field.value = value;
    return field;
  }
  const list = input(
    'Source playlist address',
    'sample-source',
    'text',
    new URL(location.href).searchParams.has('list') ? location.href : ''
  );
  const count = input('Number of videos (N)', 'sample-count', 'number', '50');
  count.min = '1';
  count.max = '5000';
  count.step = '1';
  const title = input('New playlist name', 'sample-name', 'text', 'Videos Taste');
  title.maxLength = 150;
  const checkLabel = element('label', form, '', { class: 'checks' });
  const check = element('input', checkLabel, '', { type: 'checkbox' });
  check.checked = true;
  const checkText = element('span', checkLabel, 'Check playback availability');
  element(
    'small',
    checkText,
    'Recommended. Turning this off is faster and skips only entries marked unavailable in the playlist.'
  );
  element('small', form, 'Uses the YouTube account selected in this tab. Keep the tab open until completion.');
  const actions = element('div', form, '', { class: 'actions' });
  const create = element('button', actions, 'Create playlist', { type: 'submit', class: 'primary' });
  const stop = element('button', actions, 'Stop', { type: 'button' });
  stop.hidden = true;
  const close = element('button', actions, 'Close', { type: 'button' });
  const status = element('div', box, '', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const summary = element('p', box, '', { class: 'summary' });
  const result = element('a', box, '', { class: 'result', target: '_blank', rel: 'noopener noreferrer' });
  result.hidden = true;
  const recovery = element('div', box, '', { class: 'recovery' });
  recovery.hidden = true;
  const recoveryText = element('p', recovery);
  const resume = element('button', recovery, 'Finish saved playlist', { type: 'button' });
  const discard = element('button', recovery, 'Clear saved attempt', { type: 'button' });
  element('small', recovery, 'Clearing this record leaves any created playlist on YouTube.');
  const previousFocus = document.activeElement;
  document.documentElement.append(host);
  if (list.value) count.focus();
  else list.focus();

  function showLink(job) {
    if (!job?.destination || !/^[A-Za-z0-9_-]{2,150}$/.test(job.destination)) {
      result.hidden = true;
      return;
    }
    result.href = ORIGIN + '/playlist?list=' + encodeURIComponent(job.destination);
    result.textContent = 'Open “' + job.title + '” on YouTube';
    result.hidden = false;
  }

  function updateRecovery() {
    recovery.hidden = !journal || running;
    if (!journal) return;
    showLink(journal);
    const sameAccount = journal.account === account;
    recoveryText.textContent = !sameAccount
      ? 'A saved attempt belongs to another YouTube account. Switch back to that account to continue.'
      : journal.destination
        ? 'A playlist was created but has not been fully verified. Continuing checks its existing videos before adding any missing ones.'
        : 'A creation request was started, but its result is unknown. Check the YouTube Playlists page for “' +
          journal.title +
          '” before clearing this record.';
    resume.hidden = !journal.destination || !sameAccount;
  }

  function save(job) {
    journal = job;
    try {
      if (job) sessionStorage.setItem(STORE, JSON.stringify(job));
      else sessionStorage.removeItem(STORE);
    } catch {
      summary.textContent = 'Recovery storage is unavailable. Keep this panel open until completion.';
    }
    if (job?.destination) showLink(job);
  }
  const core = makeCore({
    post,
    account,
    randomInt,
    delay,
    cancelled: () => stopped,
    save,
    progress: (message) => {
      if (!stopped) status.textContent = message;
    },
    summary: (message) => (summary.textContent = message)
  });
  try {
    const saved = sessionStorage.getItem(STORE);
    if (saved) {
      const value = JSON.parse(saved);
      core.validateJob(value);
      journal = value;
      updateRecovery();
    }
  } catch {
    status.textContent =
      'A saved attempt could not be read. Check YouTube playlists before creating another copy.';
  }

  function setRunning(value) {
    running = value;
    [list, count, title, check, close, resume, discard].forEach((el) => (el.disabled = value));
    create.disabled = value || !!journal;
    stop.hidden = !value;
    stop.disabled = false;
    updateRecovery();
  }
  async function execute(continuing) {
    if (running) return;
    stopped = false;
    result.hidden = true;
    summary.textContent = '';
    setRunning(true);
    try {
      const job = continuing
        ? await core.finish(journal)
        : await core.run({
            source: list.value,
            count: count.value,
            title: title.value,
            checkPlayback: check.checked
          });
      status.textContent = 'Done. ' + job.ids.length + ' distinct videos; the saved order was verified.';
      showLink(job);
    } catch (error) {
      status.textContent = error.message || 'The request could not be completed.';
      if (journal)
        status.textContent += journal.destination
          ? '\nA partial or complete playlist exists. Its address is below.'
          : '\nA playlist may already exist. Check YouTube playlists before retrying.';
    } finally {
      setRunning(false);
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!journal) execute(false);
  });
  resume.addEventListener('click', () => {
    if (journal?.account === account) execute(true);
  });
  discard.addEventListener('click', () => {
    save(null);
    setRunning(false);
    status.textContent = 'Saved attempt cleared.';
    result.hidden = true;
  });
  stop.addEventListener('click', () => {
    stopped = true;
    stop.disabled = true;
    status.textContent = writing
      ? 'Stopping after the current write finishes…'
      : 'Stopping after the current requests finish…';
  });
  const beforeUnload = (event) => {
    if (running) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);

  function dismiss() {
    if (!running) {
      window.removeEventListener('beforeunload', beforeUnload);
      host.remove();
      previousFocus?.focus?.();
    }
  }
  close.addEventListener('click', dismiss);
  shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
    if (event.key === 'Tab') {
      const focusable = [...shadow.querySelectorAll('input,button,a[href]')].filter(
        (el) => !el.disabled && !el.hidden && el.getClientRects().length
      );
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && shadow.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && shadow.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  setRunning(false);
}

launchYouTubeSampler(makeSamplerCore);
