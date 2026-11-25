/* Add Songs 2.2.0 — self-contained; append-only collection updates. */
function makeCollectionImporterCore(deps) {
  'use strict';
  const fail = (message) => {
    throw new Error(message);
  };
  const checkpoint = () => {
    if (deps.cancelled?.()) throw Object.assign(new Error('Canceled.'), { canceled: true });
  };
  const mustStop = (e) => e?.fatal || e?.canceled || deps.cancelled?.();
  const say = (message) => deps.progress?.(message);
  let collectionCache = null;
  const MAX_READ_ATTEMPTS = 3;
  const retryableRead = (e) =>
    !mustStop(e) &&
    e?.retryable !== false &&
    ![401, 403].includes(e?.httpStatus) &&
    !/account changed|sign.in|log.?in|not a bot|captcha|unusual traffic|permission|forbidden|unauthori[sz]ed|HTTP (?:401|403)\b/i.test(
      e?.message || ''
    );
  async function retryPause(attempt) {
    for (let left = attempt * 1000; left > 0; left -= 250) {
      checkpoint();
      await deps.delay?.(Math.min(250, left));
    }
    checkpoint();
  }
  async function workers(count, worker) {
    const done = await Promise.allSettled(Array.from({ length: count }, worker));
    const error = done.find((r) => r.status === 'rejected');
    if (error) throw error.reason;
  }
  const textOf = (value) =>
    typeof value === 'string'
      ? value
      : value?.simpleText || (Array.isArray(value?.runs) ? value.runs.map((r) => r?.text || '').join('') : '');

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
  async function discover() {
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
      if (!next) return current;
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
    fail('Library discovery did not finish. Further additions stopped.');
  }
  const cleanName = (value) =>
    String(value || '')
      .normalize('NFC')
      .replace(/\s+/gu, ' ')
      .trim();
  const nameKey = (value) => cleanName(value).toLocaleLowerCase('en');
  const artistId = (id) =>
    typeof id === 'string' && /^(?:MPLA)?UC[A-Za-z0-9_-]+$/.test(id) ? id.replace(/^MPLA/, '') : id;
  const artistPages = new Map(),
    choices = new Map(),
    unresolved = new Map();
  let job = null;
  for (const choice of deps.loadChoices?.() || []) {
    if (typeof choice?.input !== 'string') continue;
    const valid = (id) => /^UC[A-Za-z0-9_-]+$/.test(artistId(id) || '');
    if (valid(choice.id)) choices.set(nameKey(choice.input), { input: choice.input, id: artistId(choice.id) });
    else if (Array.isArray(choice.decisions)) {
      const decisions = choice.decisions
        .filter((d) => valid(d?.id) && typeof d.use === 'boolean')
        .map((d) => ({ id: artistId(d.id), use: d.use }));
      if (decisions.length) choices.set(nameKey(choice.input), { input: choice.input, decisions });
    }
  }

  function saveChoices(next) {
    deps.saveChoices?.([...next.values()]);
    choices.clear();
    for (const [key, value] of next) choices.set(key, value);
    deps.onChoices?.([...choices.values()]);
  }

  function forgetChoice(input) {
    const next = new Map(choices);
    next.delete(nameKey(input));
    saveChoices(next);
  }

  function resetChoices() {
    saveChoices(new Map());
  }
  const pendingChoices = () =>
    [...unresolved.values()].filter((options) => options.some((a) => typeof a.use !== 'boolean')).length;

  function showChoices(input, options) {
    const remaining = options.filter((a) => typeof a.use !== 'boolean').length;
    deps.onArtist?.(input, {
      state: remaining
        ? 'Decide for each artist · ' + remaining + ' pending'
        : options.some((a) => a.use)
          ? 'Artist decisions saved'
          : 'All candidates excluded',
      candidates: options
    });
    if (job) {
      job.result.pendingChoices = pendingChoices();
      deps.summary?.(job.result);
    }
  }

  function chooseArtist(input, id, use = true) {
    const key = nameKey(input),
      options = unresolved.get(key),
      artist = options?.find((a) => a.id === id);
    if (!artist || typeof artist.use === 'boolean' || typeof use !== 'boolean')
      fail('That artist choice is no longer available.');
    const saved = choices.get(key),
      decisions = (saved?.decisions || (saved?.id ? [{ id: saved.id, use: true }] : [])).filter(
        (d) => !artist.aliases.includes(d.id)
      );
    decisions.push({ id: artist.id, use });
    const next = new Map(choices);
    next.set(key, { input: artist.input, decisions });
    saveChoices(next);
    artist.use = use;
    if (use && job) job.queue.push(artist);
    showChoices(artist.input, options);
    return artist;
  }
  async function artistPage(id) {
    id = artistId(id);
    if (!artistPages.has(id)) artistPages.set(id, deps.post('browse', { browseId: id }));
    try {
      return await artistPages.get(id);
    } catch (e) {
      artistPages.delete(id);
      throw e;
    }
  }

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
        const id = typeof e?.browseId === 'string' ? e.browseId : null;
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
      title,
      artists: artistCredits(r, columns, columns.indexOf(titleColumn || columns[0])),
      album: albums.size === 1 ? albums.values().next().value : null,
      available: !unavailable
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
        fail('A collection entry could not be read. Duplicate checks and capacity could not be verified.');
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
  const playlistReadState = () => ({
    rows: [],
    seen: new Set(),
    next: null,
    targetId: null,
    pages: 0,
    complete: false,
    owned: false,
    declared: null
  });
  async function readPlaylist(id, label = 'Reading source', onPage, halt, state = playlistReadState()) {
    checkpoint();
    while (!state.complete && state.pages < 1000) {
      checkpoint();
      if (halt?.()) fail('Source scan stopped.');
      const next = state.next;
      const json = !next
        ? await deps.post('browse', { browseId: 'VL' + id })
        : next.mode === 'query'
          ? await deps.post('browse', { browseId: 'VL' + id }, { continuation: next.token })
          : await deps.post('browse', { continuation: next.token });
      checkpoint();
      if (halt?.()) fail('Source scan stopped.');
      const errors = find(json.alerts, 'alertRenderer').filter((a) => a.type === 'ERROR');
      if (errors.length) fail(textOf(errors[0].text) || 'YouTube Music could not open this playlist.');
      let scope,
        targetId = state.targetId,
        owned = state.owned,
        declared = state.declared;
      if (!next) {
        const headers = [
          ...find(primary(json), 'musicEditablePlaylistDetailHeaderRenderer'),
          ...find(json.header, 'musicEditablePlaylistDetailHeaderRenderer')
        ];
        owned = headers.some((h) => !h.playlistId || [id, 'VL' + id].includes(h.playlistId));
        const identifiedOwner = headers.some((h) => [id, 'VL' + id].includes(h.playlistId));
        const meta = [
          ...find(primary(json), 'musicResponsiveHeaderRenderer'),
          ...find(json.header, 'musicResponsiveHeaderRenderer'),
          ...find(json.header, 'musicDetailHeaderRenderer')
        ];
        const countText = meta.map((h) => textOf(h.secondSubtitle) + ' · ' + textOf(h.subtitle)).join(' · ');
        const countMatch = countText.match(/(?:^|[•·]\s*)([\d,]+)\s+(?:songs?|tracks?|videos?)\b/i);
        declared = countMatch ? Number(countMatch[1].replaceAll(',', '')) : null;
        const allLists = find(json.contents, 'musicPlaylistShelfRenderer');
        const identified = allLists.filter(
          (r) => [id, 'VL' + id].includes(r.playlistId) || [id, 'VL' + id].includes(r.targetId)
        );
        const lists = identified.length ? identified : allLists.filter((r) => !r.playlistId);
        const area = json.contents?.twoColumnBrowseResultsRenderer?.secondaryContents || primary(json),
          section = area?.sectionListRenderer;
        const emptyNotice = (section?.contents || []).some(
          (item) =>
            item.musicNoContentsMessageRenderer ||
            /^(?:this playlist is empty|no (?:songs|tracks|videos)(?: yet| in this playlist)?)[.!]?$/i.test(
              textOf(item.messageRenderer?.text).trim()
            )
        );
        const emptyArea = Array.isArray(section?.contents) && !section.contents.length;
        if (
          !allLists.length &&
          owned &&
          (declared === 0 || (identifiedOwner && declared === null && (emptyArea || emptyNotice))) &&
          !find(area, 'musicResponsiveListItemRenderer').length &&
          !find(area, 'continuationCommand').length &&
          !find(area, 'nextContinuationData').length
        ) {
          scope = { contents: [] };
          declared = 0;
        } else {
          if (lists.length !== 1)
            fail(
              'The playlist could not be read. Check the address and access in the selected YouTube Music account.'
            );
          scope = lists[0];
          // Empty playlist shelves can omit both contents and the displayed song count.
          if (
            scope.contents === undefined &&
            (declared === 0 || (declared === null && identified.length === 1)) &&
            !nextPage(scope, [])
          )
            scope = { ...scope, contents: [] };
        }
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
        fail('YouTube Music repeated a playlist page. Further additions stopped.');
      // Commit only a fully validated page. A retry requests the failed page again.
      state.rows.push(...parsed.rows);
      if (parsed.next) state.seen.add(parsed.next.token);
      Object.assign(state, {
        next: parsed.next,
        targetId,
        owned,
        declared,
        pages: state.pages + 1,
        complete: !parsed.next
      });
      if (onPage) onPage(state.rows.length);
      else say(label + ': ' + state.rows.length.toLocaleString() + ' entries');
    }
    if (!state.complete) fail('The playlist did not finish loading. Nothing further was changed.');
    // Pagination determines completion; the header may include omitted entries.
    return { rows: state.rows, owned: state.owned, count: Math.max(state.rows.length, state.declared || 0) };
  }
  const isVarious = (value) =>
    /^(?:various artists|various|varios artistas|artistas varios|divers artistes|artistes divers|verschiedene interpreten|verschiedene künstler|artisti vari|diversi artisti|vários artistas)$/i.test(
      cleanName(value)
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
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);

  function parseInputs(input) {
    const entries = [],
      seen = new Set();
    let token = '',
      inQuotes = false,
      hadQuotes = false;
    const add = () => {
      // Test the original spelling before Unicode normalization or case folding.
      const raw = token.trim();
      const kind = !hadQuotes && /^UC[A-Za-z0-9_-]{22}$/.test(raw) ? 'channelId' : 'name';
      const value = kind === 'channelId' ? raw : cleanName(raw);
      const key = kind + ':' + (kind === 'channelId' ? value : nameKey(value));
      token = '';
      hadQuotes = false;
      if (value && !seen.has(key)) {
        seen.add(key);
        entries.push({ kind, value });
      }
    };
    input = String(input);
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '"') {
        hadQuotes = true;
        if (inQuotes && input[i + 1] === '"') {
          token += '"';
          i++;
        } else inQuotes = !inQuotes;
      } else if ((ch === ',' || ch === '\n' || ch === '\r') && !inQuotes) add();
      else token += ch;
    }
    if (inQuotes) fail('Close the quotation mark around the artist name.');
    add();
    if (!entries.length) fail('Enter at least one artist name or channel ID.');
    return entries;
  }

  // Only explicit ID aliases join profiles. A third profile can connect two
  // earlier groups. Keep every browse route and every verified display name.
  function indexArtistProfiles(artists) {
    const byAlias = new Map();
    for (const artist of artists) {
      const linked = new Set(artist.aliases.map((id) => byAlias.get(id)).filter(Boolean));
      const profiles = [...linked, artist];
      const group = {
        ...profiles[0],
        aliases: [...new Set(profiles.flatMap((p) => p.aliases))],
        routes: [...new Set(profiles.flatMap((p) => p.routes))],
        names: [...new Set(profiles.flatMap((p) => p.names || [p.name]))],
        samples: [...new Set(profiles.flatMap((p) => p.samples))].slice(0, 3)
      };
      for (const id of group.aliases) byAlias.set(id, group);
    }
    return byAlias;
  }

  function ambiguousCreditNames(profileIndex) {
    const seen = new Set(), ambiguous = new Set();
    for (const profile of new Set(profileIndex.values())) {
      for (const name of new Set(profile.names.map(nameKey))) {
        if (seen.has(name)) ambiguous.add(name);
        seen.add(name);
      }
    }
    return ambiguous;
  }

  function primary(json) {
    const tabs =
      json?.contents?.singleColumnBrowseResultsRenderer?.tabs ||
      json?.contents?.twoColumnBrowseResultsRenderer?.tabs ||
      json?.contents?.tabbedSearchResultsRenderer?.tabs;
    return tabs
      ? (tabs.find((t) => t.tabRenderer?.selected)?.tabRenderer || tabs[0]?.tabRenderer)?.content
      : json?.contents;
  }
  const browseEndpoint = (node) => node?.navigationEndpoint?.browseEndpoint;
  const pageType = (e) => e?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;

  function cardEndpoint(r) {
    return (
      browseEndpoint(r) ||
      browseEndpoint(r?.title) ||
      r?.title?.runs?.map(browseEndpoint).find(Boolean) ||
      r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(browseEndpoint).find(Boolean)
    );
  }
  const cardTitle = (r) =>
    textOf(r?.title || r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text);

  function continuationScope(json, target, kind) {
    const legacy = json?.continuationContents;
    if (legacy) {
      const value =
        legacy.gridContinuation || legacy.musicShelfContinuation || legacy.musicPlaylistShelfContinuation;
      if (value) return value;
    }
    const actions = [
      'onResponseReceivedActions',
      'onResponseReceivedEndpoints',
      'onResponseReceivedCommands'
    ].flatMap((k) => find(json?.[k], 'appendContinuationItemsAction'));
    let matches = actions.filter((a) => target && a.targetId === target);
    if (!matches.length)
      matches = actions.filter((a) => (!target || !a.targetId) && Array.isArray(a.continuationItems));
    if (matches.length !== 1) fail('A catalog continuation could not be read.');
    return {
      [kind]: matches[0].continuationItems,
      targetId: matches[0].targetId || target
    };
  }
  async function walk(scope, body, kind, consume, endpoint = 'browse') {
    const seen = new Set();
    let target = scope?.targetId;
    for (let page = 0; page < 10000; page++) {
      checkpoint();
      const items = scope?.[kind];
      if (!Array.isArray(items)) return;
      for (const item of items) {
        try {
          consume(item);
        } catch (e) {
          if (mustStop(e)) throw e;
        }
      }
      let next;
      try {
        next = nextPage(scope, items);
      } catch {
        return;
      }
      if (!next || seen.has(next.token)) return;
      seen.add(next.token);
      try {
        const json = await deps.post(
          endpoint,
          next.mode === 'body' ? { continuation: next.token } : body,
          next.mode === 'query' ? { continuation: next.token } : {}
        );
        scope = continuationScope(json, target, kind);
        target = scope.targetId || target;
      } catch (e) {
        if (mustStop(e)) throw e;
        return;
      }
    }
  }
  async function searchArtist(name) {
    const json = await deps.post('search', { query: name, params: 'EgWKAQIgAWoMEA4QChADEAQQCRAF' });
    const matches = new Map();
    const consume = (item) => {
      const r =
        item?.musicResponsiveListItemRenderer || item?.musicTwoRowItemRenderer || item?.musicCardShelfRenderer;
      const e = cardEndpoint(r),
        title = cleanName(cardTitle(r));
      const id = artistId(e?.browseId);
      if (
        /^UC[A-Za-z0-9_-]+$/.test(id || '') &&
        (pageType(e) === 'MUSIC_PAGE_TYPE_ARTIST' || !pageType(e)) &&
        nameKey(title) === nameKey(name)
      )
        matches.set(id, { id, name: title, input: name, aliases: [id], routes: [id] });
    };
    const root = primary(json);
    for (const r of find(root, 'musicCardShelfRenderer')) consume({ musicCardShelfRenderer: r });
    for (const shelf of find(root, 'musicShelfRenderer'))
      await walk(shelf, { query: name, params: 'EgWKAQIgAWoMEA4QChADEAQQCRAF' }, 'contents', consume, 'search');
    return [...matches.values()];
  }

  function inspectArtistPage(id, json) {
    const top = json?.header || {};
    const header =
      top.musicImmersiveHeaderRenderer || top.musicVisualHeaderRenderer ||
      top.musicHeaderRenderer || top.musicResponsiveHeaderRenderer;
    const channels = find(header?.subscriptionButton, 'subscribeButtonRenderer')
      .map((button) => artistId(button.channelId))
      .filter((channel) => /^UC[A-Za-z0-9_-]+$/.test(channel || ''));
    const aliases = new Set([id]);
    if (channels.length && channels.every((channel) => channel === channels[0])) aliases.add(channels[0]);
    // Ordinary Music users can also have a visual header, a title and subscribers.
    // For a shared header layout require a self-link explicitly identifying an artist
    // or the artist's own release-list endpoint on a primary shelf.
    const tabs = json?.contents?.singleColumnBrowseResultsRenderer?.tabs ||
      json?.contents?.twoColumnBrowseResultsRenderer?.tabs;
    const tab = tabs?.find((entry) => entry.tabRenderer?.selected)?.tabRenderer;
    const tabEndpoint = tab?.endpoint?.browseEndpoint;
    const selfLinks = [tabEndpoint, browseEndpoint(header), ...find(header?.title, 'browseEndpoint')]
      .filter((e) => artistId(e?.browseId) === id);
    const userChannel = selfLinks.some((e) => pageType(e) === 'MUSIC_PAGE_TYPE_USER_CHANNEL');
    let confirmed = !!top.musicImmersiveHeaderRenderer ||
      selfLinks.some((e) => pageType(e) === 'MUSIC_PAGE_TYPE_ARTIST');
    const root = primary(json);
    const primaryShelves = (root?.sectionListRenderer?.contents || [root])
      .map((section) => section?.musicCarouselShelfRenderer);
    const samples = [];
    for (const shelf of find(root, 'musicCarouselShelfRenderer')) {
      const heading =
        shelf.header?.musicCarouselShelfBasicHeaderRenderer || shelf.header?.musicCarouselShelfHeaderRenderer;
      const title = cleanName(textOf(heading?.title));
      if (!/^(?:albums?|singles?(?:\s*(?:&|and)\s*eps?)?|eps?|releases?)$/i.test(title))
        continue;
      if (!confirmed && primaryShelves.includes(shelf))
        confirmed = find(heading, 'browseEndpoint').some(
          (e) => e?.browseId === 'MPAD' + id || (artistId(e?.browseId) === id && e?.params)
        );
      for (const item of shelf.contents || []) {
        const card = item.musicTwoRowItemRenderer || item.musicResponsiveListItemRenderer;
        if (/^MPRE/.test(cardEndpoint(card)?.browseId || '')) {
          const title = cleanName(cardTitle(card));
          if (title && !samples.includes(title) && samples.length < 3) samples.push(title);
        }
      }
    }
    const name = confirmed && !userChannel ? cleanName(textOf(header?.title)) : '';
    if (name) {
      // The canonical URL may also be a handle. Only an exact channel URL supplies an ID.
      const canonical = /^https:\/\/music\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/
        .exec(json?.microformat?.microformatDataRenderer?.urlCanonical);
      if (canonical) aliases.add(canonical[1]);
      const tabId = artistId(tabEndpoint?.browseId);
      if (pageType(tabEndpoint) === 'MUSIC_PAGE_TYPE_ARTIST' && /^UC[A-Za-z0-9_-]{22}$/.test(tabId || ''))
        aliases.add(tabId);
    }
    return { name, aliases: [...aliases], samples };
  }

  async function resolveChannelId(id) {
    let json;
    try {
      json = await artistPage(id);
    } catch (e) {
      if (mustStop(e)) throw e;
      const status = e?.httpStatus;
      if (status === 404 || status === 410) fail('Channel ID not found.');
      if (
        status === 408 || status === 429 || (status >= 500 && status < 600) ||
        e?.name === 'AbortError' || e?.name === 'TypeError' || e?.retryable === true
      )
        fail('Temporary channel lookup failure · ' + e.message);
      throw e;
    }
    const alert = json?.alerts?.map((a) => a.alertRenderer || a.alertWithButtonRenderer)
      .find((a) => a?.type === 'ERROR' || (!json?.header && textOf(a?.text)));
    if (alert) {
      artistPages.delete(id);
      fail('Channel lookup failed · ' + (textOf(alert.text) || 'YouTube Music returned an error.'));
    }
    const profile = inspectArtistPage(id, json);
    if (!profile.name) {
      artistPages.delete(id);
      fail(json?.header || json?.metadata?.channelMetadataRenderer
        ? 'No identifiable YouTube Music artist profile for this channel ID.'
        : 'Channel ID could not be resolved to a YouTube Music artist profile.');
    }
    return { id, input: id, kind: 'channelId', routes: [id], ...profile };
  }

  async function resolveArtist(name) {
    const matches = await searchArtist(name);
    let cursor = 0;
    await workers(Math.min(3, matches.length), async () => {
      while (cursor < matches.length) {
        checkpoint();
        const artist = matches[cursor++];
        artist.samples = [];
        try {
          const profile = inspectArtistPage(artist.id, await artistPage(artist.id));
          artist.aliases = profile.aliases;
          artist.samples = profile.samples;
          if (profile.name && profile.name !== artist.name) artist.names = [artist.name, profile.name];
        } catch (e) {
          if (mustStop(e)) throw e;
        }
      }
    });
    const groups = [...new Set(indexArtistProfiles(matches).values())];
    const saved = choices.get(nameKey(name)),
      legacy = saved?.id && groups.some((a) => a.aliases.includes(saved.id));
    for (const artist of groups) {
      const decisions = saved?.decisions?.filter((d) => artist.aliases.includes(d.id)) || [];
      if (legacy) artist.use = artist.aliases.includes(saved.id);
      else if (decisions.length && decisions.every((d) => d.use === decisions[0].use))
        artist.use = decisions[0].use;
    }
    return groups;
  }
  const albumCards = (item, albums) => {
    const r = item?.musicTwoRowItemRenderer || item?.musicResponsiveListItemRenderer;
    const e = cardEndpoint(r);
    if (/^MPRE[A-Za-z0-9_-]+$/.test(e?.browseId || '')) albums.add(e.browseId);
  };
  async function releaseList(endpoint, albums) {
    const body = { browseId: endpoint.browseId, ...(endpoint.params ? { params: endpoint.params } : {}) };
    const json = await deps.post('browse', body),
      root = primary(json);
    const scopes = [...find(root, 'gridRenderer'), ...find(root, 'musicCarouselShelfRenderer')];
    for (const scope of scopes)
      await walk(scope, body, Array.isArray(scope.items) ? 'items' : 'contents', (item) =>
        albumCards(item, albums)
      );
  }
  async function artistCatalog(artist, albums) {
    if (artist.routes?.length > 1) {
      for (const id of artist.routes)
        try {
          await artistCatalog({ ...artist, id, routes: [] }, albums);
        } catch (e) {
          if (mustStop(e)) throw e;
        }
      return;
    }
    const json = await artistPage(artist.id),
      root = primary(json),
      lists = new Map();
    const takeRow = (item) => {
      if (item?.musicResponsiveListItemRenderer) {
        const row = musicRow(item.musicResponsiveListItemRenderer);
        if (row.album) albums.add(row.album.id);
      }
    };
    for (const shelf of find(root, 'musicShelfRenderer')) {
      const title = cleanName(textOf(shelf.title));
      if (!/^songs?$|^top songs?$/i.test(title)) continue;
      for (const item of shelf.contents || [])
        try {
          takeRow(item);
        } catch (e) {
          if (mustStop(e)) throw e;
        }
      const e =
        browseEndpoint(shelf.title) ||
        shelf.title?.runs?.map(browseEndpoint).find(Boolean) ||
        shelf.bottomEndpoint?.browseEndpoint;
      if (e?.browseId?.startsWith('VL')) {
        try {
          const value = await readPlaylist(e.browseId.slice(2));
          for (const row of value.rows) if (row.album) albums.add(row.album.id);
        } catch (e) {
          if (mustStop(e)) throw e;
        }
      }
    }
    for (const shelf of find(root, 'musicCarouselShelfRenderer')) {
      const h =
        shelf.header?.musicCarouselShelfBasicHeaderRenderer || shelf.header?.musicCarouselShelfHeaderRenderer;
      const title = cleanName(textOf(h?.title));
      if (
        !/^(?:albums?|singles?(?:\s*(?:&|and)\s*eps?)?|eps?|releases?|featured on|appears on|compilations?)$/i.test(
          title
        )
      )
        continue;
      for (const item of shelf.contents || [])
        try {
          albumCards(item, albums);
        } catch (e) {
          if (mustStop(e)) throw e;
        }
      for (const e of find(h, 'browseEndpoint'))
        if (e.browseId && e.params) lists.set(e.browseId + '\n' + e.params, e);
    }
    for (const endpoint of lists.values())
      try {
        await releaseList(endpoint, albums);
      } catch (e) {
        if (mustStop(e)) throw e;
      }
  }

  function ownerFor(credit, artists) {
    if (!credit) return null;
    const byId = artists.filter((a) => (a.aliases || [a.id]).includes(artistId(credit.id)));
    if (byId.length === 1) return byId[0];
    if (credit.id) return null;
    const creditName = nameKey(credit.name);
    const byName = artists.filter((a) => (a.creditNames || [nameKey(a.name)]).includes(creditName));
    return byName.length === 1 ? byName[0] : null;
  }
  async function collectSongs(artists, albums) {
    const songs = new Map(),
      queue = [...albums],
      seen = new Set(queue),
      counts = new Map(artists.map((a) => [a.id, new Set()]));
    let cursor = 0,
      done = 0;
    const enqueue = (id) => {
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    };
    async function worker() {
      while (cursor < queue.length) {
        checkpoint();
        const id = queue[cursor++];
        try {
          const body = { browseId: id },
            json = await deps.post('browse', body),
            meta = parseAlbum(json),
            owner = ownerFor(meta.artist, artists);
          if (owner || meta.various) {
            const root = json.contents?.twoColumnBrowseResultsRenderer?.secondaryContents || primary(json);
            const scopes = [...find(root, 'musicShelfRenderer'), ...find(root, 'musicPlaylistShelfRenderer')];
            // Album tracks are the first shelf; secondary carousels contain recommendations.
            if (scopes[0])
              await walk(scopes[0], body, 'contents', (item) => {
                if (!item?.musicResponsiveListItemRenderer) return;
                const row = musicRow(item.musicResponsiveListItemRenderer);
                const credited = meta.various ? ownerFor(row.artists[0], artists) : owner;
                if (credited && row.available && validId(row.id)) {
                  songs.set(row.id, row);
                  counts.get(credited.id).add(row.id);
                }
              });
            for (const shelf of find(root, 'musicCarouselShelfRenderer')) {
              const title = textOf(shelf.header?.musicCarouselShelfBasicHeaderRenderer?.title);
              if (
                /^other versions$/i.test(title.trim()) ||
                shelf.itemSize === 'COLLECTION_STYLE_ITEM_SIZE_MEDIUM'
              ) {
                const extra = new Set();
                for (const item of shelf.contents || []) albumCards(item, extra);
                for (const next of extra) enqueue(next);
              }
            }
          }
        } catch (e) {
          if (mustStop(e)) throw e;
        }
        done++;
        say(
          'Reading releases: ' +
            done.toLocaleString() +
            '/' +
            queue.length.toLocaleString() +
            ' · ' +
            songs.size.toLocaleString() +
            ' distinct tracks'
        );
      }
    }
    await workers(Math.min(3, queue.length), worker);
    for (const artist of artists)
      deps.onArtist?.(artist.input, { state: 'Found', artist, count: counts.get(artist.id).size }, artist.kind);
    return [...songs.values()];
  }
  async function scanCollection() {
    let value;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      try {
        value = await discover();
        break;
      } catch (e) {
        if (!retryableRead(e) || attempt === MAX_READ_ATTEMPTS - 1) throw e;
        say('Playlist discovery interrupted · retrying automatically (' + (attempt + 1) + '/2)');
        await retryPause(attempt + 1);
      }
    }
    const sources = value.playlists.map((s) => ({ ...s }));
    const pending = deps.loadPending?.();
    // A completed scan can be reused; unfinished scans never become the shared collection.
    const states = new Map(),
      ids = new Set(),
      counts = new Map();
    let queue = sources,
      total = 0;
    deps.onScan?.({ playlists: sources.length, count: 0 });
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      if (attempt) {
        say('Resuming ' + queue.length + ' unfinished collection playlists · automatic retry ' + attempt + '/2');
        await retryPause(attempt);
      }
      let cursor = 0,
        fatal = null;
      const failures = [];
      async function worker() {
        while (cursor < queue.length && !fatal) {
          checkpoint();
          const source = queue[cursor++];
          const recovering =
            pending?.kind === 'create' && (pending.id ? source.id === pending.id : source.title === pending.title);
          let state = states.get(source.id) || playlistReadState();
          states.set(source.id, state);
          const progress = (count) => {
            const previous = counts.get(source.id) || 0;
            total += Math.max(0, count - previous);
            counts.set(source.id, Math.max(previous, count));
            deps.onScan?.({ playlists: sources.length, count: total });
            deps.onPlaylist?.(source, {
              state: attempt ? 'Retrying (' + attempt + '/2)' : 'Reading',
              count,
              scanning: true
            });
          };
          try {
            progress(state.rows.length);
            const read = () => {
              // A newly created playlist can become editable after its first readable response.
              if (recovering && state.complete && !state.owned) {
                state = playlistReadState();
                states.set(source.id, state);
              }
              return readPlaylist(source.id, source.title, progress, () => !!fatal, state).catch((e) => {
                throw fatal || e;
              });
            };
            const data = recovering ? await waitForCreation(source.title, read) : await read();
            Object.assign(source, { count: data.count, owned: data.owned });
            for (const row of data.rows) if (validId(row.id)) ids.add(row.id);
            states.delete(source.id);
            reportSource(source);
          } catch (e) {
            if (!retryableRead(e)) fatal ||= e;
            // Creation access already has its own bounded retry sequence; do not multiply it.
            failures.push({ source, error: e, terminal: recovering });
            deps.onPlaylist?.(source, {
              state: fatal || recovering || attempt === MAX_READ_ATTEMPTS - 1 ? 'Failed' : 'Waiting to retry',
              count: state.rows.length,
              scanning: true
            });
          }
        }
      }
      await workers(Math.min(3, queue.length), worker);
      checkpoint();
      if (fatal) throw fatal;
      if (!failures.length) break;
      const terminal = failures.find((f) => f.terminal);
      if (terminal || attempt === MAX_READ_ATTEMPTS - 1) throw (terminal || failures[0]).error;
      queue = failures.map((f) => f.source);
    }
    return { sources, ids };
  }

  function reportSource(source) {
    source.eligible = source.owned && source.count <= 4500;
    const state = !source.owned
      ? 'Read only'
      : source.count >= 5000
        ? 'Full'
        : source.selected
          ? 'Selected'
          : source.eligible
            ? 'Eligible'
            : 'Under 500 free';
    deps.onPlaylist?.(source, { state, count: source.count, eligible: canReceive(source) });
  }
  const canReceive = (source) => source.owned && source.count < 5000 && (source.selected || source.eligible);
  const pendingSave = (value) => deps.savePending?.(value);
  async function waitForCreation(title, read) {
    let error;
    for (const pause of [0, 500, 1000, 2000, 4000, 8000, 8000, 8000]) {
      if (pause) say('Waiting for playlist access: ' + title + ' · retrying automatically');
      for (let left = pause; left > 0; left -= 250) {
        checkpoint();
        await deps.delay?.(Math.min(250, left));
      }
      checkpoint();
      try {
        const data = await read();
        if (!data.owned) fail('The playlist is not editable yet.');
        return data;
      } catch (e) {
        if (!retryableRead(e)) throw e;
        error = e;
      }
    }
    fail(
      title +
        ': playlist access is still unavailable. Creation progress is saved; starting again reuses this playlist. ' +
        (error?.message || '')
    );
  }
  async function refreshSource(source, collection) {
    const data = await readPlaylist(source.id, source.title);
    // A stale header must not erase space already occupied by confirmed additions in this run.
    source.count = Math.max(source.count || 0, data.count);
    source.owned = data.owned;
    for (const row of data.rows) if (validId(row.id)) collection.ids.add(row.id);
    reportSource(source);
    return data;
  }
  async function reconcile(pending, collection, result = { added: 0 }) {
    if (!pending) return;
    if (!['create', 'add'].includes(pending.kind) || !matchTitle(pending.title))
      fail('The saved operation could not be read.');
    let source = collection.sources.find((s) => s.id === pending.id);
    if (pending.kind === 'create') {
      if (!source && !pending.id) {
        const matches = collection.sources.filter((s) => s.title === pending.title);
        if (matches.length === 1) source = matches[0];
      }
      if (source?.owned && typeof source.count === 'number') {
        pendingSave(null);
        return;
      }
      await confirmCreation(pending, collection, source);
      return;
    }
    if (!source)
      fail('The previous playlist creation is not visible yet. Retry after YouTube Music refreshes the library.');
    const data = await refreshSource(source, collection);
    if (!source.owned) fail('The previous destination is no longer editable.');
    if (pending.kind === 'add') {
      if (!Array.isArray(pending.ids) || pending.ids.some((id) => !validId(id)) || pending.ids.length > 50)
        fail('The saved batch could not be read.');
      const present = new Set(data.rows.map((r) => r.id)),
        missing = pending.ids.filter((id) => !present.has(id));
      if (Number.isSafeInteger(pending.baseCount) && pending.baseCount >= 0 && pending.baseCount <= 5000) {
        source.count = Math.max(source.count, pending.baseCount + pending.ids.length - missing.length);
        reportSource(source);
      }
      if (missing.length) {
        if (source.count + missing.length > 5000) fail('The previous batch cannot fit in its destination.');
        // The default server duplicate check remains enabled. Never use DEDUPE_OPTION_SKIP.
        await append(source, missing, collection, result);
      }
    }
    pendingSave(null);
  }
  async function confirmCreation(pending, collection, source) {
    if (pending.id && !/^[A-Za-z0-9_-]{2,150}$/.test(pending.id)) fail('The saved playlist ID could not be read.');
    if (!source && typeof pending.id === 'string' && /^[A-Za-z0-9_-]{2,150}$/.test(pending.id))
      source = { id: pending.id, title: pending.title, ...matchTitle(pending.title) };
    await waitForCreation(pending.title, async () => {
      if (!source) {
        const found = await discover(),
          matches = found.playlists.filter((s) => s.title === pending.title);
        if (matches.length !== 1) fail('The created playlist is not uniquely visible yet.');
        source = matches[0];
      }
      pending.id = source.id;
      pendingSave(pending);
      deps.onPlaylist?.(source, { state: 'Checking access' });
      return refreshSource(source, collection);
    });
    if (!collection.sources.some((s) => s.id === source.id)) collection.sources.push(source);
    collection.sources.sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
    pendingSave(null);
    deps.onCatalog?.({
      complete: true,
      playlists: collection.sources,
      similar: [],
      scanned: collection.sources.length
    });
    return source;
  }
  async function append(source, ids, collection, result) {
    let todo = ids.slice(),
      lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      checkpoint();
      if (!source.owned || source.count + todo.length > 5000)
        fail('The destination has no verified room for this batch.');
      const pending = { kind: 'add', id: source.id, title: source.title, ids: todo, baseCount: source.count };
      pendingSave(pending);
      let response;
      try {
        response = await deps.post(
          'browse/edit_playlist',
          { playlistId: source.id, actions: todo.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })) },
          { write: true, permit: pending }
        );
      } catch (e) {
        lastError = e;
        if (e?.fatal) throw e;
      }
      if (response?.status === 'STATUS_SUCCEEDED') {
        source.count += todo.length;
        for (const id of todo) collection.ids.add(id);
        result.added += todo.length;
        pendingSave(null);
        reportSource(source);
        deps.summary?.(result);
        return;
      }
      checkpoint();
      await deps.delay?.(700 * (attempt + 1));
      const data = await refreshSource(source, collection),
        present = new Set(data.rows.map((r) => r.id));
      const missing = todo.filter((id) => !present.has(id));
      result.added += todo.length - missing.length;
      source.count = Math.max(source.count, pending.baseCount + todo.length - missing.length);
      reportSource(source);
      if (!missing.length) {
        pendingSave(null);
        deps.summary?.(result);
        return;
      }
      todo = missing;
    }
    fail(
      'Some additions could not be confirmed. Completed additions are retained. Retry checks the same destination before continuing.' +
        (lastError?.httpStatus ? ' HTTP ' + lastError.httpStatus + '.' : '')
    );
  }
  async function createSource(collection) {
    // Refresh names before choosing the next numeral, including playlists added since scanning.
    const current = await discover();
    for (const source of current.playlists)
      if (!collection.sources.some((s) => s.id === source.id)) {
        collection.sources.push({ ...source });
        await refreshSource(collection.sources.at(-1), collection);
      }
    collection.sources.sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
    const room = collection.sources.find(canReceive);
    if (room) return room;
    const number = Math.max(0, ...collection.sources.map((s) => s.number)) + 1;
    if (number > 3999) fail('No unused supported Roman numeral remains.');
    const title = "Alfredo's __" + roman(number) + '__',
      pending = { kind: 'create', title };
    pendingSave(pending);
    let response;
    try {
      response = await deps.post(
        'playlist/create',
        { title, description: 'Alfredo collection', privacyStatus: 'PRIVATE' },
        { write: true, permit: pending }
      );
    } catch (e) {
      if (e?.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 408) {
        pendingSave(null);
        throw e;
      }
      if (mustStop(e)) throw e;
    }
    if (typeof response?.playlistId === 'string' && /^[A-Za-z0-9_-]{2,150}$/.test(response.playlistId)) {
      pending.id = response.playlistId;
      pendingSave(pending);
    }
    return confirmCreation(pending, collection);
  }

  function warn(input, message, kind) {
    job.result.warnings.push(input + ': ' + message);
    deps.onArtist?.(input, { state: 'Warning', message }, kind);
    deps.warning?.(input + ': ' + message);
  }
  async function importArtists(artists) {
    const { collection, result, catalogIds } = job,
      albums = new Set();
    for (const artist of artists) {
      checkpoint();
      deps.onArtist?.(artist.input, { state: 'Reading releases', artist }, artist.kind);
      try {
        await artistCatalog(artist, albums);
      } catch (e) {
        if (mustStop(e)) throw e;
        warn(artist.input, 'Artist catalog could not be read; continuing.', artist.kind);
      }
    }
    const songs = (await collectSongs(artists, albums)).filter((s) => !catalogIds.has(s.id));
    for (const song of songs) catalogIds.add(song.id);
    let remaining = songs.filter((s) => !collection.ids.has(s.id)).map((s) => s.id);
    result.found += songs.length;
    result.existing += songs.length - remaining.length;
    result.missing += remaining.length;
    deps.summary?.(result);
    const checked = new Set();
    while (remaining.length) {
      checkpoint();
      remaining = remaining.filter((id) => !collection.ids.has(id));
      if (!remaining.length) break;
      let source = collection.sources.find(canReceive);
      if (!source) {
        say('Creating the next collection playlist…');
        const before = collection.sources.length;
        source = await createSource(collection);
        result.created += collection.sources.length - before;
        checked.add(source.id);
      }
      if (!checked.has(source.id)) {
        await refreshSource(source, collection);
        checked.add(source.id);
        continue;
      }
      if (!canReceive(source)) continue;
      source.selected = true;
      const batch = remaining.slice(0, Math.min(50, 5000 - source.count));
      say(
        'Adding missing tracks: ' +
          result.added.toLocaleString() +
          '/' +
          result.missing.toLocaleString() +
          ' · ' +
          source.title
      );
      await append(source, batch, collection, result);
      remaining = remaining.filter((id) => !collection.ids.has(id));
      if (source.count >= 5000 || !remaining.length) {
        checkpoint();
        const data = await refreshSource(source, collection),
          present = new Set(data.rows.map((r) => r.id));
        if (batch.some((id) => !present.has(id)))
          fail(
            'YouTube Music has not exposed the last batch yet. Confirmed additions remain recorded; starting again reuses the collection.'
          );
      }
    }
    checkpoint();
    deps.summary?.(result);
  }
  async function drainChoices() {
    while (job.queue.length) {
      const artists = [];
      for (const candidate of job.queue.splice(0)) {
        const profile = job.profileIndex.get(candidate.id);
        if (job.included.has(profile)) {
          deps.onArtist?.(candidate.input, { state: 'Already included', artist: candidate }, candidate.kind);
          continue;
        }
        job.included.add(profile);
        // Pending and excluded namesakes still make an unlinked credit ambiguous.
        const creditNames = profile.names.map(nameKey).filter((name) => !job.ambiguousNames.has(name));
        artists.push({ ...candidate, aliases: profile.aliases, routes: profile.routes, creditNames });
      }
      job.result.matched = job.included.size;
      if (artists.length) await importArtists(artists);
    }
    checkpoint();
    job.result.pendingChoices = pendingChoices();
    deps.summary?.(job.result);
    return job.result;
  }
  async function resumeChoices() {
    if (!job?.resumable) fail('Start again to import the saved artist choices.');
    job.resumable = false;
    const result = await drainChoices();
    job.resumable = true;
    return result;
  }

  async function resolveInput({ kind, value }) {
    const direct = kind === 'channelId';
    deps.onArtist?.(value, { state: direct ? 'Looking up channel ID' : 'Searching' }, kind);
    say((direct ? 'Looking up channel ID: ' : 'Finding artist: ') + value);
    try {
      if (direct) {
        const artist = await resolveChannelId(value);
        job.queue.push(artist);
        deps.onArtist?.(value, { state: 'Artist confirmed', artist }, kind);
        return [artist];
      }
      const matches = await resolveArtist(value);
      if (!matches.length) {
        warn(value, 'No exact artist match; skipped.', kind);
      } else if (matches.length > 1 || choices.has(nameKey(value))) {
        unresolved.set(nameKey(value), matches);
        showChoices(value, matches);
        job.queue.push(...matches.filter((a) => a.use === true));
      } else {
        job.queue.push(matches[0]);
      }
      return matches;
    } catch (e) {
      if (mustStop(e)) throw e;
      const message = direct
        ? e?.message || 'Channel lookup failed.'
        : 'Artist catalog could not be read; continuing.';
      warn(value, message, kind);
      return [];
    }
  }

  async function run(input) {
    const inputs = parseInputs(input);
    const profiles = [];
    artistPages.clear();
    unresolved.clear();
    job = {
      queue: [],
      included: new Set(),
      catalogIds: new Set(),
      resumable: false,
      result: {
        requested: inputs.length,
        matched: 0,
        found: 0,
        existing: 0,
        missing: 0,
        added: 0,
        created: 0,
        pendingChoices: 0,
        warnings: []
      }
    };
    checkpoint();
    deps.summary?.(job.result);
    // A newly discovered source whose read failed makes the snapshot incomplete.
    if (collectionCache?.sources.some((s) => !Number.isSafeInteger(s.count) || typeof s.owned !== 'boolean'))
      collectionCache = null;
    if (!collectionCache) {
      say('Reading the collection…');
      collectionCache = await scanCollection();
    } else {
      say('Reusing the collection already read in this panel…');
      deps.onCatalog?.({
        complete: true,
        playlists: collectionCache.sources,
        similar: [],
        scanned: collectionCache.sources.length
      });
      for (const source of collectionCache.sources) {
        source.selected = false;
        reportSource(source);
      }
      deps.onScan?.({ playlists: collectionCache.sources.length, count: collectionCache.ids.size, reused: true });
    }
    job.collection = collectionCache;
    await reconcile(deps.loadPending?.(), job.collection, job.result);
    for (const entry of inputs) {
      checkpoint();
      profiles.push(...(await resolveInput(entry)));
    }
    // Choices can be accepted later. Index every verified relationship before
    // importing so an alias discovered by a pending name retains its catalog.
    job.profileIndex = indexArtistProfiles(profiles);
    job.ambiguousNames = ambiguousCreditNames(job.profileIndex);
    const result = await drainChoices();
    job.resumable = true;
    return result;
  }
  return {
    parseInputs,
    roman,
    matchTitle,
    discover,
    readPlaylist,
    searchArtist,
    resolveArtist,
    artistCatalog,
    parseAlbum,
    musicRow,
    collectSongs,
    scanCollection,
    append,
    createSource,
    reconcile,
    run,
    chooseArtist,
    forgetChoice,
    resetChoices,
    resumeChoices,
    hasQueuedChoices: () => !!(job?.resumable && job.queue.length)
  };
}

function launchMusicCollectionImporter(makeCore) {
  'use strict';
  const ORIGIN = 'https://music.youtube.com',
    ROOT = 'youtube-music-alfredo-import-panel';
  if (location.origin !== ORIGIN) {
    alert('Open https://music.youtube.com while signed in, then click the + bookmark for Add Songs.');
    return;
  }
  if (document.getElementById(ROOT)) {
    document.getElementById(ROOT).shadowRoot?.querySelector('textarea')?.focus();
    return;
  }
  const cfg = (key) => window.ytcfg?.get?.(key) ?? window.yt?.config_?.[key];
  const identity = () =>
    JSON.stringify([cfg('SESSION_INDEX') ?? 0, cfg('DELEGATED_SESSION_ID') || '', cfg('DATASYNC_ID') || '']);
  const account = identity(),
    original = cfg('INNERTUBE_CONTEXT');
  if (
    !original?.client?.clientVersion ||
    !['WEB_REMIX', 67].includes(original.client.clientName) ||
    cfg('LOGGED_IN') === false
  ) {
    alert('Sign in to YouTube Music and reload the page, then click the + bookmark for Add Songs.');
    return;
  }
  const context = JSON.parse(JSON.stringify(original));
  context.client.clientName = 'WEB_REMIX';
  context.client.hl = 'en';
  const key = 'alfredo-import-v1:' + account;
  let running = false,
    stopped = false,
    pending = null,
    storedChoices = [],
    storageError = false,
    core,
    writing = 0,
    canResume = false,
    closed = false;
  const controllers = new Set(),
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fatal = (message) => Object.assign(new Error(message), { fatal: true });
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    pending = saved.pending || null;
    storedChoices = Array.isArray(saved.choices) ? saved.choices : [];
  } catch {
    storageError = true;
  }

  function save() {
    try {
      localStorage.setItem(key, JSON.stringify({ pending, choices: storedChoices }));
      storageError = false;
    } catch {
      storageError = true;
      throw fatal('Firefox could not save recovery progress. Allow site storage before starting additions.');
    }
  }

  function checkAccount(honorCancel = true) {
    if (identity() !== account || cfg('LOGGED_IN') === false)
      throw fatal('The selected YouTube Music account changed. Close and reopen the tool.');
    if (honorCancel && stopped) throw Object.assign(new Error('Canceled.'), { canceled: true });
  }
  const cookie = (name) =>
    document.cookie
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(name + '='))
      ?.slice(name.length + 1);
  async function auth() {
    const sid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (!sid) throw fatal('The current sign-in could not be used. Sign in and reload YouTube Music.');
    const stamp = Math.floor(Date.now() / 1000),
      digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(stamp + ' ' + sid + ' ' + ORIGIN));
    return (
      'SAPISIDHASH ' +
      stamp +
      '_' +
      Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('')
    );
  }
  async function post(endpoint, payload, options = {}) {
    const isWrite = ['playlist/create', 'browse/edit_playlist'].includes(endpoint);
    if (
      !['browse', 'search', 'playlist/create', 'browse/edit_playlist'].includes(endpoint) ||
      isWrite !== !!options.write
    )
      throw fatal('An unsupported request was blocked.');
    if (isWrite) {
      checkAccount();
      if (storageError) throw fatal('Recovery progress cannot be saved.');
      if (
        endpoint === 'playlist/create' &&
        (pending?.kind !== 'create' ||
          pending.title !== payload.title ||
          !core.matchTitle(payload.title) ||
          payload.privacyStatus !== 'PRIVATE' ||
          payload.videoIds ||
          payload.sourcePlaylistId)
      )
        throw fatal('An invalid creation request was blocked.');
      if (
        endpoint === 'browse/edit_playlist' &&
        (pending?.kind !== 'add' ||
          pending.id !== payload.playlistId ||
          !payload.actions?.length ||
          payload.actions.length > 50 ||
          payload.actions.some(
            (a) => a.action !== 'ACTION_ADD_VIDEO' || a.dedupeOption || !pending.ids.includes(a.addedVideoId)
          ))
      )
        throw fatal('An invalid addition was blocked.');
    }
    for (let attempt = 0; attempt < (isWrite ? 1 : 3); attempt++) {
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
      const apiKey = cfg('INNERTUBE_API_KEY'),
        query = options.continuation
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
        (apiKey ? '&key=' + encodeURIComponent(apiKey) : '') +
        query;
      checkAccount();
      const controller = new AbortController();
      if (!isWrite) controllers.add(controller);
      else writing++;
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
        checkAccount(!isWrite);
        if (!response.ok) {
          if (!isWrite && attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
            await delay(1000 * (attempt + 1));
            continue;
          }
          throw Object.assign(new Error('YouTube Music returned HTTP ' + response.status + '.'), {
            httpStatus: response.status
          });
        }
        const json = await response.json();
        checkAccount(!isWrite);
        if (json.error)
          throw Object.assign(new Error(json.error.message || 'YouTube Music rejected the request.'), {
            httpStatus: json.error.code
          });
        if (json.responseContext?.visitorData) context.client.visitorData = json.responseContext.visitorData;
        return json;
      } catch (e) {
        if (e.fatal) throw e;
        if (stopped) throw Object.assign(new Error('Canceled.'), { canceled: true });
        if (!isWrite && attempt < 2 && (e instanceof TypeError || e.name === 'AbortError')) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        if (isWrite) writing--;
      }
    }
  }
  const previousFocus = document.activeElement,
    host = document.createElement('div');
  host.id = ROOT;
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
  const shadow = host.attachShadow({ mode: 'open' });

  function el(tag, parent, text, attrs = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.append(node);
    return node;
  }
  el(
    'style',
    shadow,
    `:host{color-scheme:dark;font-family:system-ui,sans-serif;color:#e9f4ef}*{box-sizing:border-box}.shade{position:absolute;inset:0;background:#07120eea;overflow:auto;padding:24px}.box{max-width:860px;margin:0 auto;background:#14221e;border:1px solid #3a5148;border-radius:18px;padding:28px;box-shadow:0 24px 80px #0007}.eyebrow{font-size:11px;font-weight:750;color:#9cc9b7;letter-spacing:2px}h1{font-size:30px;margin:8px 0}p,.hint{color:#b7cbbf;line-height:1.6;font-size:14px}.hint{font-size:12px}label{display:block;font-size:14px;font-weight:650;margin:22px 0 9px}textarea{width:100%;min-height:98px;border:1px solid #557267;background:#0d1914;border-radius:9px;padding:13px;color:#f1faf5;font:15px/1.5 system-ui;resize:vertical}button{font:650 14px system-ui;padding:11px 16px;border:1px solid #566c62;border-radius:8px;background:#24392f;color:#f1faf5;cursor:pointer}button.primary{background:#9ee2bd;border-color:#9ee2bd;color:#102719}button:disabled{opacity:.45;cursor:default}.actions{display:flex;flex-wrap:wrap;gap:10px;margin:15px 0 24px}button.close{margin-left:auto}.status{font-size:15px;line-height:1.6;overflow-wrap:anywhere;min-height:28px}.error{color:#ffd0ba}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:17px 0}.metric{border:1px solid #344c40;background:#192e23;padding:13px;border-radius:9px}.value{display:block;font-size:24px;font-weight:750;margin-bottom:3px}.caption{color:#b4cabd;font-size:12px}.warnings{padding:12px 15px;background:#463a20;color:#ffe6ae;border-radius:8px;font-size:13px;line-height:1.6;white-space:pre-line;margin:15px 0}.lists{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:24px}h2{font-size:15px;margin:0 0 10px}.list{max-height:260px;overflow:auto;border-top:1px solid #3a5148}.row{padding:10px 0;border-bottom:1px solid #2c4437;font-size:13px;line-height:1.5;overflow-wrap:anywhere}.row small{display:block;color:#afc5b6;font-size:12px}a{color:#9ee2bd;text-decoration:none}a:hover{text-decoration:underline}[hidden]{display:none!important}:focus-visible{outline:3px solid #bdedd0;outline-offset:3px}@media(max-width:650px){.shade{padding:8px}.box{padding:18px}.lists{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}h1{font-size:26px}}`
  );
  el(
    'style',
    shadow,
    '.warnings{padding:0;overflow-y:auto;overscroll-behavior:contain}.warning{padding:8px 15px;overflow-wrap:anywhere}.choice-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.choice-actions button[aria-pressed="true"]{opacity:1;background:#9ee2bd;border-color:#9ee2bd;color:#102719}.choice-actions button[data-use="false"][aria-pressed="true"]{background:#ffe0b6;border-color:#ffe0b6;color:#452700}'
  );
  const shade = el('div', shadow, '', { class: 'shade' }),
    box = el('section', shade, '', {
      class: 'box',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'import-title'
    });
  el('div', box, 'ALFREDO COLLECTION / YOUTUBE MUSIC · 2.2.0', { class: 'eyebrow' });
  el('h1', box, 'Add Songs', { id: 'import-title' });
  el(
    'p',
    box,
    'Missing tracks go into collection playlists with at least 500 free slots. Once selected, a playlist can fill to 5,000 entries.'
  );
  el(
    'p',
    box,
    'Temporary read failures can be retried. This panel reuses and updates a completed collection scan. Close and reopen it for a fresh scan.',
    { class: 'hint' }
  );
  const form = el('form', box);
  el('label', form, 'Artist names or YouTube channel IDs', { for: 'import-artists' });
  const input = el('textarea', form, '', {
    id: 'import-artists',
    placeholder: 'Count Basie, UCPzoHRR53Gi5pT8kHU9FptQ, "Earth, Wind & Fire"',
    'aria-describedby': 'import-input-hint',
    spellcheck: 'false',
    required: ''
  });
  el(
    'div',
    form,
    'Separate entries with commas or line breaks. Paste channel IDs without quotes. Put artist names containing commas in double quotes.',
    { class: 'hint', id: 'import-input-hint' }
  );
  const actions = el('div', form, '', { class: 'actions' }),
    start = el('button', actions, 'Add missing songs', { type: 'submit', class: 'primary' }),
    cancel = el('button', actions, 'Cancel', { type: 'button' }),
    close = el('button', actions, 'Close', { type: 'button', class: 'close' });
  cancel.hidden = true;
  const status = el('div', box, 'Ready. The process starts when Add missing songs is clicked.', {
    role: 'status',
    'aria-live': 'polite',
    class: 'status'
  });
  const scanProgress = el('div', box, '', { class: 'hint', id: 'import-scan', 'aria-live': 'polite' });
  const stats = el('div', box, '', { class: 'stats' }),
    values = {};
  for (const [key, title] of [
    ['requested', 'Requested inputs'],
    ['matched', 'Matched artists'],
    ['found', 'Catalog tracks found'],
    ['existing', 'Already in collection'],
    ['added', 'Tracks added']
  ]) {
    const item = el('div', stats, '', { class: 'metric' });
    values[key] = el('span', item, '0', { class: 'value' });
    el('span', item, title, { class: 'caption' });
  }
  const warnings = el('div', box, '', {
    class: 'warnings',
    role: 'note',
    tabindex: '0',
    'aria-label': 'Artist lookup and import warnings'
  });
  warnings.hidden = true;
  const savedSection = el('details', box),
    savedTitle = el('summary', savedSection, 'Saved artist choices'),
    reset = el('button', savedSection, 'Reset saved artists', { type: 'button' }),
    savedList = el('div', savedSection);
  savedSection.hidden = true;
  const lists = el('div', box, '', { class: 'lists' }),
    artistSection = el('section', lists),
    sourceSection = el('section', lists);
  el('h2', artistSection, 'Artists');
  const artistList = el('div', artistSection, '', { class: 'list' });
  const sourceTitle = el('h2', sourceSection, 'Collection playlists'),
    sourceList = el('div', sourceSection, '', { class: 'list', id: 'import-playlists' });
  el(
    'p',
    box,
    'Albums, singles, and EPs are read in full where YouTube Music exposes them. Unreadable releases and tracks are skipped. Tracks count by album artist; compilations use the main track artist. Different track IDs remain distinct.',
    { class: 'hint' }
  );
  el(
    'p',
    box,
    'A channel ID selects its artist for this run. For a name shared by several artists, choose each profile you want to include. These name choices are saved for this account.',
    { class: 'hint' }
  );
  el(
    'p',
    box,
    'Keep this tab open. Cancel keeps completed additions. Interrupted additions are saved for recovery.',
    { class: 'hint' }
  );
  const artistNodes = new Map(),
    sourceNodes = new Map(),
    warningLines = new Set();

  function resizeWarnings() {
    const heights = [...warnings.children].map((row) => row.getBoundingClientRect().height);
    warnings.style.maxHeight =
      Math.min(
        heights.reduce((sum, h) => sum + h, 0),
        5 * Math.min(...heights)
      ) + 'px';
  }

  function warning(message) {
    if (warningLines.has(message)) return;
    warningLines.add(message);
    el('div', warnings, message, { class: 'warning' });
    warnings.hidden = false;
    resizeWarnings();
  }
  window.addEventListener('resize', resizeWarnings);
  reset.addEventListener('click', () => {
    if (running) return;
    try {
      checkAccount(false);
      if (
        confirm(
          'Reset all saved artist selections and exclusions? Songs already added will stay in the collection.'
        )
      ) {
        core.resetChoices();
        status.textContent = 'Saved artist choices cleared. New decisions apply on the next start.';
      }
    } catch (e) {
      status.textContent = e.message;
      status.setAttribute('class', 'status error');
    }
  });

  function summary(value) {
    for (const key of Object.keys(values)) values[key].textContent = (value[key] || 0).toLocaleString();
  }

  function onChoices(choices) {
    savedList.replaceChildren();
    savedSection.hidden = !choices.length;
    savedTitle.textContent = 'Saved artist choices (' + choices.length + ')';
    for (const choice of choices) {
      const row = el('div', savedList, '', { class: 'row' });
      el('strong', row, choice.input);
      for (const decision of choice.decisions || [{ id: choice.id, use: true }]) {
        const line = el('div', row);
        el('a', line, (decision.use ? 'Use: ' : "Don't use: ") + decision.id, {
          href: ORIGIN + '/browse/' + encodeURIComponent(decision.id),
          target: '_blank',
          rel: 'noopener noreferrer'
        });
      }
      const forget = el('button', row, 'Forget choice', { type: 'button' });
      forget.disabled = running;
      forget.addEventListener('click', () => {
        if (running) return;
        try {
          checkAccount(false);
          core.forgetChoice(choice.input);
        } catch (e) {
          status.textContent = e.message;
          status.setAttribute('class', 'status error');
        }
      });
    }
  }

  function onArtist(input, value, kind = 'name') {
    const direct = kind === 'channelId',
      key = kind + '\n' + input;
    let node = artistNodes.get(key);
    if (!node) {
      const row = el('div', artistList, '', { class: 'row' });
      node = {
        name: el('a', row, direct ? 'Channel ID · ' + input : input, {
          target: '_blank',
          rel: 'noopener noreferrer'
        }),
        state: el('small', row),
        choices: el('div', row)
      };
      artistNodes.set(key, node);
    }
    // A merged artist can have several names. Keep the title verified for this specific ID.
    if (value.artist && (!direct || !node.name.hasAttribute('href'))) {
      node.name.setAttribute('href', ORIGIN + '/browse/' + encodeURIComponent(direct ? input : value.artist.id));
      if (direct) node.name.textContent = value.artist.name + ' · ' + input;
    }
    node.state.textContent =
      value.message ||
      value.state + (typeof value.count === 'number' ? ' · ' + value.count.toLocaleString() + ' tracks' : '');
    if (value.candidates) {
      node.choices.replaceChildren();
      for (const artist of value.candidates) {
        const option = el('div', node.choices, '', { class: 'row' });
        el('a', option, artist.name + ' · ' + artist.id, {
          href: ORIGIN + '/browse/' + encodeURIComponent(artist.id),
          target: '_blank',
          rel: 'noopener noreferrer'
        });
        el(
          'small',
          option,
          artist.samples.length
            ? 'Sample releases: ' + artist.samples.join(' · ')
            : 'Open the artist page to check this match.'
        );
        if (typeof artist.use === 'boolean') el('small', option, artist.use ? 'Selected' : 'Excluded');
        const buttons = el('div', option, '', { class: 'choice-actions' });
        for (const use of [true, false]) {
          const selected = artist.use === use;
          const choose = el(
            'button',
            buttons,
            (selected ? '✓ ' : '') + (use ? 'Use this artist' : "Don't use this artist"),
            {
              type: 'button',
              'data-artist-id': artist.id,
              'data-use': String(use),
              'aria-pressed': String(selected)
            }
          );
          choose.disabled = typeof artist.use === 'boolean';
          choose.addEventListener('click', () => {
            try {
              checkAccount(false);
              core.chooseArtist(input, artist.id, use);
              if (stopped || (!running && !canResume)) node.state.textContent = 'Choice saved for the next start.';
              if (!running && canResume && !stopped) execute('resume');
            } catch (e) {
              status.textContent = e.message;
              status.setAttribute('class', 'status error');
            }
          });
        }
      }
    }
  }

  function onPlaylist(source, value) {
    let record = sourceNodes.get(source.id);
    if (!record) {
      const row = el('div', sourceList, '', { class: 'row' });
      el('a', row, source.title, {
        href: ORIGIN + '/playlist?list=' + encodeURIComponent(source.id),
        target: '_blank',
        rel: 'noopener noreferrer'
      });
      record = {
        row,
        node: el('small', row),
        number: source.number || core.matchTitle(source.title)?.number || Infinity,
        title: source.title,
        id: source.id
      };
      sourceNodes.set(source.id, record);
      sourceList.replaceChildren(
        ...[...sourceNodes.values()]
          .sort((a, b) => a.number - b.number || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
          .map((r) => r.row)
      );
    }
    const node = record.node;
    node.textContent =
      (value.eligible ? '✓ ' : '') +
      value.state +
      (typeof value.count === 'number'
        ? ' · ' +
          value.count.toLocaleString() +
          (value.scanning || value.state === 'Reading'
            ? ' entries read'
            : ' / 5,000 used · ' + Math.max(0, 5000 - value.count).toLocaleString() + ' free')
        : '');
    node.style.color = value.eligible ? '#9ee2bd' : '';
    sourceTitle.textContent = 'Collection playlists (' + sourceNodes.size + ')';
  }
  core = makeCore({
    post,
    delay,
    cancelled: () => stopped,
    progress: (message) => {
      status.textContent = message;
    },
    warning,
    summary,
    onArtist,
    onPlaylist,
    onScan: (value) => {
      scanProgress.textContent =
        (value.reused ? 'Collection reused: ' : 'Collection scan: ') +
        value.playlists.toLocaleString() +
        ' playlists · ' +
        value.count.toLocaleString() +
        (value.reused ? ' distinct tracks' : ' songs read');
    },
    onCatalog: (value) => {
      for (const source of value.playlists)
        if (!sourceNodes.has(source.id)) onPlaylist(source, { state: 'Found' });
    },
    loadPending: () => pending,
    savePending: (value) => {
      pending = value;
      save();
    },
    loadChoices: () => storedChoices,
    saveChoices: (value) => {
      const before = storedChoices;
      storedChoices = value;
      try {
        save();
      } catch (e) {
        storedChoices = before;
        throw e;
      }
    },
    onChoices
  });

  function setRunning(value) {
    running = value;
    start.disabled = value;
    input.disabled = value;
    cancel.hidden = !value;
    cancel.disabled = false;
    close.disabled = value;
    for (const button of savedSection.querySelectorAll('button')) button.disabled = value;
  }
  async function execute(mode = 'start') {
    if (running || closed) return;
    if (mode === 'start') {
      try {
        core.parseInputs(input.value);
      } catch (e) {
        status.textContent = e.message;
        input.focus();
        return;
      }
    }
    stopped = false;
    setRunning(true);
    status.setAttribute('class', 'status');
    if (mode === 'start') {
      canResume = false;
      warningLines.clear();
      warnings.replaceChildren();
      warnings.hidden = true;
      scanProgress.textContent = 'Collection scan: 0 songs read';
      artistList.replaceChildren();
      sourceList.replaceChildren();
      artistNodes.clear();
      sourceNodes.clear();
      summary({});
    }
    try {
      checkAccount();
      save();
      const result = mode === 'resume' ? await core.resumeChoices() : await core.run(input.value);
      canResume = true;
      summary(result);
      status.textContent =
        'Finished. ' +
        result.added.toLocaleString() +
        ' missing tracks added.' +
        (result.pendingChoices ? ' ' + result.pendingChoices + ' artist names still need decisions.' : '');
    } catch (e) {
      canResume = false;
      status.textContent = stopped ? 'Canceled. Completed additions are retained.' : e.message;
      if (!stopped) status.setAttribute('class', 'status error');
    } finally {
      setRunning(false);
      if (canResume && !stopped && core.hasQueuedChoices()) setTimeout(() => execute('resume'), 0);
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    execute();
  });
  cancel.addEventListener('click', () => {
    stopped = true;
    cancel.disabled = true;
    status.textContent = writing ? 'Finishing current requests, then stopping…' : 'Canceling…';
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
      closed = true;
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('resize', resizeWarnings);
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
      const nodes = [...shadow.querySelectorAll('button,textarea,a[href],[tabindex="0"]')].filter(
          (e) => !e.disabled && !e.hidden && e.getClientRects().length
        ),
        first = nodes[0],
        last = nodes.at(-1);
      if (event.shiftKey && shadow.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && shadow.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  document.documentElement.append(host);
  onChoices(storedChoices);
  setRunning(false);
  input.focus();
}

launchMusicCollectionImporter(makeCollectionImporterCore);
