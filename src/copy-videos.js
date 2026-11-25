// Copy Videos 1.3.0 — regular YouTube
(() => {
  'use strict';

  // A destination is an explicit saved playlist. Accept a bare playlist ID or
  // an ordinary YouTube link, including a watch link containing a list parameter.
  function playlistId(value) {
    let id = String(value || '').trim();
    if (/^https?:/i.test(id)) {
      const url = new URL(id);
      if (
        !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      ) {
        throw new Error('Enter a YouTube playlist URL or playlist ID.');
      }
      id = url.searchParams.get('list') || '';
    }
    if (!/^[A-Za-z0-9_-]{2,150}$/.test(id)) {
      throw new Error('Enter a playlist ID or a YouTube URL containing list=.');
    }
    if (id.startsWith('RD')) {
      throw new Error('Choose a saved playlist. Automatically generated Mixes are not supported.');
    }
    return id;
  }

  // SESSION_INDEX is a position in an account switcher, not a persistent identity.
  // Include both the selected channel and account when available. An account
  // switcher can offer the same delegated channel to two different logins.
  function preferenceOwner(config) {
    function stable(field) {
      const value = config(field);
      return typeof value === 'string' && /[a-z0-9]/i.test(value) ? value : '';
    }
    const channel = stable('DELEGATED_SESSION_ID') || stable('CHANNEL_ID');
    const account = stable('DATASYNC_ID') || stable('USER_SESSION_ID');
    return channel || account ? JSON.stringify([channel, account]) : null;
  }

  function destinationPreference(storage, owner) {
    const key = owner && 'mmrpgs:copy-videos:destination:v1:' + owner;
    return {
      key,
      read() {
        if (!storage || !key) return '';
        try {
          const saved = storage.getItem(key);
          return saved ? playlistId(saved) : '';
        } catch {
          return '';
        }
      },
      save(id) {
        const validated = playlistId(id);
        if (!storage || !key) return false;
        try {
          storage.setItem(key, validated);
          return true;
        } catch {
          return false;
        }
      }
    };
  }

  function makePlaylistCopier(deps) {
    'use strict';
    const destination = playlistId(deps.destination);
    const limit = 5000;
    const validVideo = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
    const text = (v) =>
      typeof v === 'string'
        ? v
        : v?.simpleText || v?.content || v?.runs?.map((r) => r.text || '').join('') || '';
    const fail = (message) => {
      throw new Error(message);
    };
    const check = () => {
      if (deps.cancelled?.())
        throw Object.assign(new Error('Canceled. Completed additions are kept.'), { canceled: true });
    };
    const say = (s) => deps.progress?.(s);
    function find(root, key) {
      const out = [],
        stack = [root],
        seen = new WeakSet();
      while (stack.length) {
        const v = stack.pop();
        if (!v || typeof v !== 'object' || seen.has(v)) continue;
        seen.add(v);
        if (Object.hasOwn(v, key)) out.push(v[key]);
        const values = Object.values(v);
        for (let i = values.length - 1; i >= 0; i--)
          if (values[i] && typeof values[i] === 'object') stack.push(values[i]);
      }
      return out;
    }
    function unpack(scope, playlistId) {
      const items = scope.contents || scope.items;
      if (!Array.isArray(items))
        fail('YouTube returned an unreadable playlist page. No more videos were added.');
      const rows = [],
        tokens = [];
      for (const entry of items) {
        const item = entry.richItemRenderer?.content || entry;
        const r =
          item.playlistVideoRenderer ||
          item.videoRenderer ||
          item.gridVideoRenderer ||
          item.reelItemRenderer ||
          item.shortsLockupViewModel;
        if (r) {
          const id = r.videoId || r.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || '',
            title = text(r.title) || text(r.headline) || text(r.overlayMetadata?.primaryText);
          rows.push({
            id,
            title: title || id,
            available:
              validVideo(id) &&
              r.isPlayable !== false &&
              !/^\[?(?:private|deleted|unavailable) video\]?$/i.test(title.trim())
          });
        } else if (item.lockupViewModel) {
          const model = item.lockupViewModel;
          if (model.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO')
            fail('A non-video item appeared inside the playlist video list. No more videos were added.');
          const id = model.contentId || '',
            title = text(model.metadata?.lockupMetadataViewModel?.title),
            watch = model.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
          if (watch?.playlistId && ![playlistId, 'VL' + playlistId].includes(watch.playlistId))
            fail('A video belongs to a different playlist. No more videos were added.');
          rows.push({
            id,
            title: title || id,
            available:
              validVideo(id) &&
              model.isPlayable !== false &&
              !/^\[?(?:private|deleted|unavailable) video\]?$/i.test(title.trim())
          });
        } else if (item.continuationItemRenderer || item.continuationItemViewModel) {
          const commands = find(
            item.continuationItemRenderer || item.continuationItemViewModel,
            'continuationCommand'
          )
            .map((c) => c.token)
            .filter((t) => typeof t === 'string' && t);
          if (!commands.length)
            fail('A playlist page could not be followed. No more videos were added.');
          tokens.push(...commands);
        } else if (item.itemSectionRenderer) {
          const nested = item.itemSectionRenderer;
          if (nested.targetId && ![playlistId, 'VL' + playlistId].includes(nested.targetId))
            fail('An unrelated section appeared inside the playlist video list.');
          const part = unpack(nested, playlistId);
          rows.push(...part.rows);
          if (part.next) tokens.push(part.next);
        } else if (!item.messageRenderer)
          fail('YouTube returned an unfamiliar playlist entry. No more videos were added.');
      }
      for (const c of scope.continuations || []) {
        if (!c.nextContinuationData?.continuation)
          fail('An unfamiliar playlist continuation was returned.');
        tokens.push(c.nextContinuationData.continuation);
      }
      const distinct = [...new Set(tokens)];
      if (distinct.length > 1) fail('YouTube returned ambiguous playlist pages.');
      return { rows, next: distinct[0] || null };
    }
    function primary(json) {
      const tabs =
        json.contents?.twoColumnBrowseResultsRenderer?.tabs ||
        json.contents?.singleColumnBrowseResultsRenderer?.tabs;
      if (tabs) {
        const selected =
          tabs.find((t) => t.tabRenderer?.selected)?.tabRenderer ||
          (tabs.length === 1 ? tabs[0].tabRenderer : null);
        return selected?.content || {};
      }
      return json.contents || {};
    }
    function chooseScope(json, id) {
      const root = primary(json),
        keys = [
          'playlistVideoListRenderer',
          'itemSectionRenderer',
          'richGridRenderer',
          'gridRenderer',
          'sectionListRenderer'
        ];
      // A playlist's item section is narrower than its outer section list. The outer
      // continuation may load recommendations after the playlist has ended.
      for (const key of keys) {
        const matches = find(root, key).filter(
          (s) => [id, 'VL' + id].includes(s.playlistId) || [id, 'VL' + id].includes(s.targetId)
        );
        if (matches.length === 1) return matches[0];
        if (matches.length > 1)
          fail('The playlist contains multiple matching video lists. No more videos were added.');
      }
      const legacy = find(root, 'playlistVideoListRenderer').filter((s) => !s.playlistId);
      if (legacy.length === 1) return legacy[0];
      // Some saved playlists use a grid directly as the selected tab's content.
      for (const key of ['richGridRenderer', 'gridRenderer'])
        if (
          root[key] &&
          !root[key].playlistId &&
          (!root[key].targetId ||
            ['browse-feed', 'rich-grid', 'playlist-video-list'].includes(root[key].targetId))
        )
          return root[key];
      return null;
    }
    function metadata(json, id) {
      const headers = find(json.header, 'playlistHeaderRenderer').filter(
        (h) => !h.playlistId || [id, 'VL' + id].includes(h.playlistId)
      );
      const sidebar = find(json.sidebar, 'playlistSidebarPrimaryInfoRenderer'),
        meta = find(json.metadata, 'playlistMetadataRenderer')[0];
      const modern = json.header?.pageHeaderRenderer,
        modernParts = find(modern?.content?.pageHeaderViewModel?.metadata, 'metadataParts')
          .flat()
          .map((p) => text(p.text));
      const texts = [...modernParts];
      let declared = null;
      for (const h of [...headers, ...sidebar])
        texts.push(
          text(h.numVideosText),
          ...(Array.isArray(h.stats) ? h.stats : []).map(text),
          ...(Array.isArray(h.briefStats) ? h.briefStats : []).map(text),
          ...(Array.isArray(h.byline) ? h.byline : []).map((b) => text(b.playlistBylineRenderer?.text))
        );
      for (const t of texts) {
        const m = t.trim().match(/^([\d,]+)\s+videos?\b/i);
        if (m) {
          const n = Number(m[1].replaceAll(',', ''));
          if (Number.isSafeInteger(n)) declared = Math.max(declared || 0, n);
        } else if (/^no videos[.!]?$/i.test(t.trim()) && declared === null) declared = 0;
      }
      return {
        title:
          meta?.title || modern?.pageTitle || text(headers[0]?.title) || text(sidebar[0]?.title) || id,
        declared,
        editable: headers.find((h) => typeof h.isEditable === 'boolean')?.isEditable,
        identified: !!meta || headers.some((h) => [id, 'VL' + id].includes(h.playlistId))
      };
    }
    async function readPlaylist(id, label, onPage) {
      check();
      let json = await deps.post('browse', { browseId: 'VL' + id, params: 'wgYCCAA=' });
      const errors = find(json.alerts, 'alertRenderer').filter((a) => a.type === 'ERROR');
      if (errors.length) fail(label + ': ' + (text(errors[0].text) || 'Playlist unavailable.'));
      const meta = metadata(json, id),
        root = primary(json);
      let scope = chooseScope(json, id);
      const emptyMessage = find(root, 'messageRenderer').some((m) =>
        /^(?:this playlist is empty|this playlist has no videos|(?:there are )?no videos(?: in this playlist)?(?: yet)?)[.!]?$/i.test(
          text(m.text).trim()
        )
      );
      if (
        !scope &&
        meta.identified &&
        (meta.declared === 0 || (meta.declared === null && emptyMessage)) &&
        !['playlistVideoRenderer', 'lockupViewModel', 'videoRenderer'].some(
          (k) => find(root, k).length
        ) &&
        !find(root, 'continuationCommand').length
      )
        return { ...meta, rows: [], count: 0 };
      if (!scope)
        fail(
          label +
            ': the playlist video section could not be identified. No videos were added from this scan.'
        );
      if (
        scope.contents === undefined &&
        scope.items === undefined &&
        meta.declared === 0 &&
        !scope.continuations?.length
      )
        scope = { ...scope, contents: [] };
      let target = scope.targetId || 'playlist-video-list';
      const rows = [],
        seen = new Set();
      if (typeof scope.isEditable === 'boolean') meta.editable = scope.isEditable;
      for (let p = 0; p < 1000; p++) {
        check();
        const part = unpack(scope, id);
        rows.push(...part.rows);
        say(label + ': ' + rows.length.toLocaleString() + ' entries');
        onPage?.({ ...meta, rows, count: Math.max(rows.length, meta.declared || 0) });
        if (!part.next) return { ...meta, rows, count: Math.max(rows.length, meta.declared || 0) };
        if (seen.has(part.next)) fail(label + ': YouTube repeated a page. No more videos were added.');
        seen.add(part.next);
        json = await deps.post('browse', { continuation: part.next });
        const continuations = json.continuationContents || {};
        const legacy =
          continuations.playlistVideoListContinuation ||
          continuations.itemSectionContinuation ||
          continuations.gridContinuation ||
          continuations.richGridContinuation ||
          continuations.sectionListContinuation;
        if (legacy) {
          scope = legacy;
          continue;
        }
        const actions = [];
        for (const branch of [
          json.onResponseReceivedActions,
          json.onResponseReceivedEndpoints,
          json.onResponseReceivedCommands
        ])
          for (const key of ['appendContinuationItemsAction', 'reloadContinuationItemsCommand'])
            actions.push(...find(branch, key));
        let matches = actions.filter((a) => a.targetId === target);
        if (!matches.length) matches = actions.filter((a) => [id, 'VL' + id].includes(a.targetId));
        if (!matches.length)
          matches = actions.filter((a) => !a.targetId && Array.isArray(a.continuationItems));
        if (matches.length !== 1)
          fail(label + ': the next page could not be identified. No more videos were added.');
        const action = matches[0],
          nested = chooseScope({ contents: action.continuationItems }, id);
        scope = nested || { contents: action.continuationItems };
        target = nested?.targetId || action.targetId || target;
      }
      fail(label + ': the playlist did not finish loading. No more videos were added.');
    }
    async function run(value) {
      const source = playlistId(value);
      if (source === destination)
        fail('This is the destination playlist. Open the playlist to copy, then open the tool again.');
      // Every run starts fresh. Records from older versions are never consulted.
      deps.save?.(null);
      const data = await readPlaylist(source, 'Reading source');
      const pool = new Map();
      let unavailable = 0,
        repeated = 0;
      for (const row of data.rows) {
        if (!row.available) {
          unavailable++;
          continue;
        }
        if (pool.has(row.id)) {
          repeated++;
          continue;
        }
        pool.set(row.id, row);
      }
      const ids = [...pool.keys()];
      deps.source?.({ id: source, title: data.title, rows: data.rows, ids });
      check();
      async function scanDestination() {
        let partial = { title: destination, rows: [], count: 0 };
        try {
          return {
            ...(await readPlaylist(destination, 'Checking existing videos', (page) => {
              partial = { ...page, rows: page.rows.slice() };
            })),
            incomplete: false
          };
        } catch (e) {
          if (e.fatal || e.canceled) throw e;
          return { ...partial, incomplete: true };
        }
      }
      const target = await scanDestination();
      if (target.editable === false)
        fail('This account cannot edit the destination. Choose an editable destination playlist.');
      let present = new Set(target.rows.map((r) => r.id).filter(validVideo)),
        count = target.count;
      const todo = ids.filter((id) => !present.has(id));
      const result = {
        sourceTitle: data.title,
        destinationTitle: target.title,
        sourceEntries: data.rows.length,
        eligible: ids.length,
        already: ids.length - todo.length,
        repeated,
        unavailable,
        omitted: Math.max(0, data.count - data.rows.length),
        added: 0,
        rejected: 0,
        noRoom: 0,
        uncertain: 0,
        duplicateCheckIncomplete: target.incomplete
      };
      const job = { version: 2, account: deps.account, source, destination, ids, pending: null };
      const emit = () => deps.summary?.({ ...result });
      const save = () => deps.save?.(job);
      save();
      emit();
      const accept = (batch) => {
        for (const id of batch)
          if (!present.has(id)) {
            present.add(id);
            count++;
            result.added++;
          }
        emit();
      };
      async function add(batch) {
        check();
        batch = batch.filter((id) => !present.has(id));
        if (!batch.length) return;
        const room = Math.max(0, limit - count);
        if (batch.length > room) {
          result.noRoom += batch.length - room;
          batch = batch.slice(0, room);
          emit();
        }
        if (!batch.length) return;
        job.pending = { ids: batch };
        save();
        say(
          'Adding videos: ' +
            result.added.toLocaleString() +
            ' added · ' +
            todo.length.toLocaleString() +
            ' to process'
        );
        let response, error;
        try {
          response = await deps.post(
            'browse/edit_playlist',
            {
              playlistId: destination,
              actions: batch.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id }))
            },
            { write: true, source, ids: batch }
          );
        } catch (e) {
          error = e;
        }
        if (response?.status === 'STATUS_SUCCEEDED') {
          accept(batch);
          job.pending = null;
          save();
          check();
          return;
        }
        if (error?.fatal || error?.canceled) throw error;
        check();
        // Use any individual receipts returned for a partially accepted batch.
        const receipts = new Set(
          find(response, 'playlistEditVideoAddedResultData')
            .map((r) => r.videoId)
            .filter(validVideo)
        );
        accept(batch.filter((id) => receipts.has(id)));
        let missing = batch.filter((id) => !present.has(id));
        job.pending = null;
        save();
        if (!missing.length) return;
        const rejected = response?.status === 'STATUS_FAILED' || error?.httpStatus === 400;
        if (rejected) {
          if (missing.length === 1) {
            result.rejected++;
            emit();
            return;
          }
          const middle = Math.ceil(missing.length / 2);
          await add(missing.slice(0, middle));
          await add(missing.slice(middle));
          return;
        }
        // A lost reply may still mean success. Check once when possible, then move
        // on instead of repeating an uncertain write or blocking subsequent batches.
        const fresh = await scanDestination(),
          actual = new Set(fresh.rows.map((r) => r.id).filter(validVideo));
        accept(missing.filter((id) => actual.has(id)));
        count = Math.max(count, fresh.count);
        for (const id of actual) present.add(id);
        missing = missing.filter((id) => !actual.has(id));
        result.uncertain += missing.length;
        result.duplicateCheckIncomplete ||= fresh.incomplete;
        emit();
      }
      try {
        for (let p = 0; p < todo.length; p += 50) {
          check();
          await add(todo.slice(p, p + 50));
        }
        check();
        emit();
        return result;
      } finally {
        deps.save?.(null);
      }
    }
    return { destination, readPlaylist, run };
  }

  function launchPlaylistCopier() {
    const ORIGIN = 'https://www.youtube.com';
    const ROOT = 'youtube-playlist-copier-panel';
    if (location.origin !== ORIGIN) {
      alert('Open the source playlist at https://www.youtube.com, then click the + bookmark.');
      return;
    }
    if (document.getElementById(ROOT)) return;
    const cfg = (key) => window.ytcfg?.get?.(key) ?? window.yt?.config_?.[key];
    const originalContext = cfg('INNERTUBE_CONTEXT');
    if (!originalContext?.client || cfg('LOGGED_IN') === false) {
      alert('Sign in to YouTube before opening Copy Videos.');
      return;
    }
    const owner = preferenceOwner(cfg);
    const identity = () =>
      JSON.stringify([
        cfg('SESSION_INDEX') ?? 0,
        cfg('DELEGATED_SESSION_ID') || '',
        cfg('DATASYNC_ID') || ''
      ]);
    const account = identity();
    const context = JSON.parse(JSON.stringify(originalContext));
    context.client.hl = 'en';
    const source = new URL(location.href).searchParams.get('list') || '';
    let storage;
    try {
      storage = window.localStorage;
    } catch {
      /* The panel can still be used for this visit. */
    }
    const preference = destinationPreference(storage, owner);
    let destination = preference.read();
    let activeDestination = '';
    let preferenceChangedDuringRun = false;
    let running = false;
    let stopped = false;
    let journal = null;
    let backupURL;
    let editing = !destination;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const fatal = (message, httpStatus) =>
      Object.assign(new Error(message), { fatal: true, httpStatus });
    function accountCheck() {
      if (
        identity() !== account ||
        preferenceOwner(cfg) !== owner ||
        cfg('LOGGED_IN') === false ||
        (!owner && cfg('INNERTUBE_CONTEXT') !== originalContext)
      ) {
        throw fatal(
          'The selected YouTube account changed. Close Copy Videos and reopen it under the intended account.'
        );
      }
      if ((new URL(location.href).searchParams.get('list') || '') !== source) {
        throw fatal('The source tab changed. Open Copy Videos again on the intended source playlist.');
      }
    }

    // Old versions stored unfinished verification records per account and destination.
    // No such record controls a new run. Remove only the record for this chosen route.
    function forgetOldRun(id) {
      try {
        storage?.removeItem('youtube-playlist-copier-v1:' + account + ':' + id);
      } catch {}
    }

    const cookie = (name) =>
      document.cookie
        .split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith(name + '='))
        ?.slice(name.length + 1);
    async function post(endpoint, payload, flags = {}) {
      const write = endpoint === 'browse/edit_playlist';
      if (!['browse', 'browse/edit_playlist'].includes(endpoint) || write !== !!flags.write)
        throw fatal('Unsupported operation.');
      if (
        write &&
        (!activeDestination ||
          payload.playlistId !== activeDestination ||
          source === activeDestination ||
          journal?.destination !== activeDestination ||
          journal?.source !== source ||
          flags.source !== source ||
          !payload.actions?.length ||
          payload.actions.length > 50 ||
          payload.actions.some(
            (a) =>
              a.action !== 'ACTION_ADD_VIDEO' ||
              Object.keys(a).some((k) => !['action', 'addedVideoId'].includes(k)) ||
              !journal.pending?.ids.includes(a.addedVideoId)
          ))
      )
        throw fatal('The addition does not match the selected source and destination.');
      for (let attempt = 0; attempt < (write ? 1 : 3); attempt++) {
        if (stopped)
          throw Object.assign(new Error('Canceled. Completed additions are kept.'), { canceled: true });
        accountCheck();
        const sid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
        if (!sid) throw fatal('The current YouTube sign-in could not be used.');
        const stamp = Math.floor(Date.now() / 1000),
          hash = await crypto.subtle.digest(
            'SHA-1',
            new TextEncoder().encode(stamp + ' ' + sid + ' ' + ORIGIN)
          );
        accountCheck();
        if (stopped)
          throw Object.assign(new Error('Canceled. Completed additions are kept.'), { canceled: true });
        const headers = {
          'Content-Type': 'application/json',
          Authorization:
            'SAPISIDHASH ' +
            stamp +
            '_' +
            [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join(''),
          'X-Origin': ORIGIN,
          'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
          'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
          'X-Youtube-Client-Version': context.client.clientVersion
        };
        if (cfg('DELEGATED_SESSION_ID')) headers['X-Goog-PageId'] = cfg('DELEGATED_SESSION_ID');
        if (context.client.visitorData) headers['X-Goog-Visitor-Id'] = context.client.visitorData;
        const key = cfg('INNERTUBE_API_KEY'),
          controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 30000);
        try {
          const r = await fetch(
            ORIGIN +
              '/youtubei/v1/' +
              endpoint +
              '?prettyPrint=false' +
              (key ? '&key=' + encodeURIComponent(key) : ''),
            {
              method: 'POST',
              credentials: 'same-origin',
              redirect: 'error',
              headers,
              body: JSON.stringify({ context, ...payload }),
              signal: controller.signal
            }
          );
          if (!r.ok) {
            if ([401, 403, 429].includes(r.status))
              throw fatal(
                'YouTube returned HTTP ' + r.status + '. Completed additions are kept.',
                r.status
              );
            throw Object.assign(new Error('YouTube returned HTTP ' + r.status + '.'), {
              httpStatus: r.status
            });
          }
          const json = await r.json();
          if (json.error)
            throw Object.assign(new Error(json.error.message || 'YouTube rejected the request.'), {
              httpStatus: json.error.code,
              fatal: [401, 403, 429].includes(json.error.code)
            });
          accountCheck();
          if (json.responseContext?.visitorData)
            context.client.visitorData = json.responseContext.visitorData;
          return json;
        } catch (e) {
          if (
            !write &&
            !e.fatal &&
            attempt < 2 &&
            (e.name === 'AbortError' || e instanceof TypeError || e.httpStatus >= 500)
          ) {
            await delay(750 * (attempt + 1));
            continue;
          }
          if (e.name === 'AbortError') throw new Error('The YouTube request timed out.');
          throw e;
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const host = document.createElement('div');
    host.id = ROOT;
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
    const shadow = host.attachShadow({ mode: 'open' });
    function el(tag, parent, value = '', attributes = {}) {
      const element = document.createElement(tag);
      if (value) element.textContent = value;
      for (const [name, attribute] of Object.entries(attributes)) element.setAttribute(name, attribute);
      parent.append(element);
      return element;
    }
    el(
      'style',
      shadow,
      ':host{font:15px/1.6 system-ui,sans-serif;color:#edf5f4;color-scheme:dark}*{box-sizing:border-box}.veil{height:100%;padding:24px;background:#091311db;display:grid;place-items:center}.box{width:min(580px,100%);max-height:92vh;overflow:auto;background:#142723;border:1px solid #496e62;border-radius:18px;padding:28px;box-shadow:0 24px 80px #0008}.eyebrow{font-size:11px;letter-spacing:.15em;color:#9ce7c8;font-weight:750}h1{font-size:29px;line-height:1.15;margin:10px 0 15px}p{color:#c0d2cb;margin:12px 0}.route{padding:13px 16px;background:#1d3730;border-radius:9px;margin:18px 0}.route small{font-size:11px;letter-spacing:.06em;display:block;text-transform:uppercase}.route a{color:#c4fbe4;text-decoration:none;overflow-wrap:anywhere}.route div+div{margin-top:12px}.route input{background:#10241d;border:1px solid #77a996;border-radius:6px;color:#e9fff5;padding:8px 10px;margin:6px 0;width:100%;font:inherit}.route label{display:block;color:#c0d2cb}.destination-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button,.download{border:1px solid #77a996;background:#254b3d;color:#e9fff5;border-radius:7px;padding:10px 14px;font:600 14px system-ui;cursor:pointer;text-decoration:none}.primary{background:#bcf1d6;border-color:#bcf1d6;color:#12382b}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:9px;flex-wrap:wrap;margin:22px 0 12px}.status{white-space:pre-line;overflow-wrap:anywhere;margin:18px 0}.summary{font-size:13px;color:#cce2d8}.note{font-size:12px;color:#adcbc0}.error{color:#ffd2bb}.download{display:inline-block;margin-top:12px;font-size:12px;background:transparent}[hidden]{display:none!important}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #a9e6ca;outline-offset:3px}'
    );
    const veil = el('div', shadow, '', { class: 'veil' });
    const box = el('section', veil, '', {
      class: 'box',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Copy YouTube playlist'
    });
    el('div', box, 'YOUTUBE PLAYLIST COPIER · 1.3.0', { class: 'eyebrow' });
    el('h1', box, 'Add this playlist’s videos');
    el('p', box, 'Copy videos to the destination you choose for this YouTube account.');
    const route = el('div', box, '', { class: 'route' });
    const from = el('div', route);
    const to = el('div', route);
    const playlistLink = (id) => ORIGIN + '/playlist?list=' + encodeURIComponent(id);
    el('small', from, 'Current source');
    const sourceLink = el(
      source ? 'a' : 'span',
      from,
      source || 'No playlist in this tab',
      source ? { href: playlistLink(source), target: '_blank', rel: 'noopener noreferrer' } : {}
    );
    el('small', to, 'Destination');
    const destinationLine = el('div', to, '', { class: 'destination-actions' });
    const destLink = el('a', destinationLine, '', { target: '_blank', rel: 'noopener noreferrer' });
    const change = el('button', destinationLine, 'Change destination', { type: 'button' });
    const editor = el('form', to);
    const label = el('label', editor, 'Destination playlist URL or ID');
    const field = el('input', label, '', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const editorButtons = el('div', editor, '', { class: 'destination-actions' });
    const saveButton = el('button', editorButtons, 'Save destination', { type: 'submit' });
    const keepButton = el('button', editorButtons, 'Keep current destination', { type: 'button' });
    const persistence = el(
      'p',
      editor,
      'The destination is remembered for this YouTube account in this browser.',
      { class: 'note' }
    );
    const actions = el('div', box, '', { class: 'actions' });
    const start = el('button', actions, 'Add videos', { class: 'primary', type: 'button' });
    const cancel = el('button', actions, 'Cancel', { type: 'button' });
    const close = el('button', actions, 'Close', { type: 'button' });
    const status = el('div', box, '', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const summary = el('div', box, '', { class: 'summary' });
    el(
      'p',
      box,
      'Duplicate checks are best effort. Unavailable or rejected entries are skipped. Completed additions are kept if canceled.',
      { class: 'note' }
    );
    const backup = el('a', box, 'Download source URLs', {
      class: 'download',
      download: 'YouTube-Source-Backup.txt'
    });
    backup.hidden = true;
    if (!owner || !storage)
      persistence.textContent =
        'Account-specific storage is unavailable. This destination will apply only while this panel is open.';

    function showMessage(message, error = false) {
      status.textContent = message;
      status.setAttribute('class', error ? 'status error' : 'status');
    }
    function controls() {
      destinationLine.hidden = !destination || editing;
      editor.hidden = !editing;
      keepButton.hidden = !destination;
      if (destination) destLink.href = playlistLink(destination);
      else destLink.removeAttribute('href');
      saveButton.disabled = running;
      change.disabled = running;
      field.disabled = running;
      keepButton.disabled = running;
      start.disabled = running || editing || !source || !destination || source === destination;
      cancel.disabled = !running || stopped;
      close.disabled = running;
    }
    function readyMessage() {
      if (!source)
        return 'Open a source playlist whose address contains list=, then open Copy Videos again.';
      if (!destination) return 'Choose a destination playlist before adding videos.';
      if (source === destination)
        return 'This is the destination playlist. Choose another destination or open a different source.';
      return 'Ready. Click Add videos to start.';
    }
    function useDestination(id) {
      destination = id;
      editing = !id;
      destLink.textContent = id;
      field.value = id;
      summary.textContent = '';
      controls();
      showMessage(readyMessage());
    }
    change.addEventListener('click', () => {
      if (running) return;
      editing = true;
      field.value = destination;
      controls();
      field.focus();
    });
    keepButton.addEventListener('click', () => {
      if (running) return;
      editing = false;
      controls();
      showMessage(readyMessage());
      change.focus();
    });
    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      if (running) return;
      try {
        accountCheck();
        const id = playlistId(field.value);
        const remembered = preference.save(id);
        useDestination(id);
        if (!remembered) showMessage('Using this destination for this panel only. ' + readyMessage());
        if (start.disabled) change.focus();
        else start.focus();
      } catch (error) {
        showMessage(error.message, true);
        field.focus();
      }
    });

    // A running copy always uses the destination shown when Add videos was clicked.
    // An idle panel picks up changes from another tab before its next run.
    function onStorage(event) {
      if (
        !storage ||
        !preference.key ||
        event.storageArea !== storage ||
        (event.key !== null && event.key !== preference.key)
      )
        return;
      if (running) preferenceChangedDuringRun = true;
      else useDestination(preference.read());
    }
    window.addEventListener('storage', onStorage);
    function sourceScanned(data) {
      sourceLink.textContent = data.title;
      try {
        if (backupURL) URL.revokeObjectURL(backupURL);
        const ids = [
          ...new Set(data.rows.map((row) => row.id).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))
        ];
        const urls = ids.map((id) => ORIGIN + '/watch?v=' + id).join('\n') + '\n';
        backupURL = URL.createObjectURL(new Blob([urls], { type: 'text/plain;charset=utf-8' }));
        backup.href = backupURL;
        backup.hidden = false;
      } catch {
        /* Copying is independent of downloading a local backup. */
      }
    }
    function updateSummary(result) {
      destLink.textContent = result.destinationTitle;
      const counts = [
        result.added.toLocaleString() + ' added',
        result.already.toLocaleString() + ' already present',
        result.unavailable.toLocaleString() + ' unavailable',
        result.repeated.toLocaleString() + ' repeated source IDs'
      ];
      for (const [count, label] of [
        [result.rejected, 'rejected'],
        [result.noRoom, 'did not fit'],
        [result.uncertain, 'uncertain'],
        [result.omitted, 'entries not supplied by YouTube']
      ]) {
        if (count) counts.push(count.toLocaleString() + ' ' + label);
      }
      summary.textContent =
        counts.join(' · ') +
        (result.duplicateCheckIncomplete
          ? '\nThe destination could only be checked for some duplicates.'
          : '');
    }
    async function copyToChosenDestination() {
      accountCheck();
      forgetOldRun(activeDestination);
      const core = makePlaylistCopier({
        destination: activeDestination,
        account,
        post,
        cancelled: () => stopped,
        save: (job) => {
          journal = job;
        },
        progress: showMessage,
        source: sourceScanned,
        summary: updateSummary
      });
      const result = await core.run(source);
      const messages = ['Finished. ' + result.added + ' additions accepted.'];
      if (result.noRoom)
        messages.push(
          'The destination reached its 5,000-entry limit. ' + result.noRoom + ' videos did not fit.'
        );
      if (result.rejected) messages.push(result.rejected + ' videos were rejected by YouTube.');
      if (result.uncertain)
        messages.push(result.uncertain + ' additions could not be confirmed and were not repeated.');
      if (result.duplicateCheckIncomplete)
        messages.push('Some duplicates may remain because the destination could not be fully checked.');
      showMessage(messages.join(' '));
    }
    start.addEventListener('click', async () => {
      if (start.disabled || running) return;
      stopped = false;
      activeDestination = destination;
      running = true;
      controls();
      showMessage('Starting the copy…');
      try {
        if (navigator.locks?.request) {
          // The target playlist is the shared resource, including for collaborators.
          await navigator.locks.request(
            'mmrpgs:copy-videos:playlist:' + activeDestination,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error('Another copy to this destination is running in another tab.');
              await copyToChosenDestination();
            }
          );
        } else {
          throw new Error(
            'This browser does not provide Web Locks for YouTube. Use an up-to-date Firefox window so copies to the same destination can be coordinated.'
          );
        }
      } catch (error) {
        showMessage(
          error.message || 'The copy could not finish. Completed additions are kept.',
          !error.canceled
        );
      } finally {
        journal = null;
        activeDestination = '';
        running = false;
        start.textContent = 'Add videos again';
        if (preferenceChangedDuringRun) {
          preferenceChangedDuringRun = false;
          const lastStatus = status.textContent;
          const lastError = status.getAttribute('class') === 'status error';
          useDestination(preference.read());
          showMessage(
            lastStatus + ' The destination setting changed in another tab. ' + readyMessage(),
            lastError
          );
        } else controls();
      }
    });
    cancel.addEventListener('click', () => {
      stopped = true;
      controls();
      showMessage('Canceling after the current request. Completed additions will be kept.');
    });
    const beforeUnload = (event) => {
      if (running) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    close.addEventListener('click', () => {
      if (running) return;
      host.remove();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('storage', onStorage);
      if (backupURL) URL.revokeObjectURL(backupURL);
    });
    document.documentElement.append(host);
    useDestination(destination);
    if (editing) field.focus();
    else if (start.disabled) change.focus();
    else start.focus();
  }

  launchPlaylistCopier();
})();
