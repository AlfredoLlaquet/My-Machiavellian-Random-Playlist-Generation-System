/* Random Songs 2.1.1 — self-contained YouTube Music tool, no external dependencies. */
function makeCollectionSamplerCore(deps) {
  'use strict';
  let catalog = null;
  const cache = new Map(),
    partialCache = new Map();
  const MAX_READ_ATTEMPTS = 3;
  const fail = (message) => {
    throw new Error(message);
  };
  const checkpoint = () => {
    if (deps.cancelled?.()) fail('Stopped.');
  };
  const say = (message) => deps.progress?.(message);
  const retryableRead = (error) =>
    error.retryable !== false &&
    !/account changed|sign.in|log.?in|not a bot|captcha|unusual traffic|permission|forbidden|unauthori[sz]ed|HTTP (?:401|403)\b/i.test(
      error.message || ''
    );
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
        fail('Use a YouTube Music playlist address.');
      id = url.searchParams.get('list') || url.pathname.match(/^\/browse\/VL([A-Za-z0-9_-]+)\/?$/)?.[1] || '';
    }
    if (id.startsWith('VL')) id = id.slice(2);
    if (!/^[A-Za-z0-9_-]{2,150}$/.test(id)) fail('Enter a playlist address containing list=, or a playlist ID.');
    if (/^RD(?!CLAK)/.test(id))
      fail('Radio and personal Mixes change as they play. Choose a saved playlist with a fixed track list.');
    return id;
  }

  function roman(number) {
    let result = '';
    for (const [value, letters] of [
      [1000, 'M'],
      [900, 'CM'],
      [500, 'D'],
      [400, 'CD'],
      [100, 'C'],
      [90, 'XC'],
      [50, 'L'],
      [40, 'XL'],
      [10, 'X'],
      [9, 'IX'],
      [5, 'V'],
      [4, 'IV'],
      [1, 'I']
    ]) {
      while (number >= value) {
        result += letters;
        number -= value;
      }
    }
    return result;
  }

  function matchTitle(title) {
    if (typeof title !== 'string') return null;
    const match = /^[ _]*Alfredo's *__([IVXLCDM]+)__$/.exec(title);
    if (!match || match[0].length !== title.length) return null;
    const digits = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    const letters = match[1];
    let number = 0;
    for (let i = 0; i < letters.length; i++)
      number += digits[letters[i]] * (digits[letters[i]] < (digits[letters[i + 1]] || 0) ? -1 : 1);
    if (number < 1 || number > 3999 || roman(number) !== letters) return null;
    return { roman: letters, number };
  }

  function diagnostics(playlists) {
    const counts = new Map();
    for (const p of playlists) counts.set(p.number, (counts.get(p.number) || 0) + 1);
    const high = Math.max(0, ...playlists.map((p) => p.number));
    const missing = [],
      repeated = [];
    for (let n = 1; n <= high; n++) if (!counts.has(n)) missing.push(roman(n));
    for (const [n, count] of counts) if (count > 1) repeated.push(roman(n));
    return { found: playlists.length, missing, repeated };
  }

  function nextPage(scope, items) {
    const tokens = [];
    for (const item of items)
      if (item.continuationItemRenderer) {
        const commands = find(item.continuationItemRenderer, 'continuationCommand');
        if (!commands.length || commands.some((c) => !c.token)) fail('A continuation could not be read.');
        tokens.push(...commands.map((c) => ({ token: c.token, mode: 'body' })));
      }
    for (const entry of scope.continuations || []) {
      const token = entry.nextContinuationData?.continuation;
      if (!token) fail('An unsupported continuation was returned.');
      tokens.push({ token, mode: 'query' });
    }
    const unique = [...new Map(tokens.map((t) => [t.token, t])).values()];
    if (unique.length > 1) fail('Ambiguous pagination was returned. Nothing further was changed.');
    return unique[0] || null;
  }

  function libraryScope(json) {
    const tabs =
      json.contents?.singleColumnBrowseResultsRenderer?.tabs ||
      json.contents?.twoColumnBrowseResultsRenderer?.tabs;
    const tab = tabs && (tabs.find((t) => t.tabRenderer?.selected)?.tabRenderer || tabs[0]?.tabRenderer);
    const root = tab ? tab.content : json.contents;
    const grids = find(root, 'gridRenderer');
    const shelves = grids.length ? grids : find(root, 'musicShelfRenderer');
    if (shelves.length !== 1)
      fail('The Music library layout could not be read completely. Playlist discovery stopped.');
    return shelves[0];
  }

  function libraryCard(item) {
    const r = item.musicTwoRowItemRenderer || item.musicResponsiveListItemRenderer || item.gridPlaylistRenderer;
    if (!r) {
      if (
        item.continuationItemRenderer ||
        item.musicNewPlaylistButtonRenderer ||
        item.musicCreatePlaylistButtonRenderer ||
        item.messageRenderer
      )
        return null;
      fail('An unrecognized library item was returned. Stopped to avoid omitting a playlist.');
    }
    const column = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text;
    const title = textOf(r.title || column);
    const endpoints = [
      r.navigationEndpoint,
      ...(r.title?.runs || []).map((v) => v.navigationEndpoint),
      ...(column?.runs || []).map((v) => v.navigationEndpoint)
    ].filter(Boolean);
    const browseIds = endpoints.map((e) => e.browseEndpoint?.browseId).filter((v) => v?.startsWith('VL'));
    let id =
      browseIds[0]?.slice(2) ||
      r.playlistId ||
      endpoints.map((e) => e.watchPlaylistEndpoint?.playlistId).find(Boolean);
    if (!id) {
      const creates = (node) =>
        node &&
        typeof node === 'object' &&
        Object.entries(node).some(([key, value]) => /createPlaylist|newPlaylist/i.test(key) || creates(value));
      if (creates(r) || (title === 'New playlist' && endpoints.some((e) => e.modalEndpoint))) return null;
      fail('A library card has no readable playlist ID: ' + (title || '(untitled)'));
    }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{2,150}$/.test(id))
      fail('A library playlist ID could not be read.');
    if (!title) fail('A library playlist has no readable title. Discovery stopped.');
    return { id, title };
  }
  async function discoverOnce({ clearCache = true } = {}) {
    catalog = null;
    if (clearCache) {
      cache.clear();
      partialCache.clear();
    }
    checkpoint();
    const records = new Map(),
      seen = new Set();
    let json = await deps.post('browse', { browseId: 'FEmusic_liked_playlists' });
    let scope = libraryScope(json),
      targetId = scope.targetId || null;
    const snapshot = (complete) => {
      const playlists = [],
        similar = [];
      for (const record of records.values()) {
        const matched = matchTitle(record.title);
        if (matched) playlists.push({ ...record, ...matched });
        else if (/Alfredo/i.test(record.title)) similar.push(record);
      }
      playlists.sort((a, b) => a.number - b.number || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      return { complete, playlists, similar, scanned: records.size };
    };
    for (let page = 0; page < 1000; page++) {
      checkpoint();
      const items = scope.items || scope.contents;
      if (!Array.isArray(items)) fail('The library page could not be read completely.');
      for (const item of items) {
        const record = libraryCard(item);
        if (!record) continue;
        if (records.has(record.id) && records.get(record.id).title !== record.title)
          fail('A playlist title changed during discovery. Run the tool again.');
        records.set(record.id, record);
      }
      const next = nextPage(scope, items);
      const current = snapshot(!next);
      deps.onCatalog?.(current);
      say('Finding playlists: ' + records.size + ' inspected · ' + current.playlists.length + ' matches');
      if (!next) {
        catalog = current;
        return current;
      }
      if (seen.has(next.token)) fail('YouTube Music repeated a library page. Discovery is incomplete.');
      seen.add(next.token);
      json =
        next.mode === 'query'
          ? await deps.post('browse', { browseId: 'FEmusic_liked_playlists' }, { continuation: next.token })
          : await deps.post('browse', { continuation: next.token });
      const legacy =
        json.continuationContents?.gridContinuation || json.continuationContents?.musicShelfContinuation;
      if (legacy) {
        scope = legacy;
        continue;
      }
      const actions = [
        ...find(json.onResponseReceivedActions, 'appendContinuationItemsAction'),
        ...find(json.onResponseReceivedEndpoints, 'appendContinuationItemsAction'),
        ...find(json.onResponseReceivedCommands, 'appendContinuationItemsAction')
      ];
      let matches = actions.filter((a) => targetId && a.targetId === targetId);
      if (!matches.length)
        matches = actions.filter((a) => (!a.targetId || !targetId) && Array.isArray(a.continuationItems));
      if (matches.length !== 1) fail('The next library page could not be identified. Discovery is incomplete.');
      if (!targetId && matches[0].targetId) targetId = matches[0].targetId;
      scope = { items: matches[0].continuationItems };
    }
    fail('Library discovery did not finish. No playlist was created.');
  }
  async function discover(options = {}) {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      checkpoint();
      try {
        return await discoverOnce({ clearCache: attempt === 0 && options.clearCache !== false });
      } catch (error) {
        checkpoint();
        if (!retryableRead(error) || attempt === MAX_READ_ATTEMPTS - 1) throw error;
        say('Retrying playlist discovery (' + (attempt + 1) + '/2). Cached tracks are retained…');
        await deps.delay?.(1000 * (attempt + 1));
      }
    }
  }
  const cleanName = (value) =>
    String(value || '')
      .normalize('NFC')
      .replace(/\s+/gu, ' ')
      .trim();
  const nameKey = (value) => cleanName(value).toLocaleLowerCase('en');
  const artistLimit = (count, percent = 1) => {
    const hundredths = Math.round(percent * 100);
    if (!Number.isFinite(percent) || percent < 0.01 || percent > 100 || percent !== hundredths / 100)
      fail('Choose an artist percentage from 0.01 to 100 with up to two decimal places.');
    return Math.max(1, Math.round((count * hundredths) / 10000));
  };

  function artistCredits(columns, titleIndex) {
    const endpoint = (run) => run.navigationEndpoint?.browseEndpoint;
    const pageType = (run) =>
      endpoint(run)?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
    const isArtist = (run) => {
      const e = endpoint(run),
        type = pageType(run);
      if (!e) return false;
      if (['MUSIC_PAGE_TYPE_ARTIST', 'MUSIC_PAGE_TYPE_UNKNOWN'].includes(type))
        return !/^(?:MPRE|VL)/.test(e.browseId || '');
      return !type && /^UC/.test(e.browseId || '');
    };
    const runsOf = (text) => text?.runs || (text?.simpleText ? [{ text: text.simpleText }] : []);
    const noise = (text) =>
      !text ||
      /^(?:[•·,&/]+|and|feat\.?|ft\.?|featuring|with|song|video|album|single|unknown artist)$/i.test(text) ||
      /^\d+:\d{2}(?::\d{2})?$/.test(text) ||
      /^[\d.,]+[KMB]?\s+(?:views?|plays?|subscribers?|listeners?)$/i.test(text);
    let indexes = columns
      .map((text, index) => (index !== titleIndex && runsOf(text).some(isArtist) ? index : -1))
      .filter((i) => i >= 0);
    if (
      !indexes.length &&
      titleIndex !== 1 &&
      columns[1] &&
      !runsOf(columns[1]).some((run) => run.navigationEndpoint)
    )
      indexes = [1];
    if (!indexes.length) {
      const channels = columns
        .map((text, index) =>
          index !== titleIndex && runsOf(text).some((run) => pageType(run) === 'MUSIC_PAGE_TYPE_USER_CHANNEL')
            ? index
            : -1
        )
        .filter((i) => i >= 0);
      if (channels.length) indexes = [channels.at(-1)];
    }
    const credits = new Map();
    for (const index of indexes) {
      let metadata = false;
      for (const run of runsOf(columns[index])) {
        const name = cleanName(run.text),
          e = endpoint(run);
        if (/^[•·]$/.test(name)) {
          metadata = true;
          continue;
        }
        if (noise(name)) continue;
        if (run.navigationEndpoint) {
          if (!isArtist(run) && pageType(run) !== 'MUSIC_PAGE_TYPE_USER_CHANNEL') continue;
        } else if (metadata) continue;
        const id = typeof e?.browseId === 'string' ? e.browseId : null;
        const key = (id || '') + '\n' + nameKey(name);
        if (!credits.has(key)) credits.set(key, { name, id });
      }
    }
    return [...credits.values()];
  }

  function isDisliked(r, id) {
    // Read current ratings only. A menu action offering DISLIKE is not a rating.
    const buttons = r.menu?.menuRenderer?.topLevelButtons;
    for (const button of find(buttons, 'likeButtonRenderer')) {
      const targets = [button.target, ...find(button, 'likeEndpoint').map((e) => e.target)].filter(Boolean);
      if (!targets.some((t) => t.playlistId || (t.videoId && t.videoId !== id)) && button.likeStatus === 'DISLIKE')
        return true;
    }
    return find(buttons, 'toggleButtonRenderer').some(
      (button) =>
        button.isToggled === true &&
        button.defaultServiceEndpoint?.likeEndpoint?.status === 'DISLIKE' &&
        button.defaultServiceEndpoint.likeEndpoint.target?.videoId === id
    );
  }

  function musicRow(r) {
    // Playlist IDs take priority over playback substitutions and menu recommendations.
    const play = r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer;
    const columns = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text);
    const columnEndpoints = columns.flatMap((c) =>
      (c?.runs || []).map((run) => run.navigationEndpoint?.watchEndpoint).filter(Boolean)
    );
    const removedIds = find(r.menu, 'playlistEditEndpoint').flatMap((e) =>
      (e.actions || []).map((a) => a.removedVideoId).filter(Boolean)
    );
    const id =
      r.playlistItemData?.videoId ||
      play?.playNavigationEndpoint?.watchEndpoint?.videoId ||
      r.navigationEndpoint?.watchEndpoint?.videoId ||
      columnEndpoints[0]?.videoId ||
      removedIds[0] ||
      '';
    const titleColumn = columns.find((c) =>
      c?.runs?.some((run) => run.navigationEndpoint?.watchEndpoint?.videoId === id)
    );
    const title = textOf(titleColumn || columns[0] || r.title);
    const unavailable =
      !/^[A-Za-z0-9_-]{11}$/.test(id) ||
      r.isPlayable === false ||
      r.isAvailable === false ||
      r.musicItemRendererDisplayPolicy === 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT' ||
      play?.playabilityStatus === 'PLAYABILITY_STATUS_UNPLAYABLE' ||
      /^(\[?)(private video|deleted video|unavailable video|song deleted|song unavailable)(\]?)$/i.test(
        title.trim()
      );
    return {
      id,
      title: title || id,
      available: !unavailable,
      disliked: isDisliked(r, id),
      artists: artistCredits(columns, columns.indexOf(titleColumn || columns[0]))
    };
  }

  function unpack(scope) {
    const rows = [],
      tokens = [];
    if (!Array.isArray(scope.contents))
      fail('YouTube Music returned an unfamiliar playlist layout. Nothing further was changed.');
    for (const item of scope.contents) {
      if (item.musicResponsiveListItemRenderer) {
        rows.push(musicRow(item.musicResponsiveListItemRenderer));
      } else if (item.continuationItemRenderer) {
        const commands = find(item.continuationItemRenderer, 'continuationCommand');
        if (!commands.length || commands.some((c) => !c.token))
          fail('The playlist continuation could not be read.');
        tokens.push(...commands.map((c) => ({ token: c.token, mode: 'body' })));
      } else if (!item.messageRenderer) {
        fail(
          'YouTube Music returned an unsupported playlist entry. Stopped to avoid sampling an incomplete list.'
        );
      }
    }
    for (const entry of scope.continuations || []) {
      const token = entry.nextContinuationData?.continuation;
      if (!token) fail('An unsupported continuation was returned.');
      tokens.push({ token, mode: 'query' });
    }
    const unique = [...new Map(tokens.map((t) => [t.token, t])).values()];
    if (unique.length > 1) fail('The playlist returned ambiguous pagination. Nothing further was changed.');
    return { rows, next: unique[0] || null };
  }
  const newReadState = () => ({
    rows: [],
    seen: new Set(),
    next: null,
    targetId: null,
    pages: 0,
    complete: false
  });
  async function readPlaylist(id, label = 'Reading source', onPage, halt, state = newReadState()) {
    checkpoint();
    while (!state.complete && state.pages < 1000) {
      checkpoint();
      if (halt?.()) fail('Source scan stopped.');
      const next = state.next;
      const json = next
        ? next.mode === 'query'
          ? await deps.post('browse', { browseId: 'VL' + id }, { continuation: next.token })
          : await deps.post('browse', { continuation: next.token })
        : await deps.post('browse', { browseId: 'VL' + id });
      checkpoint();
      const errors = find(json.alerts, 'alertRenderer').filter((a) => a.type === 'ERROR');
      if (errors.length) fail(textOf(errors[0].text) || 'YouTube Music could not open this playlist.');
      let scope,
        targetId = state.targetId;
      if (!next) {
        const allLists = find(json.contents, 'musicPlaylistShelfRenderer');
        const identified = allLists.filter(
          (r) => [id, 'VL' + id].includes(r.playlistId) || [id, 'VL' + id].includes(r.targetId)
        );
        const lists = identified.length ? identified : allLists.filter((r) => !r.playlistId);
        if (lists.length !== 1)
          fail(
            'The playlist could not be read. Check the address and access in the selected YouTube Music account.'
          );
        scope = lists[0];
        targetId = scope.targetId || null;
      } else {
        scope =
          json.continuationContents?.musicPlaylistShelfContinuation ||
          json.continuationContents?.musicShelfContinuation;
        if (!scope) {
          const actions = [
            ...find(json.onResponseReceivedActions, 'appendContinuationItemsAction'),
            ...find(json.onResponseReceivedEndpoints, 'appendContinuationItemsAction'),
            ...find(json.onResponseReceivedCommands, 'appendContinuationItemsAction')
          ];
          let matches = actions.filter((a) => a.targetId && [targetId, id, 'VL' + id].includes(a.targetId));
          if (!matches.length)
            matches = actions.filter(
              (a) =>
                (!a.targetId || !targetId) &&
                Array.isArray(a.continuationItems) &&
                a.continuationItems.every(
                  (item) =>
                    item.musicResponsiveListItemRenderer || item.continuationItemRenderer || item.messageRenderer
                )
            );
          if (matches.length !== 1)
            fail('The next playlist page could not be identified. Nothing further was changed.');
          if (!targetId && matches[0].targetId) targetId = matches[0].targetId;
          scope = { contents: matches[0].continuationItems };
        }
      }
      const parsed = unpack(scope);
      if (parsed.next && state.seen.has(parsed.next.token))
        fail('YouTube Music repeated a playlist page. Stopped to avoid an incomplete sample.');
      // Commit a whole validated page at once. A retry requests only the unfinished page.
      state.rows.push(...parsed.rows);
      state.targetId = targetId;
      state.next = parsed.next;
      state.pages++;
      if (parsed.next) state.seen.add(parsed.next.token);
      else state.complete = true;
      if (onPage) onPage(state.rows.length);
      else say(label + ': ' + state.rows.length.toLocaleString() + ' entries');
    }
    if (!state.complete) fail('The playlist did not finish loading. Nothing further was changed.');
    return state.rows;
  }
  async function readCollection(sources) {
    const states = new Map();
    let queue = sources;
    const update = (source, state, count, extra = {}) => {
      const value = { state, count, ...extra };
      states.set(source.id, value);
      deps.onPlaylist?.(source, value);
      const done = [...states.values()].filter((v) => v.state === 'Loaded').length;
      const entries = [...states.values()].reduce((sum, v) => sum + v.count, 0);
      say(
        'Reading collection: ' +
          done +
          '/' +
          sources.length +
          ' playlists loaded · ' +
          entries.toLocaleString() +
          ' entries'
      );
    };
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      checkpoint();
      if (attempt) {
        for (const source of queue)
          update(source, 'Retrying ' + attempt + '/2', partialCache.get(source.id)?.rows.length || 0);
        say(
          'Retrying ' + queue.length + ' unfinished playlists (' + attempt + '/2). Cached progress is retained…'
        );
        await deps.delay?.(1000 * attempt);
        checkpoint();
      }
      let cursor = 0,
        fatal = null;
      const failed = [];
      async function worker() {
        while (!fatal && cursor < queue.length) {
          const source = queue[cursor++];
          try {
            checkpoint();
            let rows = cache.get(source.id);
            if (!rows) {
              let state = partialCache.get(source.id);
              if (!state) {
                state = newReadState();
                partialCache.set(source.id, state);
              }
              const label = attempt ? 'Retrying ' + attempt + '/2' : 'Loading';
              update(source, label, state.rows.length);
              rows = await readPlaylist(
                source.id,
                source.title,
                (count) => update(source, label, count),
                () => !!fatal,
                state
              );
              cache.set(source.id, rows);
              partialCache.delete(source.id);
            }
            const pool = uniqueAvailable(rows);
            update(source, 'Loaded', rows.length, {
              available: pool.videos.length,
              unavailable: pool.unavailable,
              duplicates: pool.duplicates
            });
          } catch (error) {
            if (deps.cancelled?.() || !retryableRead(error)) fatal ||= error;
            failed.push({ source, error });
            update(
              source,
              fatal ? 'Stopped' : attempt < MAX_READ_ATTEMPTS - 1 ? 'Waiting to retry' : 'Failed',
              states.get(source.id)?.count || 0
            );
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
      checkpoint();
      if (fatal) throw fatal;
      if (!failed.length) break;
      if (attempt === MAX_READ_ATTEMPTS - 1)
        fail(
          failed[0].source.title +
            ': ' +
            failed[0].error.message +
            ' Automatic read retries are exhausted; cached progress is retained.'
        );
      queue = failed.map((entry) => entry.source);
    }
    checkpoint();
    const rows = [];
    for (const source of sources) {
      if (!cache.has(source.id)) fail('A source playlist is incomplete. Nothing was created.');
      for (const row of cache.get(source.id)) rows.push(row);
    }
    return rows;
  }

  function uniqueAvailable(rows) {
    const videos = new Map(),
      dislikedIds = new Set();
    // A dislike on any occurrence excludes the ID from every source and fallback.
    for (const row of rows) if (row.disliked) dislikedIds.add(row.id);
    let unavailable = 0,
      duplicates = 0,
      disliked = 0;
    for (const row of rows) {
      if (dislikedIds.has(row.id)) {
        disliked++;
        continue;
      }
      if (!row.available) {
        unavailable++;
        continue;
      }
      if (videos.has(row.id)) {
        duplicates++;
        const previous = videos.get(row.id);
        // Preserve all readable credits when the same track appears in several sources.
        const credits = new Map(
          [...(previous.artists || []), ...(row.artists || [])].map((a) => [
            (a.id || '') + '\n' + nameKey(a.name),
            a
          ])
        );
        videos.set(row.id, { ...previous, artists: [...credits.values()] });
        continue;
      }
      videos.set(row.id, row);
    }
    return { videos: [...videos.values()], unavailable, duplicates, disliked };
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
    if (!p || !p.status) fail('YouTube Music did not return a playback result. Nothing was created.');
    if (p.status === 'OK') return true;
    const reason = [p.reason || '', ...find(p, 'reason').map(textOf), ...find(p, 'subreason').map(textOf)].join(
      ' '
    );
    if (/confirm.*not a bot|unusual traffic|automated|too many requests/i.test(reason))
      fail(
        'YouTube Music blocked the playback checks. Open a video normally, then run the tool again. Nothing was created.'
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
        (reason.trim() || 'YouTube Music supplied no reason.') +
        ' Nothing was created. The faster mode can use playlist availability flags instead.'
    );
  }

  function artistPool(videos) {
    // Join spelling/case variants and linked-ID aliases using only the cached credits.
    // Identical names share a conservative quota even if Music exposes different IDs.
    const keys = new Map(),
      parents = [];
    const root = (n) => {
      while (parents[n] !== n) {
        parents[n] = parents[parents[n]];
        n = parents[n];
      }
      return n;
    };
    const keyOf = (key) => {
      if (!keys.has(key)) {
        keys.set(key, parents.length);
        parents.push(parents.length);
      }
      return keys.get(key);
    };
    const candidates = videos.map((row) => {
      const groups = [];
      for (const artist of row.artists || []) {
        const name = nameKey(artist.name);
        if (!name) continue;
        const key = keyOf('name:' + name);
        if (artist.id) {
          const a = root(key),
            b = root(keyOf('id:' + artist.id));
          parents[Math.max(a, b)] = Math.min(a, b);
        }
        groups.push(key);
      }
      return { row, groups };
    });
    for (const candidate of candidates) candidate.groups = [...new Set(candidate.groups.map(root))];
    return candidates.filter((candidate) => candidate.groups.length);
  }
  async function select(rows, count, checkPlayback, artistPercent = 1) {
    checkpoint();
    const pool = uniqueAvailable(rows),
      limit = artistLimit(count, artistPercent);
    if (pool.videos.length < count)
      fail(
        'Only ' +
          pool.videos.length +
          ' distinct eligible tracks were found; ' +
          count +
          ' were requested. Nothing was created.'
      );
    const candidates = artistPool(pool.videos),
      unknownArtists = pool.videos.length - candidates.length;
    if (candidates.length < count)
      fail(
        'Only ' +
          candidates.length +
          ' distinct tracks have readable artist credits; ' +
          count +
          ' were requested. Nothing was created.'
      );
    // Extra passes can escape a greedy dead end involving collaborations. Every pass is finite.
    const maxAttempts = candidates.some((candidate) => candidate.groups.length > 1) ? 3 : 1;
    const playback = new Map();
    let rejected = 0,
      inspected = 0,
      selectionPasses = 0,
      best = [];
    const result = (selected, relaxed) => {
      const selectedIds = new Set(selected.map((row) => row.id)),
        totals = new Map();
      for (const candidate of candidates)
        if (selectedIds.has(candidate.row.id)) {
          for (const group of candidate.groups) totals.set(group, (totals.get(group) || 0) + 1);
        }
      return {
        ...pool,
        selected: shuffled(selected),
        rejected,
        unknownArtists,
        artistLimit: limit,
        artistLimitRelaxed: relaxed,
        selectionPasses,
        maxArtistCount: Math.max(0, ...totals.values())
      };
    };
    const playable = async (candidate) => {
      if (!checkPlayback) return true;
      const id = candidate.row.id;
      if (!playback.has(id)) {
        const ok = playbackStatus(await deps.post('player', { videoId: id }));
        playback.set(id, ok);
        if (!ok) rejected++;
      }
      return playback.get(id);
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      selectionPasses = attempt;
      const remaining = candidates.slice(),
        selected = [],
        counts = new Map();
      let pending = null;
      const adjust = (map, groups) => {
        for (const key of groups) map.set(key, (map.get(key) || 0) + 1);
      };
      while ((remaining.length || pending) && selected.length < count) {
        checkpoint();
        const batch = [],
          reserved = new Map();
        while ((remaining.length || pending) && batch.length < Math.min(3, count - selected.length)) {
          let candidate = pending;
          pending = null;
          if (!candidate) {
            // Draw each candidate once per pass; only one candidate can wait for the active batch.
            const index = deps.randomInt(remaining.length);
            candidate = remaining[index];
            remaining[index] = remaining[remaining.length - 1];
            remaining.pop();
            if (++inspected % 2048 === 0) {
              await deps.yield?.();
              checkpoint();
            }
          }
          if (playback.get(candidate.row.id) === false) continue;
          if (candidate.groups.some((key) => (counts.get(key) || 0) >= limit)) continue;
          // In-flight checks reserve slots too, so parallel checks cannot exceed the quota.
          if (candidate.groups.some((key) => (counts.get(key) || 0) + (reserved.get(key) || 0) >= limit)) {
            pending = candidate;
            break;
          }
          adjust(reserved, candidate.groups);
          batch.push(candidate);
        }
        if (!batch.length) break;
        const verdicts = await Promise.all(batch.map(playable));
        checkpoint();
        batch.forEach((candidate, i) => {
          if (verdicts[i]) {
            selected.push(candidate.row);
            adjust(counts, candidate.groups);
          }
        });
        say(
          (checkPlayback ? 'Checking playback: ' : 'Selecting tracks: ') +
            selected.length +
            ' of ' +
            count +
            ' ready · pass ' +
            attempt +
            '/' +
            maxAttempts +
            ' · max ' +
            limit +
            ' per artist' +
            (checkPlayback ? ' · ' + playback.size + ' checked' : '')
        );
      }
      if (selected.length === count) return result(selected, false);
      if (selected.length > best.length) best = selected;
    }
    // Keep the best candidate, then fill its vacancies even when the artist quota is exceeded.
    // Exhausting a finite pool also ends quota work early; no pointless retries are required.
    const selected = best.slice(),
      selectedIds = new Set(selected.map((row) => row.id));
    const remaining = candidates.filter(
      (candidate) => !selectedIds.has(candidate.row.id) && playback.get(candidate.row.id) !== false
    );
    while (remaining.length && selected.length < count) {
      checkpoint();
      const batch = [];
      while (remaining.length && batch.length < Math.min(3, count - selected.length)) {
        const index = deps.randomInt(remaining.length),
          candidate = remaining[index];
        remaining[index] = remaining[remaining.length - 1];
        remaining.pop();
        batch.push(candidate);
      }
      const verdicts = await Promise.all(batch.map(playable));
      checkpoint();
      batch.forEach((candidate, i) => {
        if (verdicts[i]) selected.push(candidate.row);
      });
      say(
        'Artist limit relaxed after ' +
          selectionPasses +
          ' selection passes: ' +
          selected.length +
          ' of ' +
          count +
          ' tracks ready'
      );
    }
    if (selected.length < count)
      fail(
        'Only ' +
          selected.length +
          ' tracks passed playback checks; ' +
          count +
          ' were requested. Nothing was created.'
      );
    return result(selected, true);
  }

  function validateJob(job) {
    if (
      !job ||
      job.version !== 2 ||
      !Array.isArray(job.sources) ||
      !job.sources.length ||
      job.sources.some((s) => !s || sourceId(s.id) !== s.id || !matchTitle(s.title)) ||
      new Set(job.sources.map((s) => s.id)).size !== job.sources.length ||
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
    if (
      job.destination &&
      (!/^[A-Za-z0-9_-]{2,150}$/.test(job.destination) || job.sources.some((s) => s.id === job.destination))
    )
      fail('The destination is invalid. Nothing was changed.');
  }
  async function verifyPrefix(job, exact = false) {
    const retryDelays = [2000, 5000, 10000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      checkpoint();
      try {
        const rows = await readPlaylist(job.destination, 'Checking new playlist');
        if (rows.length > job.ids.length || rows.some((r, i) => r.id !== job.ids[i]))
          throw Object.assign(
            new Error('The new playlist differs from the saved selection. Automatic changes stopped.'),
            { retryable: false }
          );
        if (rows.length < (job.confirmedCount || 0))
          fail('YouTube Music has not exposed the last confirmed batch yet.');
        if (exact && rows.length !== job.ids.length)
          fail(
            'The new playlist currently contains ' + rows.length + ' of ' + job.ids.length + ' expected tracks.'
          );
        if (!rows.length) fail('The new playlist is not visible yet.');
        return rows.length;
      } catch (error) {
        checkpoint();
        if (!retryableRead(error)) throw error;
        if (attempt === retryDelays.length)
          fail(
            error.message +
              ' Automatic checks are exhausted. Use “Finish saved playlist” to continue this same playlist.'
          );
        say(
          'Waiting for YouTube Music to show the new playlist’s tracks. Retrying in ' +
            retryDelays[attempt] / 1000 +
            ' seconds (' +
            (attempt + 1) +
            '/' +
            retryDelays.length +
            '). The selected songs are retained.'
        );
        await deps.delay(retryDelays[attempt]);
      }
    }
  }
  async function finish(job, newlyCreated = false) {
    validateJob(job);
    if (!job.destination)
      fail('The creation result is unknown. Check YouTube Music playlists before starting another copy.');
    checkpoint();
    // Re-read after any interruption. A lost response can still mean a successful write.
    let offset = await verifyPrefix(job);
    // A fresh destination can contain only the batch sent at creation, even after a reload.
    if ((newlyCreated || job.phase === 'created') && offset > Math.min(50, job.ids.length))
      fail('Unexpected creation result. Automatic changes stopped.');
    while (offset < job.ids.length) {
      checkpoint();
      const batch = job.ids.slice(offset, offset + 50);
      say('Adding tracks: ' + offset + ' of ' + job.ids.length);
      deps.save({ ...job, phase: 'adding' });
      const response = await deps.post(
        'browse/edit_playlist',
        {
          playlistId: job.destination,
          actions: batch.map((id) => ({
            action: 'ACTION_ADD_VIDEO',
            addedVideoId: id,
            dedupeOption: 'DEDUPE_OPTION_SKIP'
          }))
        },
        { write: true, destination: job.destination, sources: job.sources.map((s) => s.id) }
      );
      if (response.status !== 'STATUS_SUCCEEDED')
        fail('YouTube Music did not confirm the last batch. The saved playlist can be checked and continued.');
      offset += batch.length;
      job.confirmedCount = offset;
      deps.save({ ...job, phase: 'adding' });
    }
    checkpoint();
    say('Verifying the complete track order…');
    await verifyPrefix(job, true);
    deps.save(null);
    return job;
  }
  async function run(options) {
    const title = options.title.trim(),
      count = Number(options.count);
    const artistPercent = Number(options.artistPercent ?? 1);
    if (!Number.isSafeInteger(count) || count < 1 || count > 5000) fail('Choose a whole number from 1 to 5,000.');
    artistLimit(count, artistPercent);
    if (!title || [...title].length > 150) fail('Use a playlist name of 1 to 150 characters.');
    if (!catalog?.complete || !catalog.playlists.length)
      fail('No complete collection of matching source playlists was found. Nothing was created.');
    const sources = catalog.playlists.map((p) => ({ ...p }));
    const rows = await readCollection(sources);
    const selection = await select(rows, count, options.checkPlayback, artistPercent);
    deps.summary?.(
      sources.length +
        ' source playlists · ' +
        rows.length.toLocaleString() +
        ' entries · ' +
        selection.videos.length.toLocaleString() +
        ' distinct eligible tracks · ' +
        selection.duplicates.toLocaleString() +
        ' repeated IDs skipped · ' +
        selection.unavailable +
        ' unavailable entries skipped · ' +
        selection.disliked.toLocaleString() +
        ' disliked entries skipped · ' +
        selection.rejected +
        ' failed playback checks · ' +
        selection.unknownArtists +
        ' tracks without artist credits skipped · ' +
        (selection.artistLimitRelaxed
          ? 'Artist limit relaxed after ' +
            selection.selectionPasses +
            ' selection passes' +
            '; highest artist count: ' +
            selection.maxArtistCount
          : 'max ' + selection.artistLimit + ' tracks per artist')
    );
    checkpoint();
    const job = {
      version: 2,
      sources,
      title,
      ids: selection.selected.map((r) => r.id),
      artistPercent,
      selectionPasses: selection.selectionPasses,
      artistLimitRelaxed: selection.artistLimitRelaxed,
      artistLimit: selection.artistLimit,
      maxArtistCount: selection.maxArtistCount,
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
      { write: true, sources: sources.map((s) => s.id) }
    );
    if (typeof response.playlistId !== 'string' || !response.playlistId)
      fail(
        'YouTube Music did not return a new playlist address. Creation may have succeeded; check YouTube Music playlists before trying again.'
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
  return {
    sourceId,
    roman,
    matchTitle,
    diagnostics,
    discover,
    libraryCard,
    artistCredits,
    artistLimit,
    musicRow,
    readPlaylist,
    readCollection,
    uniqueAvailable,
    shuffled,
    playbackStatus,
    select,
    validateJob,
    finish,
    run
  };
}

function launchMusicCollectionSampler(makeCore) {
  'use strict';
  const ORIGIN = 'https://music.youtube.com';
  const ROOT_ID = 'youtube-music-collection-sample-panel';
  const STORE = 'youtube-music-collection-sample-job-v1';
  if (location.origin !== ORIGIN) {
    alert('Open https://music.youtube.com while signed in, then click the ⤨ bookmark.');
    return;
  }
  if (document.getElementById(ROOT_ID)) return;
  const cfg = (key) => window.ytcfg?.get?.(key) ?? window.yt?.config_?.[key];
  const identity = () =>
    JSON.stringify([cfg('SESSION_INDEX') ?? 0, cfg('DELEGATED_SESSION_ID') || '', cfg('DATASYNC_ID') || '']);
  const account = identity();
  const originalContext = cfg('INNERTUBE_CONTEXT');
  if (
    !originalContext?.client?.clientVersion ||
    !['WEB_REMIX', 67].includes(originalContext.client.clientName) ||
    cfg('LOGGED_IN') === false
  ) {
    alert('Sign in to YouTube Music and reload the page, then click ⤨ again.');
    return;
  }
  const context = JSON.parse(JSON.stringify(originalContext));
  context.client.clientName = 'WEB_REMIX';
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
    if (!sid) throw new Error('The current YouTube Music sign-in could not be used. Sign in and reload the page.');
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
    if (options.continuation && endpoint !== 'browse') throw new Error('An unsupported continuation was blocked.');
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
        !Array.isArray(options.sources) ||
        options.sources.includes(payload.playlistId) ||
        journal?.sources?.some((s) => s.id === payload.playlistId) ||
        journal?.destination !== payload.playlistId ||
        !payload.actions?.length ||
        payload.actions.length > 50 ||
        payload.actions.some(
          (a) =>
            a.action !== 'ACTION_ADD_VIDEO' ||
            a.dedupeOption !== 'DEDUPE_OPTION_SKIP' ||
            !journal.ids.includes(a.addedVideoId)
        ))
    )
      throw new Error('A request outside the new playlist was blocked.');
    for (let attempt = 0; attempt < (isWrite ? 1 : 3); attempt++) {
      if (stopped) throw new Error('Stopped.');
      if (identity() !== account || cfg('LOGGED_IN') === false)
        throw new Error('The selected YouTube Music account changed. Reload before continuing.');
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': await auth(),
        'X-Origin': ORIGIN,
        'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
        'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 67),
        'X-Youtube-Client-Version': context.client.clientVersion
      };
      if (cfg('DELEGATED_SESSION_ID')) headers['X-Goog-PageId'] = cfg('DELEGATED_SESSION_ID');
      if (context.client.visitorData) headers['X-Goog-Visitor-Id'] = context.client.visitorData;
      const key = cfg('INNERTUBE_API_KEY');
      const continuationQuery = options.continuation
        ? '&ctoken=' +
          encodeURIComponent(options.continuation) +
          '&continuation=' +
          encodeURIComponent(options.continuation) +
          '&type=next'
        : '';
      const url =
        ORIGIN +
        '/youtubei/v1/' +
        endpoint +
        '?prettyPrint=false' +
        (key ? '&key=' + encodeURIComponent(key) : '') +
        continuationQuery;
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
          throw new Error('YouTube Music returned HTTP ' + response.status + '.');
        }
        const json = await response.json();
        if (json.error) throw new Error('YouTube Music: ' + (json.error.message || 'request rejected'));
        if (json.responseContext?.visitorData) context.client.visitorData = json.responseContext.visitorData;
        return json;
      } catch (error) {
        // Writes are never blindly retried: a timeout can happen after YouTube Music committed them.
        if (!isWrite && attempt < 2 && (error instanceof TypeError || error.name === 'AbortError')) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        if (error.name === 'AbortError') throw new Error('The YouTube Music request timed out.');
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
    .box{width:min(800px,100%);max-height:92vh;overflow:auto;background:#151b24;border:1px solid #47515e;border-radius:18px;padding:26px;box-shadow:0 24px 80px #0008}
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
    .source-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:20px}.source-head strong{font-size:16px}
    .sources{border:1px solid #384757;border-radius:10px;overflow:auto;max-height:310px;margin-top:10px}
    table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}th{position:sticky;top:0;background:#22303c;color:#bdccd8;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
    td,th{padding:9px 12px;border-bottom:1px solid #33414e;vertical-align:top}td:first-child{color:#8de8d6;width:55px}td:last-child{width:140px;font-size:12px}tbody tr:last-child td{border-bottom:0}
    .playlist-name{color:#eaf0f4;white-space:pre-wrap;overflow-wrap:anywhere}.playlist-id{font-size:10px;overflow-wrap:anywhere}.warnings{color:#ebc589;font-size:12px;white-space:pre-wrap}details{font-size:12px;color:#b8c4d1;margin:10px 0}summary{cursor:pointer}details a{color:#b8c4d1;white-space:pre-wrap}li{margin:6px 0}
    .fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:end}.fields>div{min-width:0}.pattern{font:12px/1.5 ui-monospace,monospace;color:#8de8d6}
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
  element('div', box, 'YOUTUBE MUSIC · 2.1.1', { class: 'eyebrow' });
  element('h2', box, 'Random Songs', { id: 'sampler-title' });
  element(
    'p',
    box,
    'Create a private playlist from the whole collection. Matching sources appear below as the tool works; creation continues automatically.'
  );
  element('div', box, "[spaces / underscores]Alfredo's[spaces]__ROMAN__", { class: 'pattern' });
  const sourceHead = element('div', box, '', { class: 'source-head' });
  const sourceCount = element('strong', sourceHead, 'Source playlists will appear here');
  const sourceNote = element(
    'small',
    box,
    'Every library page is checked. There is no fixed limit on the number of matching playlists.'
  );
  const sourceWarnings = element('p', box, '', { class: 'warnings' });
  const sourceScroll = element('div', box, '', {
    class: 'sources',
    tabindex: '0',
    'aria-label': 'Matching source playlists'
  });
  const table = element('table', sourceScroll);
  const heading = element('tr', element('thead', table));
  for (const label of ['No.', 'Exact playlist name', 'Track scan'])
    element('th', heading, label, { scope: 'col' });
  const tbody = element('tbody', table);
  const similar = element('details', box);
  similar.hidden = true;
  const similarTitle = element('summary', similar);
  const similarList = element('ul', similar);
  let currentCatalog = null;
  const rowCells = new Map();

  function renderCatalog(value) {
    currentCatalog = value;
    sourceCount.textContent =
      value.playlists.length + ' matching source playlists' + (value.complete ? '' : ' · finding…');
    sourceNote.textContent = value.complete
      ? 'All ' + value.scanned + ' library playlists inspected. Every source below contributes to this selection.'
      : 'Reading every library page. Track scanning starts automatically when discovery finishes.';
    tbody.replaceChildren();
    rowCells.clear();
    for (const source of value.playlists) {
      const tr = element('tr', tbody);
      element('td', tr, source.roman);
      const name = element('td', tr);
      element('a', name, source.title, {
        href: ORIGIN + '/playlist?list=' + encodeURIComponent(source.id),
        target: '_blank',
        rel: 'noopener noreferrer',
        class: 'playlist-name'
      });
      element('small', name, source.id, { class: 'playlist-id' });
      rowCells.set(source.id, element('td', tr, 'Not read yet'));
    }
    const info = core.diagnostics(value.playlists),
      warnings = [];
    const abbreviate = (items) =>
      items.slice(0, 30).join(', ') + (items.length > 30 ? ' … (' + items.length + ' total)' : '');
    if (info.missing.length)
      warnings.push(
        'Numeral gaps: ' + abbreviate(info.missing) + '. Check for a missing playlist or a different name.'
      );
    if (info.repeated.length)
      warnings.push(
        'Repeated numerals: ' + abbreviate(info.repeated) + '. All distinct playlist IDs are included.'
      );
    if (value.complete && !value.playlists.length)
      warnings.push('No matching playlists found. Check the selected Music account and the exact naming pattern.');
    sourceWarnings.textContent = warnings.join('\n');
    similar.hidden = !value.similar.length;
    similarTitle.textContent = value.similar.length + ' similar names excluded by the pattern';
    similarList.replaceChildren();
    for (const source of value.similar)
      element('a', element('li', similarList), source.title, {
        href: ORIGIN + '/playlist?list=' + encodeURIComponent(source.id),
        target: '_blank',
        rel: 'noopener noreferrer'
      });
  }

  function renderPlaylist(source, value) {
    const cell = rowCells.get(source.id);
    if (!cell) return;
    cell.textContent = value.state + (value.count ? ' · ' + value.count.toLocaleString() + ' entries' : '');
    if (value.state === 'Loaded')
      element(
        'small',
        cell,
        value.available.toLocaleString() +
          ' distinct eligible' +
          (value.unavailable ? ' · ' + value.unavailable + ' unavailable' : '')
      );
  }
  const form = element('form', box);
  const fields = element('div', form, '', { class: 'fields' });

  function input(label, id, type, value, parent = fields) {
    const group = element('div', parent);
    element('label', group, label, { for: id });
    const field = element('input', group, '', { id, type, required: '', autocomplete: 'off' });
    field.value = value;
    return field;
  }
  const count = input('Number of songs (N)', 'sample-count', 'number', '200');
  count.min = '1';
  count.max = '5000';
  count.step = '1';
  const percent = input('Maximum percentage per artist (%)', 'artist-percent', 'number', '1');
  percent.min = '0.01';
  percent.max = '100';
  percent.step = '0.01';
  const title = input('New playlist name', 'sample-name', 'text', 'Music Taste I', form);
  title.maxLength = 150;
  const artistNote = element('small', form, '', { 'aria-live': 'polite' });
  const updateArtistNote = () => {
    const n = Number(count.value),
      p = Number(percent.value);
    const hundredths = Math.round(p * 100);
    artistNote.textContent =
      Number.isSafeInteger(n) &&
      n >= 1 &&
      n <= 5000 &&
      Number.isFinite(p) &&
      p >= 0.01 &&
      p <= 100 &&
      p === hundredths / 100
        ? 'Artist limit: ' +
          Math.max(1, Math.round((n * hundredths) / 10000)) +
          ' tracks per credited artist (' +
          p +
          '% rounded, minimum 1). Collaborations count for every credited artist.'
        : 'Choose a percentage from 0.01 to 100 with up to two decimal places. The artist limit is rounded to the nearest integer, with a minimum of 1 track.';
  };
  count.addEventListener('input', updateArtistNote);
  percent.addEventListener('input', updateArtistNote);
  updateArtistNote();
  element(
    'small',
    form,
    'Up to three complete selection passes are allowed. If they cannot fill the playlist, remaining places are filled even if an artist exceeds the limit.'
  );
  const checkLabel = element('label', form, '', { class: 'checks' });
  const check = element('input', checkLabel, '', { type: 'checkbox' });
  check.checked = false;
  const checkText = element('span', checkLabel, 'Check playback availability');
  element(
    'small',
    checkText,
    'Off by default for speed; entries marked unavailable are still skipped. Enable to check each candidate before adding it.'
  );
  element(
    'small',
    form,
    'The first full track scan can take several minutes. Every run checks for new matching playlists. Completed track reads are reused while this panel stays open; close and reopen for fresh track lists and ratings. Disliked songs are excluded from every selection.'
  );
  const actions = element('div', form, '', { class: 'actions' });
  const create = element('button', actions, 'Create playlist', { type: 'submit', class: 'primary' });
  const stop = element('button', actions, 'Cancel', { type: 'button' });
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
  element('small', recovery, 'Clearing this record leaves any created playlist on YouTube Music.');
  const previousFocus = document.activeElement;
  document.documentElement.append(host);
  count.focus();

  function showLink(job) {
    if (!job?.destination || !/^[A-Za-z0-9_-]{2,150}$/.test(job.destination)) {
      result.hidden = true;
      return;
    }
    result.href = ORIGIN + '/playlist?list=' + encodeURIComponent(job.destination);
    result.textContent = 'Open “' + job.title + '” on YouTube Music';
    result.hidden = false;
  }

  function updateRecovery() {
    recovery.hidden = !journal || running;
    if (!journal) return;
    showLink(journal);
    const sameAccount = journal.account === account;
    recoveryText.textContent = !sameAccount
      ? 'A saved attempt belongs to another YouTube Music account. Switch back to that account to continue.'
      : journal.destination
        ? 'A playlist was created but has not been fully verified. Continuing checks its existing tracks before adding any missing ones.'
        : 'A creation request was started, but its result is unknown. Check the YouTube Music Playlists page for “' +
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
    yield: () => delay(0),
    cancelled: () => stopped,
    save,
    onCatalog: renderCatalog,
    onPlaylist: renderPlaylist,
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
      'A saved attempt could not be read. Check YouTube Music playlists before creating another copy.';
  }

  function setRunning(value) {
    running = value;
    [count, title, percent, check, close, resume, discard].forEach((el) => (el.disabled = value));
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
      if (!continuing) {
        currentCatalog = null;
        sourceCount.textContent = 'Finding source playlists…';
        tbody.replaceChildren();
        rowCells.clear();
        sourceNote.textContent = 'Reading every page of the selected account’s Music library…';
        sourceWarnings.textContent = '';
        similar.hidden = true;
        await core.discover({ clearCache: false });
      }
      const job = continuing
        ? await core.finish(journal)
        : await core.run({
            count: count.value,
            title: title.value,
            artistPercent: percent.value,
            checkPlayback: check.checked
          });
      status.textContent =
        'Done. ' +
        job.ids.length +
        ' distinct tracks; the saved order was verified.' +
        (job.artistLimitRelaxed
          ? '\nArtist limit relaxed to fill the playlist. Highest artist count: ' +
            job.maxArtistCount +
            ' (target: ' +
            job.artistLimit +
            ').'
          : '');
      showLink(job);
    } catch (error) {
      if (!continuing && !currentCatalog?.complete)
        sourceNote.textContent = 'Discovery is incomplete. Create playlist will retry it.';
      status.textContent = error.message || 'The request could not be completed.';
      if (journal)
        status.textContent += journal.destination
          ? '\nA partial or complete playlist exists. Its address is below.'
          : '\nA playlist may already exist. Check YouTube Music playlists before retrying.';
    } finally {
      setRunning(false);
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!create.disabled) execute(false);
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
      const focusable = [...shadow.querySelectorAll('input,button,a[href],summary,[tabindex="0"]')].filter(
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
  if (journal) {
    renderCatalog({
      complete: false,
      playlists: journal.sources.map((s) => ({ ...s, ...core.matchTitle(s.title) })),
      similar: [],
      scanned: journal.sources.length
    });
    sourceCount.textContent = journal.sources.length + ' sources from the saved attempt';
    sourceNote.textContent = 'The saved selection is protected against changes to all of these source playlists.';
  }
  setRunning(false);
}

launchMusicCollectionSampler(makeCollectionSamplerCore);
