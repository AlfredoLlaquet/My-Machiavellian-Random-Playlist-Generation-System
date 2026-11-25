/* List Artists 2.2.0 — self-contained YouTube Music tool, no external dependencies. */
function makeCollectionArtistsCore(deps) {
  'use strict';
  let catalog = null;
  const cache = new Map();
  const albumCache = new Map();
  const subscriptionCache = new Map(),
    subscribedChannels = new Set();
  const MAX_READ_ATTEMPTS = 3;
  const fail = (message) => {
    throw new Error(message);
  };
  const checkpoint = () => {
    if (deps.cancelled?.()) fail('Stopped.');
  };
  const mustStop = (error) => deps.cancelled?.() || error?.fatal === true;
  const retryableRead = (error) =>
    error?.retryable !== false && !/HTTP (?:401|403|404)\b/i.test(error?.message || '');
  const say = (message) => deps.progress?.(message);
  async function retryRead(read, halt) {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      checkpoint();
      if (halt?.()) throw Object.assign(new Error('Source scan stopped.'), { fatal: true });
      try {
        const value = await read();
        checkpoint();
        return value;
      } catch (error) {
        if (mustStop(error) || !retryableRead(error) || attempt === MAX_READ_ATTEMPTS - 1) throw error;
        await deps.delay?.(1000 * (attempt + 1));
      }
    }
  }
  const textOf = (value) =>
    typeof value === 'string' ? value : value?.simpleText || value?.runs?.map((r) => r.text || '').join('') || '';

  function find(node, key, found = []) {
    if (!node || typeof node !== 'object') return found;
    if (Object.prototype.hasOwnProperty.call(node, key)) found.push(node[key]);
    for (const value of Object.values(node)) find(value, key, found);
    return found;
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
      if (item?.continuationItemRenderer) {
        const commands = find(item.continuationItemRenderer, 'continuationCommand');
        if (!commands.length || commands.some((c) => typeof c?.token !== 'string' || !c.token))
          fail('The next page could not be read.');
        tokens.push(...commands.map((c) => ({ token: c.token, mode: 'body' })));
      }
    for (const entry of scope.continuations || []) {
      const token = entry?.nextContinuationData?.continuation;
      if (typeof token !== 'string' || !token) fail('The next page could not be read.');
      tokens.push({ token, mode: 'query' });
    }
    const unique = [...new Map(tokens.map((t) => [t.token, t])).values()];
    if (unique.length > 1) fail('The next page could not be identified.');
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
  async function discover({ clearCache = true, clearAlbums = false } = {}) {
    catalog = null;
    if (clearCache) cache.clear();
    if (clearAlbums) albumCache.clear();
    checkpoint();
    const records = new Map(),
      seen = new Set();
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
    try {
      let scope = await retryRead(async () => {
          const value = libraryScope(await deps.post('browse', { browseId: 'FEmusic_liked_playlists' }));
          if (!Array.isArray(value.items || value.contents))
            fail('The library page could not be read completely.');
          return value;
        }),
        targetId = scope.targetId || null;
      for (let page = 0; page < 1000; page++) {
        checkpoint();
        const items = scope.items || scope.contents;
        if (!Array.isArray(items)) fail('The library page could not be read completely.');
        for (const item of items) {
          try {
            const record = libraryCard(item);
            if (record) records.set(record.id, record);
          } catch (error) {
            if (mustStop(error)) throw error;
          }
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
        scope = await retryRead(async () => {
          const json =
            next.mode === 'query'
              ? await deps.post('browse', { browseId: 'FEmusic_liked_playlists' }, { continuation: next.token })
              : await deps.post('browse', { continuation: next.token });
          const legacy =
            json.continuationContents?.gridContinuation || json.continuationContents?.musicShelfContinuation;
          if (legacy) {
            if (!Array.isArray(legacy.items || legacy.contents))
              fail('The library page could not be read completely.');
            return legacy;
          }
          const actions = [
            ...find(json.onResponseReceivedActions, 'appendContinuationItemsAction'),
            ...find(json.onResponseReceivedEndpoints, 'appendContinuationItemsAction'),
            ...find(json.onResponseReceivedCommands, 'appendContinuationItemsAction')
          ];
          let matches = actions.filter((a) => targetId && a.targetId === targetId);
          if (!matches.length)
            matches = actions.filter((a) => (!a.targetId || !targetId) && Array.isArray(a.continuationItems));
          if (matches.length !== 1)
            fail('The next library page could not be identified. Discovery is incomplete.');
          if (!targetId && matches[0].targetId) targetId = matches[0].targetId;
          if (!Array.isArray(matches[0].continuationItems)) fail('The library page could not be read completely.');
          return { items: matches[0].continuationItems };
        });
      }
    } catch (error) {
      if (mustStop(error)) throw error;
    }
    catalog = snapshot(false);
    deps.onCatalog?.(catalog);
    return catalog;
  }
  const cleanName = (value) =>
    String(value || '')
      .normalize('NFC')
      .replace(/\s+/gu, ' ')
      .trim();
  const nameKey = (value) => cleanName(value).toLocaleLowerCase('en');
  const artistId = (id) =>
    typeof id === 'string' && /^(?:MPLA)?UC[A-Za-z0-9_-]+$/.test(id) ? id.replace(/^MPLA/, '') : id;
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  const compareNames = (a, b) => collator.compare(a, b) || a.localeCompare(b, 'en');

  function artistCredits(r, columns, titleIndex) {
    const endpoint = (run) => run.navigationEndpoint?.browseEndpoint;
    const pageType = (run) =>
      endpoint(run)?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
    const isArtist = (run) => {
      const e = endpoint(run),
        type = pageType(run);
      if (!e) return false;
      if (['MUSIC_PAGE_TYPE_ARTIST', 'MUSIC_PAGE_TYPE_UNKNOWN'].includes(type))
        return !/^(?:MPRE|VL)/.test(e.browseId || '');
      return !type && /^(?:MPLA)?UC/.test(e.browseId || '');
    };
    const runsOf = (text) => text?.runs || (text?.simpleText ? [{ text: text.simpleText }] : []);
    const noise = (text) =>
      !text ||
      /^(?:[•·,&/]+|and|feat\.?|ft\.?|featuring|with|song|video|album|single|unknown artist)$/i.test(text) ||
      /^\d+:\d{2}(?::\d{2})?$/.test(text) ||
      /^[\d.,]+[KMB]?\s+(?:views?|plays?|subscribers?|listeners?)$/i.test(text);
    const hasPlainCredit = (text, index) =>
      index !== titleIndex && runsOf(text).some((run) => !run.navigationEndpoint && !noise(cleanName(run.text)));
    let indexes = columns.map((text, index) => (runsOf(text).some(isArtist) ? index : -1)).filter((i) => i >= 0);
    if (
      !indexes.length &&
      columns[1] &&
      hasPlainCredit(columns[1], 1) &&
      !runsOf(columns[1]).some((run) => run.navigationEndpoint)
    )
      indexes = [1];
    if (!indexes.length) {
      const channels = columns
        .map((text, index) =>
          runsOf(text).some((run) => pageType(run) === 'MUSIC_PAGE_TYPE_USER_CHANNEL') ? index : -1
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
        } else if (metadata || index === titleIndex) continue;
        const id = typeof e?.browseId === 'string' ? artistId(e.browseId) : null;
        const key = (id || '') + '\n' + nameKey(name);
        if (!credits.has(key)) credits.set(key, { name, id });
      }
    }
    return [...credits.values()];
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
    const albums = new Map();
    for (const column of columns)
      for (const run of column?.runs || []) {
        const endpoint = run.navigationEndpoint?.browseEndpoint;
        if (!endpoint) continue;
        const type = endpoint.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
        if (
          (type === 'MUSIC_PAGE_TYPE_ALBUM' || /^MPRE/.test(endpoint.browseId || '')) &&
          /^[A-Za-z0-9_-]+$/.test(endpoint.browseId || '')
        )
          albums.set(endpoint.browseId, { id: endpoint.browseId, name: cleanName(run.text) });
      }
    return {
      id,
      artists: artistCredits(r, columns, columns.indexOf(titleColumn || columns[0])),
      album: albums.size === 1 ? albums.values().next().value : null,
      available: !unavailable
    };
  }

  function unpack(scope) {
    if (!Array.isArray(scope?.contents)) fail('The playlist page could not be read.');
    const rows = [],
      items = scope.contents;
    for (const item of items)
      if (item?.musicResponsiveListItemRenderer) {
        try {
          rows.push(musicRow(item.musicResponsiveListItemRenderer));
        } catch (error) {
          if (mustStop(error)) throw error;
        }
      }
    return { rows, next: nextPage(scope, items) };
  }
  const newReadState = () => ({
    rows: [],
    seen: new Set(),
    next: null,
    targetId: null,
    pages: 0,
    complete: false,
    blocked: false
  });
  async function readPlaylist(id, label = 'Reading source', onPage, halt, state = newReadState()) {
    try {
      checkpoint();
      while (!state.complete && !state.blocked && state.pages < 1000) {
        const next = state.next;
        const parsed = await retryRead(async () => {
          const json = next
            ? next.mode === 'query'
              ? await deps.post('browse', { browseId: 'VL' + id }, { continuation: next.token })
              : await deps.post('browse', { continuation: next.token })
            : await deps.post('browse', { browseId: 'VL' + id });
          const errors = find(json?.alerts, 'alertRenderer').filter((a) => a.type === 'ERROR');
          if (errors.length) fail(textOf(errors[0].text) || 'YouTube Music could not open this playlist.');
          let scope,
            targetId = state.targetId;
          if (!next) {
            const allLists = find(json?.contents, 'musicPlaylistShelfRenderer');
            const identified = allLists.filter(
              (r) => [id, 'VL' + id].includes(r.playlistId) || [id, 'VL' + id].includes(r.targetId)
            );
            const lists = identified.length ? identified : allLists.filter((r) => !r.playlistId);
            if (lists.length !== 1) fail('The playlist could not be read.');
            scope = lists[0];
            targetId = scope.targetId || null;
          } else {
            const legacy =
              json.continuationContents?.musicPlaylistShelfContinuation ||
              json.continuationContents?.musicShelfContinuation;
            if (legacy) scope = legacy;
            else {
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
                        item.musicResponsiveListItemRenderer ||
                        item.continuationItemRenderer ||
                        item.messageRenderer
                    )
                );
              if (matches.length !== 1) fail('The next playlist page could not be identified.');
              if (!targetId && matches[0].targetId) targetId = matches[0].targetId;
              scope = { contents: matches[0].continuationItems };
            }
          }
          return { ...unpack(scope), targetId };
        }, halt);
        // Commit a validated page once; retries resume the unfinished page.
        state.rows.push(...parsed.rows);
        state.targetId = parsed.targetId;
        state.pages++;
        if (onPage) onPage(state.rows.length);
        else say(label + ': ' + state.rows.length.toLocaleString() + ' entries');
        if (!parsed.next) state.complete = true;
        else if (state.seen.has(parsed.next.token)) state.blocked = true;
        else {
          state.seen.add(parsed.next.token);
          state.next = parsed.next;
        }
      }
      if (!state.complete && state.pages >= 1000) state.blocked = true;
    } catch (error) {
      if (mustStop(error)) throw error;
    }
    return state.rows;
  }
  async function readCollection(sources) {
    const states = new Map();
    let cursor = 0,
      failure = null;
    const update = (source, state, count, extra = {}) => {
      const value = { state, count, ...extra };
      states.set(source.id, value);
      deps.onPlaylist?.(source, value);
      const done = [...states.values()].filter((v) => v.state === 'Read').length;
      const entries = [...states.values()].reduce((sum, v) => sum + v.count, 0);
      say(
        'Reading collection: ' +
          done +
          '/' +
          sources.length +
          ' playlists read · ' +
          entries.toLocaleString() +
          ' entries'
      );
    };
    async function worker() {
      while (!failure && cursor < sources.length) {
        const source = sources[cursor++];
        try {
          checkpoint();
          let state = cache.get(source.id);
          if (!state) {
            state = newReadState();
            cache.set(source.id, state);
          }
          update(source, 'Loading', state.rows.length);
          const rows = await readPlaylist(
            source.id,
            source.title,
            (count) => update(source, 'Loading', count),
            () => !!failure,
            state
          );
          update(source, 'Read', rows.length);
        } catch (error) {
          if (mustStop(error)) {
            if (!failure) failure = error;
            return;
          }
          update(source, 'Read', cache.get(source.id)?.rows.length || 0);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, sources.length) }, worker));
    if (failure) throw failure;
    checkpoint();
    const rows = [];
    for (const source of sources) {
      const state = cache.get(source.id);
      for (const row of state?.rows || []) rows.push(row);
      if (state?.blocked) cache.delete(source.id);
    }
    return rows;
  }
  const isVarious = (name) =>
    /^(?:various artists|various performers|varios artistas|artistas varios|diversos artistes|varis artistes|artistes diversos|verschiedene interpreten|artistes divers|artisti vari|vários artistas)$/iu.test(
      cleanName(name)
    );

  function parseAlbum(json) {
    if (!json || typeof json !== 'object') return { artist: null, various: false };
    if (find(json.alerts, 'alertRenderer').some((a) => a.type === 'ERROR'))
      return { artist: null, various: false };
    let headers = [json.header?.musicResponsiveHeaderRenderer, json.header?.musicDetailHeaderRenderer].filter(
      Boolean
    );
    if (!headers.length) {
      const tabs =
        json.contents?.twoColumnBrowseResultsRenderer?.tabs ||
        json.contents?.singleColumnBrowseResultsRenderer?.tabs;
      const tab = tabs && (tabs.find((t) => t.tabRenderer?.selected)?.tabRenderer || tabs[0]?.tabRenderer);
      const root = tab ? tab.content : json.contents;
      headers = [...find(root, 'musicResponsiveHeaderRenderer'), ...find(root, 'musicDetailHeaderRenderer')];
    }
    if (headers.length !== 1) return { artist: null, various: false };
    const header = headers[0];
    let artistText = header.straplineTextOne;
    if (!textOf(artistText)) {
      const raw =
        header.subtitle?.runs ||
        textOf(header.subtitle)
          .split(/([•·])/)
          .map((text) => ({ text }));
      const sections = [[]];
      for (const run of raw) {
        if (/^[•·]$/.test(cleanName(run.text))) sections.push([]);
        else sections.at(-1).push(run);
      }
      const linked = sections.find((runs) =>
        runs.some((run) => {
          const e = run.navigationEndpoint?.browseEndpoint;
          const type = e?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
          return type === 'MUSIC_PAGE_TYPE_ARTIST' || (!type && /^(?:MPLA)?UC/.test(e?.browseId || ''));
        })
      );
      if (linked) artistText = { runs: linked };
      else if (
        sections.length > 1 &&
        /^(?:album|single|ep|compilation|soundtrack|release)$/i.test(textOf({ runs: sections[0] }).trim())
      )
        artistText = { runs: sections[1] };
    }
    const artists = artistCredits(null, [{}, artistText], 0);
    const various = artists.some((artist) => isVarious(artist.name));
    return { artist: various ? null : artists[0] || null, various };
  }
  async function resolveAlbums(rows) {
    const albums = new Map();
    for (const row of rows)
      if (/^[A-Za-z0-9_-]{11}$/.test(row.id) && row.album?.id) albums.set(row.album.id, row.album);
    let pending = [...albums.values()].filter((album) => !albumCache.has(album.id));
    const completed = new Set([...albums.keys()].filter((id) => albumCache.has(id)));
    const progress = () =>
      say(
        'Reading album artists: ' +
          completed.size.toLocaleString() +
          ' of ' +
          albums.size.toLocaleString() +
          ' albums'
      );
    progress();
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS && pending.length; attempt++) {
      checkpoint();
      if (attempt) {
        await deps.delay?.(1000 * attempt);
        checkpoint();
      }
      let cursor = 0,
        failure = null;
      const again = [];
      async function worker() {
        while (!failure && cursor < pending.length) {
          const album = pending[cursor++];
          try {
            checkpoint();
            const metadata = parseAlbum(await deps.post('browse', { browseId: album.id }));
            checkpoint();
            if (!metadata.various && !metadata.artist?.name) fail('Album ownership is unavailable.');
            albumCache.set(album.id, metadata);
            completed.add(album.id);
          } catch (error) {
            if (mustStop(error)) {
              if (!failure) failure = error;
              return;
            }
            if (attempt < MAX_READ_ATTEMPTS - 1 && retryableRead(error)) again.push(album);
            else completed.add(album.id);
          }
          progress();
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
      if (failure) throw failure;
      pending = again;
    }
    checkpoint();
    return albums.size;
  }

  function validateMinimum(minimum) {
    if (!Number.isSafeInteger(minimum) || minimum < 1) fail('The minimum must be a positive whole number.');
  }

  function filterResult(result, minimum = 15) {
    validateMinimum(minimum);
    const qualifying = result.counts
      .filter((artist) => artist.count >= minimum)
      .sort((a, b) => b.count - a.count || compareNames(a.name, b.name));
    const names = qualifying.map((artist) => artist.name);
    const text = qualifying
      .map((artist) => '"' + artist.name.replaceAll('"', '""') + '",' + artist.count)
      .join('\n');
    return { ...result, names, text, minimum, qualifying };
  }
  async function countArtists(rows, minimum = 15) {
    validateMinimum(minimum);
    const albumCount = await resolveAlbums(rows);
    const idsByName = new Map(),
      tracks = new Map(),
      groups = new Map();
    let missingId = 0,
      unavailableEntries = 0,
      ambiguousCredits = 0,
      noAlbum = 0,
      conflictingOwners = 0,
      albumTracks = 0,
      compilationTracks = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i % 5000 === 0) {
        checkpoint();
        say(
          'Assigning tracks to album artists: ' +
            i.toLocaleString() +
            ' of ' +
            rows.length.toLocaleString() +
            ' entries'
        );
        await deps.yield?.();
      }
      const row = rows[i];
      if (!/^[A-Za-z0-9_-]{11}$/.test(row.id)) {
        missingId++;
        continue;
      }
      if (!tracks.has(row.id)) tracks.set(row.id, { candidates: new Map(), hasAlbum: false });
      const track = tracks.get(row.id);
      if (!row.available) unavailableEntries++;
      if (!row.album?.id) continue;
      track.hasAlbum = true;
      const album = albumCache.get(row.album.id);
      const artist = album?.various ? row.artists?.[0] : album?.artist;
      if (!artist?.name || isVarious(artist.name)) continue;
      const name = cleanName(artist.name),
        rank = album.various ? 1 : 0,
        id = artistId(artist.id) || null;
      const key = rank + ':' + (id || nameKey(name));
      track.candidates.set(key, { artist: { name, id }, rank });
      if (id) {
        const normalized = nameKey(name);
        if (!idsByName.has(normalized)) idsByName.set(normalized, new Set());
        idsByName.get(normalized).add(id);
      }
    }
    let assigned = 0,
      position = 0;
    for (const [videoId, track] of tracks) {
      if (position++ % 5000 === 0) {
        checkpoint();
        await deps.yield?.();
      }
      if (!track.hasAlbum) {
        noAlbum++;
        continue;
      }
      const candidates = [...track.candidates.values()];
      // A regular album credit takes precedence over a duplicate on a compilation.
      const rank = candidates.some((c) => c.rank === 0) ? 0 : 1,
        owners = new Map();
      for (const candidate of candidates.filter((c) => c.rank === rank)) {
        const artist = candidate.artist,
          known = idsByName.get(nameKey(artist.name));
        if (!artist.id && known?.size > 1) {
          ambiguousCredits++;
          continue;
        }
        const identity = artist.id || (known?.size === 1 ? known.values().next().value : null);
        const key = identity ? 'id:' + identity : 'name:' + nameKey(artist.name);
        if (!owners.has(key)) owners.set(key, artist);
      }
      if (owners.size > 1) {
        conflictingOwners++;
        continue;
      }
      if (owners.size !== 1) continue;
      const [key, artist] = owners.entries().next().value;
      if (!groups.has(key)) groups.set(key, { tracks: new Set(), names: new Map() });
      const group = groups.get(key);
      group.tracks.add(videoId);
      group.names.set(artist.name, (group.names.get(artist.name) || 0) + 1);
      assigned++;
      if (rank === 0) albumTracks++;
      else compilationTracks++;
    }
    checkpoint();
    const counts = [];
    for (const [key, group] of groups) {
      const names = [...group.names].sort((a, b) => b[1] - a[1] || compareNames(a[0], b[0]));
      counts.push({
        name: names[0][0],
        count: group.tracks.size,
        id: key.startsWith('id:') ? key.slice(3) : null
      });
    }
    counts.sort((a, b) => compareNames(a.name, b.name));
    return filterResult(
      {
        counts,
        entries: rows.length,
        distinctTracks: tracks.size,
        duplicates: rows.length - missingId - tracks.size,
        missingId,
        uncredited: tracks.size - assigned,
        unavailableEntries,
        ambiguousCredits,
        artistCount: groups.size,
        albumCount,
        albumTracks,
        compilationTracks,
        noAlbum,
        conflictingOwners
      },
      minimum
    );
  }

  function parseSubscription(json) {
    // Only the artist's header can identify the subscription channel. Related
    // artists and track menus elsewhere on the page must never supply it.
    const buttons = find(json?.header, 'subscribeButtonRenderer');
    if (buttons.length !== 1) fail('The artist subscription could not be read.');
    const button = buttons[0];
    if (
      !/^UC[A-Za-z0-9_-]{22}$/.test(button.channelId || '') ||
      typeof button.subscribed !== 'boolean' ||
      button.enabled === false
    )
      fail('The artist subscription could not be read.');
    return { channelId: button.channelId, subscribed: button.subscribed };
  }
  async function subscribeListed(result) {
    const totals = {
      total: result.qualifying.length,
      checked: 0,
      subscribed: 0,
      already: 0,
      unlinked: 0,
      failed: 0
    };
    const update = () => deps.onSubscriptions?.({ ...totals });
    update();
    for (const artist of result.qualifying) {
      checkpoint();
      const id = artistId(artist.id);
      if (!/^UC[A-Za-z0-9_-]+$/.test(id || '')) {
        totals.unlinked++;
        totals.checked++;
        update();
        continue;
      }
      try {
        let state = subscriptionCache.get(id);
        if (!state) {
          const info = await retryRead(async () => parseSubscription(await deps.post('browse', { browseId: id })));
          checkpoint();
          if (info.subscribed || subscribedChannels.has(info.channelId)) state = 'already';
          else {
            const response = await deps.post(
              'subscription/subscribe',
              { channelIds: [info.channelId] },
              { write: true }
            );
            if (
              !response ||
              response.error ||
              find(response.alerts, 'alertRenderer').some((a) => a.type === 'ERROR') ||
              response.responseContext?.mainAppWebResponseContext?.loggedOut === true ||
              (response.status && response.status !== 'STATUS_SUCCEEDED') ||
              (!response.responseContext &&
                response.status !== 'STATUS_SUCCEEDED' &&
                !response.actions &&
                !response.onResponseReceivedActions)
            )
              fail('The subscription response could not be confirmed.');
            state = 'subscribed';
          }
          subscribedChannels.add(info.channelId);
          subscriptionCache.set(id, state);
        }
        totals[state]++;
      } catch (error) {
        if (mustStop(error)) throw error;
        totals.failed++;
      }
      totals.checked++;
      update();
    }
    checkpoint();
    return totals;
  }
  async function run({ refresh = true, fullRefresh = false, minimum = 15 } = {}) {
    validateMinimum(minimum);
    if (fullRefresh) {
      subscriptionCache.clear();
      subscribedChannels.clear();
    }
    const sources = await discover({ clearCache: refresh || fullRefresh, clearAlbums: fullRefresh });
    const rows = await readCollection(sources.playlists);
    const result = await countArtists(rows, minimum);
    checkpoint();
    return { ...result, sources: sources.playlists };
  }
  return {
    roman,
    matchTitle,
    diagnostics,
    discover,
    libraryCard,
    musicRow,
    artistId,
    artistCredits,
    readPlaylist,
    readCollection,
    parseAlbum,
    resolveAlbums,
    countArtists,
    filterResult,
    parseSubscription,
    subscribeListed,
    run
  };
}

function launchMusicCollectionArtists(makeCore) {
  'use strict';
  const ORIGIN = 'https://music.youtube.com',
    ROOT_ID = 'youtube-music-collection-artists-panel';
  if (location.origin !== ORIGIN) {
    alert('Open https://music.youtube.com while signed in, then click the List Artists (≡) bookmark.');
    return;
  }
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    existing.shadowRoot?.querySelector('button')?.focus();
    return;
  }
  const cfg = (key) => window.ytcfg?.get?.(key) ?? window.yt?.config_?.[key];
  const identity = () =>
    JSON.stringify([cfg('SESSION_INDEX') ?? 0, cfg('DELEGATED_SESSION_ID') || '', cfg('DATASYNC_ID') || '']);
  const account = identity(),
    originalContext = cfg('INNERTUBE_CONTEXT');
  if (
    !originalContext?.client?.clientVersion ||
    !['WEB_REMIX', 67].includes(originalContext.client.clientName) ||
    cfg('LOGGED_IN') === false
  ) {
    alert('Sign in to YouTube Music and reload the page, then click the List Artists (≡) bookmark again.');
    return;
  }
  const context = JSON.parse(JSON.stringify(originalContext));
  context.client.clientName = 'WEB_REMIX';
  context.client.hl = 'en';
  let running = false,
    stopped = false,
    lastScanComplete = false,
    lastResult = null,
    output = '';
  const controllers = new Set();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cookie = (name) =>
    document.cookie
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(name + '='))
      ?.slice(name.length + 1);
  const fatal = (message) => Object.assign(new Error(message), { fatal: true });

  function checkAccount(honorCancel = true) {
    if (honorCancel && stopped) throw new Error('Canceled.');
    if (identity() !== account || cfg('LOGGED_IN') === false)
      throw fatal('The selected YouTube Music account changed. Close and reopen the tool.');
  }
  async function auth() {
    const sid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (!sid) throw fatal('The current YouTube Music sign-in could not be used. Sign in and reload the page.');
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
    const write = endpoint === 'subscription/subscribe';
    if (
      write
        ? !options.write ||
          Object.keys(payload).some((key) => key !== 'channelIds') ||
          !Array.isArray(payload.channelIds) ||
          payload.channelIds.length !== 1 ||
          !/^UC[A-Za-z0-9_-]{22}$/.test(payload.channelIds[0])
        : endpoint !== 'browse' ||
          options.write ||
          (!payload.browseId && !payload.continuation) ||
          Object.keys(payload).some((key) => !['browseId', 'continuation'].includes(key))
    )
      throw new Error('Only reading and individual artist subscription requests are allowed.');
    for (let attempt = 0; attempt < 3; attempt++) {
      checkAccount();
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
      const query = options.continuation
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
        query;
      checkAccount();
      const controller = new AbortController();
      if (!write) controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          headers,
          body: JSON.stringify({ context, ...payload }),
          signal: controller.signal
        });
        if (!response.ok) {
          if (!write && attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
            await delay(1000 * (attempt + 1));
            continue;
          }
          if ([401, 403].includes(response.status))
            throw fatal('YouTube Music returned HTTP ' + response.status + '.');
          if (response.status === 429) await delay(3000);
          throw new Error('YouTube Music returned HTTP ' + response.status + '.');
        }
        const json = await response.json();
        checkAccount(!write);
        if (json.error) throw new Error('YouTube Music: ' + (json.error.message || 'request rejected'));
        if (json.responseContext?.mainAppWebResponseContext?.loggedOut === true)
          throw fatal('The account is signed out.');
        if (json.responseContext?.visitorData) context.client.visitorData = json.responseContext.visitorData;
        return json;
      } catch (error) {
        if (stopped) throw new Error('Canceled.');
        if (!write && attempt < 2 && (error instanceof TypeError || error.name === 'AbortError')) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        if (error.name === 'AbortError') throw new Error('The YouTube Music request timed out.');
        throw error;
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    }
  }
  const host = document.createElement('div');
  host.id = ROOT_ID;
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
  const shadow = host.attachShadow({ mode: 'open' });

  function element(tag, parent, text, attrs = {}) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (parent) parent.append(el);
    return el;
  }
  element(
    'style',
    shadow,
    `
    :host{font:16px/1.5 system-ui,sans-serif;color:#eaf0f4;color-scheme:dark}*{box-sizing:border-box}
    .veil{height:100%;padding:24px;background:#000a;display:grid;place-items:center}.box{width:min(760px,100%);max-height:92vh;overflow:auto;background:#151b24;border:1px solid #47515e;border-radius:18px;padding:26px;box-shadow:0 24px 80px #0008}
    h2{font-size:28px;line-height:1.2;margin:8px 0 12px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;color:#7fe0ce}p{color:#b8c4d1;margin:10px 0}small{display:block;font-size:12px;color:#a4b3c2;margin:5px 0}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}button{border:1px solid #566271;border-radius:8px;padding:10px 15px;font:600 14px system-ui;cursor:pointer;background:#26303d;color:#fff}button.primary{background:#8de8d6;color:#10231f;border-color:#8de8d6}button:disabled{opacity:.45;cursor:default}
    button:focus-visible,a:focus-visible,textarea:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #7fe0ce;outline-offset:3px}.status{white-space:pre-wrap;font-size:14px;overflow-wrap:anywhere}.stats{font-size:12px;color:#a4b3c2}
    input[type=number]{width:9rem;max-width:100%;padding:10px 12px;border:1px solid #506071;border-radius:7px;color:#eaf0f4;background:#0c1119;font:inherit}input[aria-invalid=true]{border-color:#ebc589}
    textarea{width:100%;min-height:240px;max-height:45vh;resize:vertical;padding:15px;border:1px solid #506071;border-radius:9px;color:#eaf0f4;background:#0c1119;font:15px/1.65 system-ui,sans-serif}label{display:block;margin:14px 0 6px;font-size:13px;font-weight:650}
    details{margin-top:16px;font-size:13px}summary{cursor:pointer;color:#dce8ed;font-weight:650}.sources{max-height:230px;overflow:auto;margin-top:10px;border:1px solid #384757;border-radius:9px}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}td,th{padding:9px 11px;border-bottom:1px solid #33414e;vertical-align:top}th{position:sticky;top:0;background:#22303c}td:first-child{width:46px;color:#8de8d6}td:last-child{width:125px}a{color:#eaf0f4}.playlist-name{white-space:pre-wrap;overflow-wrap:anywhere}.warnings{color:#ebc589;font-size:12px;white-space:pre-wrap}.pattern{font:11px/1.5 ui-monospace,monospace;color:#8de8d6}[hidden]{display:none!important}
    @media(max-width:520px){.veil{padding:10px}.box{padding:20px}h2{font-size:24px}}
  `
  );
  const box = element('section', element('div', shadow, '', { class: 'veil' }), '', {
    class: 'box',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'artists-title'
  });
  element('div', box, 'YOUTUBE MUSIC · 2.2.0', { class: 'eyebrow' });
  element('h2', box, 'List Artists', { id: 'artists-title' });
  element(
    'p',
    box,
    'Each track counts for its album’s primary artist. Various-artists compilations count for the track’s main artist. Repeated tracks count once across the collection.'
  );
  element(
    'small',
    box,
    'Listed artists are subscribed automatically after the counts are ready. Existing subscriptions are kept. The list can be copied while subscriptions are processed.'
  );
  element('label', box, 'Minimum tracks per artist', { for: 'artist-minimum' });
  const minimum = element('input', box, '', {
    id: 'artist-minimum',
    type: 'number',
    min: '1',
    step: '1',
    required: '',
    'aria-describedby': 'minimum-help'
  });
  minimum.value = '15';
  element(
    'small',
    box,
    'Default: 15. Changing this number filters the counts without another scan. Leave the field to subscribe to any newly listed artists.',
    { id: 'minimum-help' }
  );
  const actions = element('div', box, '', { class: 'actions' });
  const copy = element('button', actions, 'Copy list', { type: 'button', class: 'primary' });
  const scan = element('button', actions, 'Scan again', { type: 'button' });
  const refresh = element('button', actions, 'Full refresh', { type: 'button' });
  const subscriptions = element('button', actions, 'Resume subscriptions', { type: 'button' });
  subscriptions.hidden = true;
  const cancel = element('button', actions, 'Cancel', { type: 'button' });
  const close = element('button', actions, 'Close', { type: 'button' });
  const status = element('div', box, 'Starting…', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const stats = element('p', box, '', { class: 'stats' });
  const subscriptionStatus = element('p', box, '', {
    class: 'stats',
    id: 'artist-subscriptions',
    role: 'status',
    'aria-live': 'polite'
  });
  const results = element('div', box);
  results.hidden = true;
  element('label', results, 'Artists and track counts — one per line', { for: 'artist-names' });
  const names = element('textarea', results, '', {
    id: 'artist-names',
    readonly: '',
    spellcheck: 'false',
    'aria-label': 'Artist names and track counts, sorted by count then name'
  });
  element(
    'small',
    results,
    'Each line uses "Artist",1234. Sorted by track count, highest first, then artist name A–Z. Copy list copies exactly this text, without headings.'
  );
  const sources = element('details', box);
  sources.open = true;
  const sourceTitle = element('summary', sources, 'Finding source playlists…');
  element('div', sources, "[spaces / underscores]Alfredo's[spaces]__ROMAN__", { class: 'pattern' });
  const sourceNote = element(
    'small',
    sources,
    'Every matching playlist is included, with no fixed playlist-count limit.'
  );
  const table = element(
    'table',
    element('div', sources, '', { class: 'sources', tabindex: '0', 'aria-label': 'Source playlists' })
  );
  const tr = element('tr', element('thead', table));
  for (const title of ['No.', 'Exact playlist name', 'Track scan']) element('th', tr, title, { scope: 'col' });
  const tbody = element('tbody', table),
    cells = new Map();
  const sourceWarnings = element('p', sources, '', { class: 'warnings' });
  const similar = element('details', sources);
  similar.hidden = true;
  const similarTitle = element('summary', similar),
    similarList = element('ul', similar);
  element(
    'small',
    box,
    'Scan again rereads the playlists and reuses known album artists. Full refresh also rereads all album artists. Equivalent artist IDs are recognized automatically, without questions.'
  );
  const previousFocus = document.activeElement;
  document.documentElement.append(host);
  const core = makeCore({
    post,
    delay,
    cancelled: () => stopped,
    yield: () => delay(0),
    progress: (message) => {
      if (!stopped) status.textContent = message;
    },
    onSubscriptions: (value) => {
      subscriptionStatus.textContent =
        'Subscriptions: ' +
        value.checked +
        ' / ' +
        value.total +
        ' checked · ' +
        value.subscribed +
        ' subscribed this session · ' +
        value.already +
        ' already subscribed · ' +
        value.unlinked +
        ' without a usable artist link · ' +
        value.failed +
        ' unsuccessful';
    },
    onCatalog: (value) => {
      sourceTitle.textContent = value.playlists.length + ' source playlists';
      sourceNote.textContent = value.scanned + ' library playlists inspected. Scanning continues automatically.';
      tbody.replaceChildren();
      cells.clear();
      for (const source of value.playlists) {
        const row = element('tr', tbody);
        element('td', row, source.roman);
        const name = element('td', row);
        element('a', name, source.title, {
          href: ORIGIN + '/playlist?list=' + encodeURIComponent(source.id),
          target: '_blank',
          rel: 'noopener noreferrer',
          class: 'playlist-name'
        });
        cells.set(source.id, element('td', row, 'Waiting'));
      }
      const info = core.diagnostics(value.playlists),
        notices = [];
      if (info.missing.length)
        notices.push(
          'Numeral gaps: ' + info.missing.slice(0, 30).join(', ') + (info.missing.length > 30 ? ' …' : '') + '.'
        );
      if (info.repeated.length)
        notices.push(
          'Repeated numerals: ' + info.repeated.join(', ') + '. All matching playlist IDs are included.'
        );
      sourceWarnings.textContent = notices.join('\n');
      similar.hidden = !value.similar.length;
      similarTitle.textContent = value.similar.length + ' similar names excluded by the pattern';
      similarList.replaceChildren();
      for (const source of value.similar)
        element('a', element('li', similarList), source.title, {
          href: ORIGIN + '/playlist?list=' + encodeURIComponent(source.id),
          target: '_blank',
          rel: 'noopener noreferrer',
          class: 'playlist-name'
        });
    },
    onPlaylist: (source, value) => {
      const cell = cells.get(source.id);
      if (cell) cell.textContent = value.state + ' · ' + value.count.toLocaleString();
    }
  });
  const validMinimum = () => Number.isSafeInteger(Number(minimum.value)) && Number(minimum.value) >= 1;

  function setRunning(value) {
    running = value;
    scan.disabled = refresh.disabled = value || !validMinimum();
    minimum.disabled = value;
    close.disabled = value;
    copy.disabled = !output;
    subscriptions.disabled = value || !lastResult || !validMinimum();
    cancel.hidden = !value;
    cancel.disabled = false;
  }

  function showResult(result) {
    lastResult = result;
    output = result.text;
    names.value = output;
    results.hidden = false;
    status.textContent = result.names.length
      ? result.names.length + ' artists with at least ' + result.minimum + ' distinct tracks. Ready to copy.'
      : 'No artists with at least ' + result.minimum + ' distinct tracks were found in the readable credits.';
    stats.textContent =
      result.sources.length +
      ' source playlists · ' +
      result.entries.toLocaleString() +
      ' entries · ' +
      result.distinctTracks.toLocaleString() +
      ' distinct tracks · ' +
      result.duplicates.toLocaleString() +
      ' duplicate entries ignored.\n' +
      result.albumCount.toLocaleString() +
      ' albums checked · ' +
      result.albumTracks.toLocaleString() +
      ' tracks assigned by album · ' +
      result.compilationTracks.toLocaleString() +
      ' compilation tracks assigned to their main artist.';
  }
  minimum.addEventListener('input', () => {
    if (running) return;
    minimum.setAttribute('aria-invalid', String(!validMinimum()));
    if (!validMinimum()) {
      output = '';
      names.value = '';
      status.textContent = 'The minimum must be a positive whole number.';
    } else if (lastResult) showResult(core.filterResult(lastResult, Number(minimum.value)));
    setRunning(false);
  });
  async function subscribeResult() {
    subscriptions.hidden = true;
    try {
      const value = await core.subscribeListed(lastResult);
      subscriptions.hidden = !value.failed;
      subscriptionStatus.textContent += ' · Finished.';
    } catch (error) {
      subscriptions.hidden = false;
      subscriptionStatus.textContent += stopped
        ? ' · Canceled. Saved subscriptions can be resumed.'
        : ' · ' + (error.message || 'Subscriptions stopped.');
    }
  }
  async function subscribeOnly() {
    if (running || !lastResult || !validMinimum()) return;
    stopped = false;
    setRunning(true);
    try {
      await subscribeResult();
    } finally {
      setRunning(false);
    }
  }
  // Filtering is immediate; apply subscriptions when the edited minimum is committed.
  minimum.addEventListener('change', subscribeOnly);
  subscriptions.addEventListener('click', subscribeOnly);
  async function execute(fullRefresh = false) {
    if (running) return;
    if (!validMinimum()) return;
    const refreshSources = lastScanComplete || fullRefresh;
    stopped = false;
    lastResult = null;
    output = '';
    names.value = '';
    stats.textContent = '';
    results.hidden = true;
    lastScanComplete = false;
    subscriptionStatus.textContent = '';
    subscriptions.hidden = true;
    sourceTitle.textContent = 'Finding source playlists…';
    sourceWarnings.textContent = '';
    similar.hidden = true;
    tbody.replaceChildren();
    cells.clear();
    status.textContent = 'Finding matching playlists…';
    setRunning(true);
    try {
      const result = await core.run({ refresh: refreshSources, fullRefresh, minimum: Number(minimum.value) });
      showResult(result);
      lastScanComplete = true;
      sourceNote.textContent =
        'Sources inspected. Scan again refreshes playlist contents; known album artists are reused.';
      copy.disabled = !output;
      await subscribeResult();
    } catch (error) {
      status.textContent = stopped
        ? 'Canceled. No artist list was produced.'
        : error.message || 'The scan could not be completed.';
      stats.textContent = 'Playlist and album reads are retained while this panel stays open.';
      scan.textContent = 'Retry scan';
    } finally {
      if (lastScanComplete) scan.textContent = 'Scan again';
      setRunning(false);
    }
  }
  copy.addEventListener('click', async () => {
    if (!output) return;
    names.focus();
    names.select();
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(output);
        copied = true;
      }
    } catch {}
    if (!copied) {
      try {
        copied = document.execCommand('copy');
      } catch {}
    }
    status.textContent = copied ? 'Artist list copied.' : 'List selected. Press Ctrl+C to copy.';
  });
  scan.addEventListener('click', () => execute());
  refresh.addEventListener('click', () => execute(true));
  cancel.addEventListener('click', () => {
    stopped = true;
    cancel.disabled = true;
    if (lastResult) subscriptionStatus.textContent += ' · Canceling after any subscription already sent…';
    else status.textContent = 'Canceling…';
    for (const controller of controllers) controller.abort();
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
      const items = [...shadow.querySelectorAll('button,input,textarea,a[href],summary,[tabindex="0"]')].filter(
        (el) => !el.disabled && !el.hidden && el.getClientRects().length
      );
      const first = items[0],
        last = items.at(-1);
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
  execute();
  cancel.focus();
}

launchMusicCollectionArtists(makeCollectionArtistsCore);
