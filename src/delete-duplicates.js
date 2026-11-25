/* Delete Duplicates 1.0.3 — exact YouTube Music playlist occurrences. */
function makeCollectionDuplicatesCore(deps) {
  'use strict';
  const fail = (message) => {
    throw new Error(message);
  };
  const checkpoint = () => {
    if (deps.cancelled?.()) throw Object.assign(new Error('Canceled.'), { canceled: true });
  };
  const mustStop = (e) => e?.fatal || e?.canceled || deps.cancelled?.();
  const say = (message) => deps.progress?.(message);
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
    fail('Library discovery did not finish. The scan is incomplete.');
  }
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
  const validToken = (id) =>
    typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\x00-\x20\x7f]/.test(id);
  const cleanName = (value) =>
    String(value || '')
      .normalize('NFC')
      .replace(/\s+/gu, ' ')
      .trim();
  const nameKey = (value) => cleanName(value).toLocaleLowerCase('en');

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
      (e.actions || [])
        .filter((a) => a.action === 'ACTION_REMOVE_VIDEO')
        .map((a) => a.removedVideoId)
        .filter(Boolean)
    );
    const originals = [...new Set([r.playlistItemData?.videoId, ...removedIds].filter(validId))];
    const id =
      originals.length === 1
        ? originals[0]
        : originals.length > 1
          ? ''
          : play?.playNavigationEndpoint?.watchEndpoint?.videoId ||
            r.navigationEndpoint?.watchEndpoint?.videoId ||
            columnEndpoints[0]?.videoId ||
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
    const edits = find(r.menu, 'playlistEditEndpoint').flatMap((e) =>
      (e.actions || [])
        .filter((a) => a.action === 'ACTION_REMOVE_VIDEO' && a.removedVideoId === id)
        .map((a) => ({ ...a, playlistId: e.playlistId }))
    );
    const tokens = [r.playlistItemData?.playlistSetVideoId, ...edits.map((a) => a.setVideoId)].filter(Boolean);
    const unique = [...new Set(tokens)];
    const setVideoId = unique.length === 1 && validToken(unique[0]) ? unique[0] : null;
    const duration =
      (r.fixedColumns || [])
        .map((c) => textOf(c.musicResponsiveListItemFixedColumnRenderer?.text))
        .find((t) => /^\d+:\d{2}(?::\d{2})?$/.test(t)) || '';
    return {
      id,
      title,
      setVideoId,
      duration,
      removableIn: edits
        .filter((a) => a.setVideoId === setVideoId)
        .map((a) => a.playlistId)
        .filter(Boolean),
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
        fail('A collection entry could not be read. Duplicate checks could not be completed.');
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

  function checkReadResponse(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json))
      fail('The playlist response was not a readable object.');
    if (json.error)
      throw Object.assign(new Error(json.error.message || 'YouTube Music rejected the playlist request.'), {
        httpStatus: json.error.code
      });
    if (json.responseContext?.mainAppWebResponseContext?.loggedOut === true)
      throw Object.assign(new Error('The account is signed out.'), { fatal: true });
    const errors = find(json.alerts, 'alertRenderer').filter((a) => a.type === 'ERROR');
    if (errors.length) fail(textOf(errors[0].text) || 'YouTube Music could not open this playlist.');
  }

  function continuationScope(json, id, targetId) {
    const known = (value) => !!value && [targetId, id, 'VL' + id].includes(value);
    const rejectedTarget = (value) => !!value && /suggest|recommend|related|radio/i.test(value);
    const candidates = [];

    function candidate(node, key, kind) {
      if (!node || typeof node !== 'object') return;
      // A missing list at the end of a continuation is different from malformed data.
      if (node[key] !== undefined && !Array.isArray(node[key])) return;
      candidates.push({ node, items: node[key], kind, target: node.targetId || node.playlistId || null });
    }
    for (const kind of ['musicPlaylistShelfContinuation', 'musicShelfContinuation']) {
      const node = json.continuationContents?.[kind];
      candidate(node, node?.contents === undefined && node?.items !== undefined ? 'items' : 'contents', kind);
    }
    for (const root of [
      json.onResponseReceivedActions,
      json.onResponseReceivedEndpoints,
      json.onResponseReceivedCommands
    ])
      for (const node of find(root, 'appendContinuationItemsAction'))
        candidate(node, 'continuationItems', 'append');
    const unique = [
      ...new Map(candidates.map((c) => [JSON.stringify([c.target, c.items, c.node.continuations]), c])).values()
    ];
    let matches = unique.filter((c) => known(c.target));
    const hasEntries = (c) =>
      Array.isArray(c.items) &&
      c.items.some((item) => {
        const r = item.musicResponsiveListItemRenderer;
        if (!r) return false;
        const row = musicRow(r);
        return (
          !!row.setVideoId &&
          (r.playlistItemData || row.removableIn.some((value) => [id, 'VL' + id].includes(value)))
        );
      });
    const belongs = (c) =>
      !rejectedTarget(c.target) &&
      (!c.node.playlistId || [id, 'VL' + id].includes(c.node.playlistId)) &&
      (c.items || []).every((item) => {
        const r = item.musicResponsiveListItemRenderer;
        if (!r) return !!(item.continuationItemRenderer || item.messageRenderer);
        if (r.playlistItemData?.playlistId && ![id, 'VL' + id].includes(r.playlistItemData.playlistId))
          return false;
        const row = musicRow(r);
        return !row.removableIn.length || row.removableIn.some((value) => [id, 'VL' + id].includes(value));
      });
    if (!matches.length)
      matches = unique.filter(
        (c) => belongs(c) && (!c.target || c.kind === 'musicPlaylistShelfContinuation' || hasEntries(c))
      );
    if (matches.length === 1) {
      const c = matches[0];
      if (!belongs(c)) fail('A continuation referred to another playlist or an unrelated list.');
      // Preserve scope continuations in both classic and action-style responses.
      const scope = { ...c.node, contents: c.items || [] };
      if (c.items === undefined && nextPage(scope, []))
        fail('A continuation had a next-page token but no entry list.');
      return { scope, targetId: c.target || targetId, weakEnd: c.items === undefined };
    }
    // YouTube can answer the final token with metadata only. Require a second
    // empty reply before accepting this, and never use it as proof of absence.
    const metadataOnly = Object.entries(json).every(
      ([key, value]) =>
        ['responseContext', 'trackingParams'].includes(key) ||
        (['onResponseReceivedActions', 'onResponseReceivedEndpoints', 'onResponseReceivedCommands'].includes(
          key
        ) &&
          Array.isArray(value) &&
          !value.length) ||
        (key === 'continuationContents' && value && typeof value === 'object' && !Object.keys(value).length)
    );
    if (!unique.length && metadataOnly) return { scope: { contents: [] }, targetId, weakEnd: true };
    const shape = Object.keys(json).join(', ').slice(0, 180);
    fail(
      'The next playlist page could not be identified. Response fields: ' +
        (shape || '(none)') +
        '; list candidates: ' +
        unique
          .map(
            (c) =>
              c.kind +
              '/' +
              (known(c.target) ? 'matching target' : c.target ? 'other target' : 'no target') +
              '/' +
              (c.items?.length ?? 'no list')
          )
          .join(', ') +
        '.'
    );
  }
  const playlistReadState = () => ({
    rows: [],
    seen: new Set(),
    next: null,
    targetId: null,
    pages: 0,
    complete: false,
    owned: false,
    declared: null,
    weakEnd: false
  });
  async function readPlaylist(id, label = 'Reading source', onPage, halt, state = playlistReadState()) {
    checkpoint();
    while (!state.complete && state.pages < 1000) {
      checkpoint();
      if (halt?.()) fail('Source scan stopped.');
      const next = state.next;
      const request = () =>
        !next
          ? deps.post('browse', { browseId: 'VL' + id })
          : next.mode === 'query'
            ? deps.post('browse', { browseId: 'VL' + id }, { continuation: next.token })
            : deps.post('browse', { continuation: next.token });
      const json = await request();
      checkpoint();
      if (halt?.()) fail('Source scan stopped.');
      checkReadResponse(json);
      let scope,
        targetId = state.targetId,
        owned = state.owned,
        declared = state.declared,
        weakEnd = false;
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
        try {
          let decoded = continuationScope(json, id, targetId);
          if (decoded.weakEnd) {
            checkpoint();
            await deps.delay?.(250);
            checkpoint();
            if (halt?.()) fail('Source scan stopped.');
            const confirmation = await request();
            checkpoint();
            if (halt?.()) fail('Source scan stopped.');
            checkReadResponse(confirmation);
            decoded = continuationScope(confirmation, id, targetId);
          }
          ({ scope, targetId, weakEnd } = decoded);
        } catch (e) {
          e.message = label + ' · ' + state.rows.length.toLocaleString() + ' entries: ' + e.message;
          throw e;
        }
      }
      const parsed = unpack(scope);
      if (parsed.next && state.seen.has(parsed.next.token))
        fail('YouTube Music repeated a playlist page. The scan is incomplete.');
      // Commit only a fully validated page. A retry requests the failed page again.
      state.rows.push(...parsed.rows);
      if (parsed.next) state.seen.add(parsed.next.token);
      Object.assign(state, {
        next: parsed.next,
        targetId,
        owned,
        declared,
        weakEnd,
        pages: state.pages + 1,
        complete: !parsed.next
      });
      if (onPage) onPage(state.rows.length);
      else say(label + ': ' + state.rows.length.toLocaleString() + ' entries');
    }
    if (!state.complete) fail('The playlist did not finish loading. Nothing further was changed.');
    // Pagination determines completion; the header may include omitted entries.
    return {
      rows: state.rows,
      owned: state.owned,
      count: Math.max(state.rows.length, state.declared || 0),
      weakEnd: state.weakEnd
    };
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

  let catalog = null,
    run = null,
    groups = [],
    cursor = 0,
    inflight = null,
    busy = false;
  let totals = { groups: 0, finished: 0, remaining: 0, removed: 0, absent: 0, pending: 0 };
  const tallies = new Map();

  function tally(g) {
    const n = { finished: ['done', 'skipped'].includes(g.status) ? 1 : 0, removed: 0, absent: 0, pending: 0 };
    for (const c of g.copies) {
      if (c.state === 'removed') n.removed++;
      if (c.state === 'absent') n.absent++;
      if (c.state === 'pending') n.pending++;
    }
    const old = tallies.get(g.index) || { finished: 0, removed: 0, absent: 0, pending: 0 };
    for (const k of Object.keys(n)) totals[k] += n[k] - old[k];
    tallies.set(g.index, n);
    totals.remaining = totals.groups - totals.finished;
  }

  function resetTotals() {
    totals = { groups: groups.length, finished: 0, remaining: groups.length, removed: 0, absent: 0, pending: 0 };
    tallies.clear();
    for (const g of groups) tally(g);
  }
  const readStates = new Map();
  const sourceState = (s, state, count) => deps.onPlaylist?.(s, { state, count });
  const fatal = (message) => Object.assign(new Error(message), { fatal: true });
  async function saved(fn) {
    try {
      return await fn();
    } catch (e) {
      throw fatal('Progress could not be saved. Pending deletions stopped. ' + (e.message || ''));
    }
  }
  const label = (c) =>
    c.playlistTitle +
    ' · ' +
    (c.copiesInPlaylist > 1 ? 'copy ' + c.copyNumber + ' of ' + c.copiesInPlaylist + ' · ' : '') +
    'scan position ' +
    c.position;
  const trackText = (g) =>
    (g.track.title || '(Untitled track)') +
    ' — ' +
    (g.track.artists?.map((a) => a.name).join(', ') || 'Artist unavailable') +
    (g.track.album?.name ? ' — ' + g.track.album.name : '') +
    (g.track.duration ? ' — ' + g.track.duration : '') +
    '\nhttps://music.youtube.com/watch?v=' +
    g.videoId;

  function event(g, heading, copies = [], detail = '') {
    return {
      runId: run.id,
      text:
        heading +
        '\n' +
        trackText(g) +
        (detail ? '\n' + detail : '') +
        copies
          .map(
            (c) =>
              '\n' +
              label(c) +
              '\nhttps://music.youtube.com/playlist?list=' +
              c.playlistId +
              (c.setVideoId ? '\nEntry ID: ' + c.setVideoId : '')
          )
          .join('')
    };
  }
  async function commit(g, events = []) {
    const rows = await saved(() => deps.store.saveGroup(run.id, g, events));
    tally(g);
    for (const e of rows || []) deps.onMemo?.(e);
    deps.onStats?.(stats());
  }
  async function note(text) {
    const rows = await saved(() => deps.store.append([{ runId: run?.id || '', text }]));
    for (const e of rows || []) deps.onMemo?.(e);
  }
  async function scan() {
    if (!catalog) {
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++)
        try {
          catalog = await discover();
          break;
        } catch (e) {
          if (!retryableRead(e) || attempt === MAX_READ_ATTEMPTS - 1) throw e;
          say('Finding playlists · retry ' + (attempt + 1) + '/2');
          await retryPause(attempt + 1);
        }
    }
    const sources = catalog.playlists;
    deps.onCatalog?.(catalog);
    for (const s of sources) if (!readStates.has(s.id)) readStates.set(s.id, playlistReadState());
    const total = () => [...readStates.values()].reduce((n, s) => n + s.rows.length, 0);
    for (const s of sources) {
      const state = readStates.get(s.id);
      sourceState(
        s,
        state.partial ? 'Partial' : state.complete ? 'Ready' : state.pages ? 'Waiting to resume' : 'Found',
        state.rows.length
      );
    }
    deps.onScan?.({ count: total(), playlists: sources.length });
    let queue = sources.filter((s) => !readStates.get(s.id).complete);
    for (let attempt = 0; queue.length && attempt < MAX_READ_ATTEMPTS; attempt++) {
      if (attempt) await retryPause(attempt);
      let index = 0,
        stop = null;
      const failures = [];
      await workers(Math.min(3, queue.length), async () => {
        while (index < queue.length && !stop) {
          checkpoint();
          const s = queue[index++],
            state = readStates.get(s.id);
          const progress = (count) => {
            sourceState(s, attempt ? 'Retrying ' + attempt + '/2' : 'Reading', count);
            deps.onScan?.({ count: total(), playlists: sources.length });
          };
          try {
            progress(state.rows.length);
            await readPlaylist(s.id, s.title, progress, () => !!stop, state);
            state.partial = false;
            sourceState(s, 'Ready', state.rows.length);
          } catch (e) {
            failures.push({ s, e });
            sourceState(s, 'Interrupted', state.rows.length);
            if (!retryableRead(e)) stop = e;
          }
        }
      });
      checkpoint();
      if (stop) throw stop;
      if (failures.length && attempt === MAX_READ_ATTEMPTS - 1) {
        for (const { s, e } of failures) {
          const state = readStates.get(s.id);
          state.partial = true;
          state.readError = e.message;
          sourceState(s, 'Partial', state.rows.length);
        }
        say('Continuing with the entries already read from ' + failures.length + ' partial playlists.');
        break;
      }
      queue = failures.map((f) => f.s);
    }
    return sources.map((s) => ({ ...s, ...readStates.get(s.id) }));
  }
  async function groupCopies(sources) {
    const byId = new Map();
    let entries = 0,
      overlaps = 0,
      unknown = 0;
    for (const source of sources) {
      const seen = new Map();
      for (let i = 0; i < source.rows.length; i++) {
        if (++entries % 5000 === 0) {
          checkpoint();
          await deps.delay?.(0);
        }
        const row = source.rows[i];
        if (row.setVideoId) {
          if (seen.has(row.setVideoId)) {
            if (seen.get(row.setVideoId) !== row.id)
              fail('Conflicting entry IDs in ' + source.title + '. No deletions started.');
            overlaps++;
            continue;
          }
          seen.set(row.setVideoId, row.id);
        }
        if (!validId(row.id)) {
          unknown++;
          continue;
        }
        const c = {
          playlistId: source.id,
          playlistTitle: source.title,
          setVideoId: row.setVideoId,
          key: source.id + '\n' + (row.setVideoId || '?' + (i + 1)),
          position: i + 1,
          state: 'present',
          canRemove: !!(
            row.setVideoId &&
            (source.owned || row.removableIn?.some((id) => [source.id, 'VL' + source.id].includes(id)))
          ),
          track: row
        };
        if (!byId.has(row.id)) byId.set(row.id, []);
        byId.get(row.id).push(c);
      }
    }
    const result = [];
    for (const [videoId, copies] of byId) {
      if (copies.length < 2) continue;
      const counts = new Map(),
        positions = new Map();
      for (const c of copies) counts.set(c.playlistId, (counts.get(c.playlistId) || 0) + 1);
      const track = copies.find((c) => c.track.title)?.track || copies[0].track;
      for (const c of copies) {
        positions.set(c.playlistId, (positions.get(c.playlistId) || 0) + 1);
        c.copyNumber = positions.get(c.playlistId);
        c.copiesInPlaylist = counts.get(c.playlistId);
        delete c.track;
      }
      result.push({
        index: result.length,
        videoId,
        track: { title: track.title, artists: track.artists, album: track.album, duration: track.duration },
        copies,
        status: 'waiting',
        keeperKey: null
      });
    }
    return { groups: result, entries, overlaps, unknown };
  }
  async function load() {
    const data = await saved(() => deps.store.load());
    run = data?.run || null;
    groups = data?.groups || [];
    cursor = 0;
    resetTotals();
    return run;
  }
  async function restart() {
    if (busy || inflight) fail('A deletion is still being processed.');
    checkpoint();
    await saved(() => deps.store.discard());
    run = null;
    groups = [];
    cursor = 0;
    inflight = null;
    catalog = null;
    readStates.clear();
    resetTotals();
    deps.onStats?.(stats());
  }
  async function readFresh(s) {
    const state = playlistReadState();
    let data;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++)
      try {
        data = await readPlaylist(s.id, s.title, (n) => sourceState(s, 'Checking saved copies', n), null, state);
        break;
      } catch (e) {
        if (!retryableRead(e)) throw e;
        if (attempt === MAX_READ_ATTEMPTS - 1) {
          data = { rows: state.rows, owned: state.owned, partial: true, weakEnd: true };
          break;
        }
        await retryPause(attempt + 1);
      }
    sourceState(s, data.partial ? 'Partial' : 'Ready', data.rows.length);
    const tokens = new Map();
    for (const row of data.rows)
      if (row.setVideoId) {
        if (tokens.has(row.setVideoId) && tokens.get(row.setVideoId) !== row.id) fail('Conflicting entry IDs.');
        tokens.set(row.setVideoId, row.id);
      }
    return { ...data, tokens, precise: !data.partial && !data.weakEnd && data.rows.every((r) => !!r.setVideoId) };
  }

  function presence(data, c, videoId) {
    if (!data || !c.setVideoId) return 'unknown';
    if (data.tokens.has(c.setVideoId)) return data.tokens.get(c.setVideoId) === videoId ? 'present' : 'unknown';
    return data.precise ? 'absent' : 'unknown';
  }
  async function refreshSaved() {
    const pending = groups.filter(
      (g) => !['done', 'skipped'].includes(g.status) || g.copies.some((c) => c.state === 'pending')
    );
    const ids = new Set(
      pending.flatMap((g) =>
        g.copies.filter((c) => ['present', 'pending'].includes(c.state)).map((c) => c.playlistId)
      )
    );
    const sources = run.sources.filter((s) => ids.has(s.id)),
      data = new Map();
    let at = 0;
    await workers(Math.min(3, sources.length), async () => {
      while (at < sources.length) {
        checkpoint();
        const s = sources[at++];
        try {
          data.set(s.id, await readFresh(s));
        } catch (e) {
          if (mustStop(e)) throw e;
          sourceState(s, 'Could not check', 0);
        }
      }
    });
    for (const g of pending) {
      checkpoint();
      const events = [];
      let blocked = false;
      for (const c of g.copies) {
        if (!['present', 'pending'].includes(c.state) || !c.setVideoId) continue;
        const found = presence(data.get(c.playlistId), c, g.videoId);
        if (found === 'unknown') {
          blocked = true;
          continue;
        }
        if (found === 'absent') {
          events.push(
            event(g, c.state === 'pending' ? 'Confirmed absent after interrupted deletion' : 'No longer present', [
              c
            ])
          );
          c.state = 'absent';
        } else if (c.state === 'pending') {
          c.state = 'present';
          events.push(event(g, 'Still present after interrupted deletion', [c], 'This copy can now be retried.'));
        }
        const snapshot = data.get(c.playlistId);
        if (found === 'present' && snapshot)
          c.canRemove = !!(
            snapshot.owned ||
            snapshot.rows
              .find((r) => r.setVideoId === c.setVideoId)
              ?.removableIn?.some((id) => [c.playlistId, 'VL' + c.playlistId].includes(id))
          );
      }
      const keeper = g.copies.find((c) => c.key === g.keeperKey);
      if (keeper && keeper.state !== 'present') {
        g.status = 'skipped';
        events.push(
          event(
            g,
            'Skipped — the chosen copy is no longer present',
            g.copies.filter((c) => c.state === 'present'),
            'No further copies were deleted.'
          )
        );
      } else if (blocked) {
        g.status = 'blocked';
        events.push(event(g, 'Deferred — saved copies could not be checked', [], 'Resume will try again.'));
      } else if (g.copies.filter((c) => c.state === 'present').length < 2) {
        g.status = 'done';
        events.push(
          event(
            g,
            'No duplicate copies remain',
            g.copies.filter((c) => c.state === 'present')
          )
        );
      } else g.status = g.keeperKey ? 'active' : 'waiting';
      await commit(g, events);
    }
    cursor = 0;
  }
  async function prepare() {
    checkpoint();
    await load();
    if (run && !run.complete) {
      say('Checking saved copies before resuming…');
      deps.onCatalog?.({ playlists: run.sources, complete: true });
      await refreshSaved();
      return run;
    }
    say('Reading the collection…');
    const sources = await scan(),
      built = await groupCopies(sources);
    checkpoint();
    run = {
      id: deps.newId(),
      complete: false,
      sources: sources.map((s) => ({
        id: s.id,
        title: s.title,
        number: s.number,
        roman: s.roman,
        partial: !!s.partial,
        count: s.rows.length
      })),
      entries: built.entries,
      overlaps: built.overlaps,
      unknown: built.unknown,
      partial: sources.filter((s) => s.partial).length
    };
    groups = built.groups;
    cursor = 0;
    resetTotals();
    await saved(() => deps.store.create(run, groups));
    await note(
      'Scan completed · ' +
        run.sources.length +
        ' collection playlists · ' +
        run.entries +
        ' entries · ' +
        groups.length +
        ' tracks with duplicates.' +
        (run.partial
          ? ' ' + run.partial + ' playlists are partial; only their successfully read entries were considered.'
          : '') +
        (run.unknown ? ' ' + run.unknown + ' entries without a readable video ID were excluded.' : '')
    );
    for (const s of sources)
      if (s.partial)
        await note(
          'Partial playlist — using ' +
            s.rows.length +
            ' read entries\n' +
            s.title +
            '\nhttps://music.youtube.com/playlist?list=' +
            s.id +
            '\n' +
            (s.readError || 'The remaining entries could not be read.')
        );
    readStates.clear();
    catalog = null;
    deps.onStats?.(stats());
    return run;
  }

  function next() {
    while (cursor < groups.length && !['waiting', 'active'].includes(groups[cursor].status)) cursor++;
    return groups[cursor] || null;
  }

  function stats() {
    return { ...totals };
  }

  function authorize(payload) {
    if (
      !inflight ||
      !payload ||
      Object.keys(payload).some((k) => !['playlistId', 'actions'].includes(k)) ||
      payload.playlistId !== inflight.playlistId ||
      !Array.isArray(payload.actions) ||
      payload.actions.length !== inflight.copies.length ||
      payload.actions.length > 50
    )
      return false;
    const tokens = new Set();
    return payload.actions.every((a) => {
      if (
        Object.keys(a).some((k) => !['action', 'setVideoId', 'removedVideoId'].includes(k)) ||
        a.action !== 'ACTION_REMOVE_VIDEO' ||
        a.removedVideoId !== inflight.videoId ||
        tokens.has(a.setVideoId)
      )
        return false;
      tokens.add(a.setVideoId);
      return inflight.copies.some((c) => c.setVideoId === a.setVideoId && c.key !== inflight.keeperKey);
    });
  }
  async function applyChoice(g, key) {
    if (busy) fail('A deletion is already being processed.');
    checkpoint();
    if (g !== next()) fail('That duplicate is no longer current.');
    const keeper = g.copies.find((c) => c.key === key && c.state === 'present' && c.setVideoId);
    if (!keeper || (g.keeperKey && g.keeperKey !== key)) fail('Select an identifiable copy to keep.');
    busy = true;
    try {
      if (!g.keeperKey) {
        g.keeperKey = key;
        g.status = 'active';
        await commit(g, [event(g, 'Kept — selected copy', [keeper])]);
      }
      const unsafe = g.copies.filter((c) => c.key !== key && c.state === 'present' && !c.canRemove);
      if (unsafe.length) {
        for (const c of unsafe) c.state = 'failed';
        await commit(
          g,
          unsafe.map((c) =>
            event(
              g,
              'Not removed',
              [c],
              c.setVideoId ? 'This playlist entry is not editable.' : 'The exact playlist entry ID is unavailable.'
            )
          )
        );
      }
      const targets = g.copies.filter((c) => c.key !== key && c.state === 'present' && c.canRemove),
        byPlaylist = new Map();
      for (const c of targets) {
        if (!byPlaylist.has(c.playlistId)) byPlaylist.set(c.playlistId, []);
        byPlaylist.get(c.playlistId).push(c);
      }
      for (const [playlistId, copies] of byPlaylist)
        for (let offset = 0; offset < copies.length; offset += 50) {
          checkpoint();
          const batch = copies.slice(offset, offset + 50);
          for (const c of batch) c.state = 'pending';
          await commit(g);
          inflight = { playlistId, copies: batch, videoId: g.videoId, keeperKey: key };
          const payload = {
            playlistId,
            actions: batch.map((c) => ({
              action: 'ACTION_REMOVE_VIDEO',
              setVideoId: c.setVideoId,
              removedVideoId: g.videoId
            }))
          };
          let reply, error;
          try {
            checkpoint();
            if (!authorize(payload)) throw fatal('An invalid removal was blocked.');
            reply = await deps.post('browse/edit_playlist', payload, { write: true });
          } catch (e) {
            error = e;
          } finally {
            inflight = null;
          }
          if (reply?.status === 'STATUS_SUCCEEDED') {
            for (const c of batch) c.state = 'removed';
            await commit(g, [event(g, 'Deleted', batch)]);
          } else {
            await commit(g, [
              event(
                g,
                'Deletion not confirmed',
                batch,
                error?.message || 'YouTube Music did not confirm the removal.'
              )
            ]);
            if (mustStop(error)) throw error || Object.assign(new Error('Canceled.'), { canceled: true });
            let data;
            try {
              data = await readFresh(run.sources.find((s) => s.id === playlistId));
            } catch (e) {
              if (mustStop(e)) throw e;
            }
            const events = [];
            for (const c of batch) {
              const found = presence(data, c, g.videoId);
              if (found === 'absent') {
                c.state = 'absent';
                events.push(event(g, 'Confirmed absent after interrupted deletion', [c]));
              } else if (found === 'present') {
                c.state = 'failed';
                events.push(event(g, 'Not removed — still present', [c]));
              }
            }
            if (batch.some((c) => c.state === 'pending'))
              events.push(
                event(
                  g,
                  'Unconfirmed copies deferred',
                  batch.filter((c) => c.state === 'pending'),
                  'Resume will check these copies before any retry.'
                )
              );
            await commit(g, events);
            if (keeper.playlistId === playlistId && presence(data, keeper, g.videoId) !== 'present') {
              g.status = presence(data, keeper, g.videoId) === 'absent' ? 'skipped' : 'blocked';
              await commit(g, [
                event(
                  g,
                  'Stopped this track — the chosen copy could not be verified',
                  [],
                  g.status === 'blocked'
                    ? 'Resume will check this track again.'
                    : 'No further copies were deleted.'
                )
              ]);
              return;
            }
          }
          checkpoint();
        }
      g.status = g.copies.some((c) => c.state === 'pending') ? 'blocked' : 'done';
      await commit(g);
    } finally {
      busy = false;
      inflight = null;
    }
  }
  async function skip(g, reason = 'Skipped by choice') {
    checkpoint();
    if (busy || g !== next()) fail('That duplicate is no longer current.');
    g.status = 'skipped';
    await commit(g, [
      event(
        g,
        reason,
        g.copies.filter((c) => ['present', 'pending', 'failed'].includes(c.state))
      )
    ]);
  }
  async function pause() {
    if (run && !run.complete) await note('Canceled — pending deletions stopped. Resume continues this saved run.');
  }
  async function finish() {
    run.complete = !groups.some(
      (g) => !['done', 'skipped'].includes(g.status) || g.copies.some((c) => c.state === 'pending')
    );
    await saved(() => deps.store.update(run));
    await note(
      run.complete ? 'Run completed.' : 'Run paused with unconfirmed copies. Resume checks them before continuing.'
    );
    return stats();
  }
  return {
    matchTitle,
    roman,
    musicRow,
    readPlaylist,
    discover,
    scan,
    groupCopies,
    load,
    restart,
    prepare,
    next,
    stats,
    authorize,
    applyChoice,
    skip,
    pause,
    finish,
    label,
    trackText,
    get run() {
      return run;
    },
    get groups() {
      return groups;
    },
    get hasScan() {
      return !!catalog || readStates.size > 0;
    }
  };
}

async function openDuplicatesStore(account) {
  'use strict';
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('alfredo-delete-duplicates-v1', 1);
    request.onupgradeneeded = () => {
      const d = request.result;
      d.createObjectStore('state', { keyPath: 'account' });
      const groups = d.createObjectStore('groups', { keyPath: ['account', 'runId', 'index'] });
      groups.createIndex('account', 'account');
      groups.createIndex('run', ['account', 'runId']);
      d.createObjectStore('memo', { keyPath: 'id', autoIncrement: true }).createIndex('account', 'account');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Close another older Delete Duplicates panel and reopen this one.'));
  });
  db.onversionchange = () => db.close();

  function transaction(names, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode),
        events = [];
      let value;
      tx.oncomplete = () => resolve(value === undefined ? events : value);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
      tx.onerror = () => {};
      const append = (list) => {
        for (const e of list) {
          const stored = { ...e, account };
          const req = tx.objectStore('memo').add(stored);
          req.onsuccess = () => {
            stored.id = req.result;
            events.push(stored);
          };
        }
      };
      try {
        work(tx, append, (v) => {
          value = v;
        });
      } catch (e) {
        tx.abort();
        reject(e);
      }
    });
  }
  return {
    async load() {
      return transaction(['state', 'groups'], 'readonly', (tx, append, done) => {
        const r = tx.objectStore('state').get(account);
        r.onsuccess = () => {
          if (!r.result) {
            done(null);
            return;
          }
          const q = tx.objectStore('groups').index('run').getAll([account, r.result.run.id]);
          q.onsuccess = () =>
            done({ run: r.result.run, groups: q.result.map((v) => v.group).sort((a, b) => a.index - b.index) });
        };
      });
    },
    async create(run, groups) {
      return transaction(['state', 'groups'], 'readwrite', (tx) => {
        tx.objectStore('state').put({ account, run });
        const store = tx.objectStore('groups'),
          old = store.index('account').openKeyCursor(account);
        old.onsuccess = () => {
          const c = old.result;
          if (c) {
            store.delete(c.primaryKey);
            c.continue();
          } else for (const group of groups) store.put({ account, runId: run.id, index: group.index, group });
        };
      });
    },
    async discard() {
      return transaction(['state', 'groups', 'memo'], 'readwrite', (tx) => {
        tx.objectStore('state').delete(account);
        for (const name of ['groups', 'memo']) {
          const store = tx.objectStore(name),
            old = store.index('account').openKeyCursor(account);
          old.onsuccess = () => {
            const c = old.result;
            if (c) {
              store.delete(c.primaryKey);
              c.continue();
            }
          };
        }
      });
    },
    async update(run) {
      return transaction(['state'], 'readwrite', (tx) => tx.objectStore('state').put({ account, run }));
    },
    async saveGroup(runId, group, events) {
      return transaction(['groups', 'memo'], 'readwrite', (tx, append) => {
        tx.objectStore('groups').put({ account, runId, index: group.index, group });
        append(events);
      });
    },
    async append(events) {
      return transaction(['memo'], 'readwrite', (tx, append) => append(events));
    },
    async memo() {
      return transaction(['memo'], 'readonly', (tx, append, done) => {
        const r = tx.objectStore('memo').index('account').getAll(account);
        r.onsuccess = () => done(r.result);
      });
    },
    close() {
      db.close();
    }
  };
}

async function launchMusicCollectionDuplicates(makeCore, openStore) {
  'use strict';
  const ORIGIN = 'https://music.youtube.com',
    ROOT = 'youtube-music-alfredo-duplicates-panel';
  if (location.origin !== ORIGIN) {
    alert('Open https://music.youtube.com while signed in, then click Delete Duplicates.');
    return;
  }
  if (document.getElementById(ROOT)) return;
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
    alert('Sign in to YouTube Music and reload the page, then click Delete Duplicates.');
    return;
  }
  const context = JSON.parse(JSON.stringify(original));
  context.client.clientName = 'WEB_REMIX';
  context.client.hl = 'en';

  const fatal = (message) => Object.assign(new Error(message), { fatal: true });
  let running = false,
    stopped = false,
    closed = false,
    resumeAvailable = false,
    repo,
    core,
    waiting = null,
    autoTimer = null,
    writing = false,
    current = null,
    selected = null;
  const controllers = new Set(),
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const isWrite = endpoint === 'browse/edit_playlist';
    if (
      !['browse', 'browse/edit_playlist'].includes(endpoint) ||
      isWrite !== !!options.write ||
      (isWrite && !core.authorize(payload))
    )
      throw fatal('An unsupported request was blocked.');
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
    else writing = true;
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
      if (!response.ok)
        throw Object.assign(new Error('YouTube Music returned HTTP ' + response.status + '.'), {
          httpStatus: response.status,
          fatal: [401, 403].includes(response.status)
        });
      const json = await response.json();
      checkAccount(!isWrite);
      if (json.error)
        throw Object.assign(new Error(json.error.message || 'YouTube Music rejected the request.'), {
          httpStatus: json.error.code,
          fatal: [401, 403].includes(json.error.code)
        });
      if (json.responseContext?.visitorData) context.client.visitorData = json.responseContext.visitorData;
      return json;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      if (isWrite) writing = false;
    }
  }
  const host = document.createElement('div');
  host.id = ROOT;
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:#071b20b8;display:flex;align-items:center;justify-content:center;padding:16px;';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.append(host);

  function el(tag, parent, text = '', attributes = {}) {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, v);
    if (parent) parent.append(e);
    return e;
  }
  el(
    'style',
    shadow,
    `
    :host{color-scheme:light;font:15px/1.5 system-ui,sans-serif;color:#19343a}*{box-sizing:border-box}[hidden]{display:none!important}
    .panel{width:min(940px,100%);max-height:94vh;overflow:auto;overflow-anchor:none;background:#f5f5ef;border-radius:16px;box-shadow:0 24px 80px #0006;padding:25px}
    h1{font-size:27px;letter-spacing:-.04em;line-height:1.2;margin:0}h2{font-size:18px;margin:0 0 10px}p{margin:8px 0}.muted{color:#607278;font-size:13px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px}.badge{font-size:11px;color:#6c7879}
    .modes{display:flex;gap:22px;margin:18px 0 10px;padding:0;border:0}.modes legend{font-weight:650;margin-bottom:6px}.modes label{cursor:pointer}
    button{font:650 14px system-ui;border:1px solid #b8c9bf;background:#edf5ec;color:#214b43;border-radius:7px;padding:10px 15px;cursor:pointer}button:hover{background:#dcecdf}button:disabled{opacity:.45;cursor:default}
    .primary{background:#823d32;color:#fff;border-color:#823d32}.primary:hover{background:#653027}.actions{display:flex;gap:8px;flex-wrap:wrap}.status{background:#e8efe7;padding:11px 13px;border-radius:7px;margin:14px 0 8px;white-space:pre-wrap}
    .stats{font-size:13px;color:#48625c;min-height:20px;margin-bottom:12px}a{color:#246d60;text-decoration:underline;text-underline-offset:2px}a:hover{color:#153f39}input{accent-color:#286b5b}input[type=radio]{margin-right:7px}
    .card{border:1px solid #ccd6ca;background:white;border-radius:10px;padding:19px;margin:16px 0}.track{font-size:20px;line-height:1.3;font-weight:650;margin:5px 0}.copies{margin:15px 0;display:grid;gap:8px}.copy{display:flex;align-items:flex-start;border:1px solid #d3ddd2;border-radius:7px;padding:11px;gap:6px}.copy:has(input:checked){background:#ecf5e9;border-color:#477f66}.copy input{margin-top:5px}.copy strong{font-weight:600}.copy small{display:block;color:#64716b}.copy.dim{opacity:.65}.copy label{display:block;cursor:pointer}
    details{border-top:1px solid #cfd8cf;padding-top:12px;margin-top:15px}summary{cursor:pointer;font-weight:650}.sources{max-height:200px;overflow:auto;overflow-anchor:none;margin-top:9px}.source{display:flex;justify-content:space-between;gap:18px;padding:5px 0;font-size:13px}.source span{white-space:nowrap;color:#63756d}
    .memo{height:260px;overflow:auto;overflow-anchor:none;resize:vertical;background:#fff;border:1px solid #ccd5cb;border-radius:8px;margin:10px 0;padding:0 14px}.memo pre{font:12px/1.55 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border-bottom:1px solid #e3e8e0;padding:12px 0;margin:0}.memo-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #409884;outline-offset:3px}
    @media(max-width:600px){.panel{padding:18px}.source{display:block}.source span{display:block}.modes{gap:12px}.copy{padding:8px}}
  `
  );
  const panel = el('section', shadow, '', {
    class: 'panel',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Delete Duplicates'
  });
  const top = el('div', panel, '', { class: 'top' });
  el('h1', top, 'Delete Duplicates');
  el('span', top, 'YouTube Music · 1.0.3', { class: 'badge' });
  el('p', panel, 'Keep one copy of each repeated track in the Alfredo collection.', { class: 'muted' });
  const modes = el('fieldset', panel, '', { class: 'modes' });
  el('legend', modes, 'Mode');
  const manualLabel = el('label', modes);
  const manual = el('input', manualLabel, '', {
    type: 'radio',
    name: 'duplicate-mode',
    value: 'manual',
    id: 'mode-manual'
  });
  manual.checked = true;
  manualLabel.append(document.createTextNode('Manual'));
  const automaticLabel = el('label', modes);
  const automatic = el('input', automaticLabel, '', {
    type: 'radio',
    name: 'duplicate-mode',
    value: 'automatic',
    id: 'mode-automatic'
  });
  automaticLabel.append(document.createTextNode('Automatic'));
  el(
    'p',
    panel,
    'Automatic keeps the first copy in Roman playlist order, then track order. Mode changes apply before the next duplicate.',
    { class: 'muted' }
  );
  const controls = el('div', panel, '', { class: 'actions' }),
    start = el('button', controls, 'Find duplicates', { id: 'start', type: 'button', class: 'primary' }),
    restart = el('button', controls, 'Restart', { id: 'restart', type: 'button' }),
    cancel = el('button', controls, 'Cancel', { id: 'cancel', type: 'button' }),
    close = el('button', controls, 'Close', { type: 'button' });
  start.disabled = true;
  restart.disabled = true;
  cancel.disabled = true;
  const status = el('div', panel, 'Preparing saved progress…', {
      class: 'status',
      role: 'status',
      'aria-live': 'polite'
    }),
    summary = el('div', panel, '', { class: 'stats' });
  const card = el('section', panel, '', { class: 'card', id: 'duplicate-card' });
  card.hidden = true;
  const trackCount = el('div', card, '', { class: 'muted' }),
    title = el('a', card, '', { class: 'track', target: '_blank', rel: 'noopener noreferrer' }),
    metadata = el('p', card, '', { class: 'muted' }),
    copyList = el('div', card, '', { class: 'copies' });
  const groupActions = el('div', card, '', { class: 'actions' }),
    keep = el('button', groupActions, 'Keep selected copy and delete others', {
      id: 'keep',
      type: 'button',
      class: 'primary'
    }),
    skip = el('button', groupActions, 'Skip this track', { id: 'skip', type: 'button' });
  const sourceDetails = el('details', panel);
  const sourceHeading = el('summary', sourceDetails, 'Collection playlists'),
    sourceList = el('div', sourceDetails, '', { class: 'sources' }),
    sourceRows = new Map();
  const memoSection = el('section', panel, '', { class: 'card' });
  el('h2', memoSection, 'Memo');
  el('p', memoSection, 'First actions appear at the top. New actions are appended without scrolling.', {
    class: 'muted'
  });
  const memo = el('div', memoSection, '', { class: 'memo', tabindex: '0', 'aria-label': 'Action memo' }),
    memoTools = el('div', memoSection, '', { class: 'memo-tools' });
  const copyMemo = el('button', memoTools, 'Copy memo', { type: 'button' }),
    downloadMemo = el('button', memoTools, 'Download memo', { type: 'button' }),
    moreMemo = el('button', memoTools, 'Show next 500 actions', { type: 'button' }),
    memoCount = el('span', memoTools, '', { class: 'muted' });
  const memoResult = el('p', memoSection, '', { class: 'muted', role: 'status' }),
    memoEvents = [],
    memoSeen = new Set();
  let memoRendered = 0,
    memoLimit = 500,
    memoField = null;

  function renderMemo() {
    const old = memo.scrollTop;
    while (memoRendered < Math.min(memoEvents.length, memoLimit)) {
      const e = memoEvents[memoRendered++];
      el('pre', memo, memoRendered + '. ' + e.text);
    }
    memo.scrollTop = old;
    moreMemo.hidden = memoRendered >= memoEvents.length;
    memoCount.textContent =
      memoEvents.length + ' actions' + (memoRendered < memoEvents.length ? ' · ' + memoRendered + ' shown' : '');
  }

  function appendMemo(e) {
    if (memoSeen.has(e.id)) return;
    memoSeen.add(e.id);
    memoEvents.push(e);
    renderMemo();
  }

  function clearMemo() {
    memoEvents.length = 0;
    memoSeen.clear();
    memoRendered = 0;
    memoLimit = 500;
    memo.replaceChildren();
    memo.scrollTop = 0;
    memoField?.remove();
    memoField = null;
    memoResult.textContent = '';
    renderMemo();
  }
  moreMemo.addEventListener('click', () => {
    memoLimit += 500;
    renderMemo();
  });

  function memoText() {
    return memoEvents.map((e, i) => i + 1 + '. ' + e.text).join('\n\n');
  }
  copyMemo.addEventListener('click', async () => {
    memoField?.remove();
    memoField = null;
    try {
      await navigator.clipboard.writeText(memoText());
      memoResult.textContent = 'Memo copied.';
    } catch {
      const field = (memoField = el('textarea', memoSection));
      field.value = memoText();
      field.focus();
      field.select();
      if (document.execCommand('copy')) {
        field.remove();
        memoField = null;
        memoResult.textContent = 'Memo copied.';
      } else memoResult.textContent = 'Memo selected below. Press Ctrl+C to copy.';
    }
  });
  downloadMemo.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([memoText()], { type: 'text/plain;charset=utf-8' })),
      a = el('a', memoSection, '', { href: url, download: 'Delete-Duplicates-Memo.txt' });
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  el(
    'p',
    panel,
    'Duplicates mean identical YouTube video IDs. Copy numbers and positions refer to the scan. Keep the collection unchanged in other tabs or tools during this run.',
    { class: 'muted' }
  );
  el(
    'p',
    panel,
    'Cancel stops pending deletions; a request already sent may finish. Resume and the memo are saved in Firefox for this YouTube Music account.',
    { class: 'muted' }
  );
  el(
    'p',
    panel,
    'Restart empties the memo and discards the unfinished run and cached scan, then scans afresh in the selected mode. Completed deletions remain in effect.',
    { class: 'muted' }
  );

  function catalogView(catalog) {
    sourceHeading.textContent = 'Collection playlists (' + catalog.playlists.length + ')';
    for (const s of catalog.playlists) {
      if (sourceRows.has(s.id)) {
        sourceList.append(sourceRows.get(s.id).parentElement);
        continue;
      }
      const row = el('div', sourceList, '', { class: 'source' });
      el('a', row, s.title, {
        href: ORIGIN + '/playlist?list=' + s.id,
        target: '_blank',
        rel: 'noopener noreferrer'
      });
      sourceRows.set(
        s.id,
        el(
          'span',
          row,
          Number.isInteger(s.count)
            ? (s.partial ? 'Partial' : 'Ready') + ' · ' + s.count.toLocaleString() + ' entries'
            : 'Found'
        )
      );
    }
    if (catalog.complete) {
      const ids = new Set(catalog.playlists.map((s) => s.id));
      for (const [id, field] of sourceRows)
        if (!ids.has(id)) {
          field.parentElement.remove();
          sourceRows.delete(id);
        }
    }
  }

  function statsView(s) {
    summary.textContent =
      s.finished +
      ' / ' +
      s.groups +
      ' duplicate tracks handled · ' +
      s.removed +
      ' confirmed removals' +
      (s.absent ? ' · ' + s.absent + ' absent on recheck' : '') +
      (s.pending ? ' · ' + s.pending + ' unconfirmed' : '') +
      (core?.run?.partial ? ' · ' + core.run.partial + ' partial playlists' : '');
  }

  function clearAuto() {
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = null;
  }
  let radios = [];

  function scheduleAuto() {
    clearAuto();
    if (!automatic.checked || !waiting || stopped) return;
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (!automatic.checked || !waiting || stopped) return;
      const first = current.keeperKey
        ? current.copies.find((c) => c.key === current.keeperKey)
        : current.copies.find((c) => c.state === 'present');
      const radio = radios.find((r) => r.key === first?.key)?.input;
      // Both modes use these same radio change and button click handlers.
      if (radio && !radio.disabled) {
        radio.click();
        keep.click();
      } else skip.click();
    }, 0);
  }

  function modeChanged() {
    const canResume = resumeAvailable || (core?.run && !core.run.complete);
    if (!running)
      start.textContent = canResume
        ? 'Resume'
        : automatic.checked
          ? 'Find and delete duplicates'
          : 'Find duplicates';
    restart.disabled = running || start.disabled || !canResume;
    scheduleAuto();
  }
  manual.addEventListener('change', modeChanged);
  automatic.addEventListener('change', modeChanged);

  function present(g) {
    current = g;
    selected = g.keeperKey || null;
    radios = [];
    copyList.replaceChildren();
    card.hidden = false;
    trackCount.textContent =
      'Duplicate ' +
      (g.index + 1) +
      ' of ' +
      core.stats().groups +
      ' · ' +
      g.copies.length +
      ' copies in the scan';
    title.textContent = g.track.title || '(Untitled track)';
    title.href = ORIGIN + '/watch?v=' + g.videoId;
    metadata.textContent = [
      g.track.artists?.map((a) => a.name).join(', ') || 'Artist unavailable',
      g.track.album?.name,
      g.track.duration,
      g.videoId
    ]
      .filter(Boolean)
      .join(' · ');
    for (const c of g.copies) {
      const row = el('div', copyList, '', { class: 'copy' + (c.state === 'present' ? '' : ' dim') });
      const input = el('input', row, '', {
        type: 'radio',
        name: 'keep-copy',
        id: 'copy-' + g.index + '-' + radios.length
      });
      input.disabled = c.state !== 'present' || !c.setVideoId || (!!g.keeperKey && c.key !== g.keeperKey);
      input.checked = c.key === selected;
      const content = el('div', row),
        label = el('label', content, '', { for: input.id });
      el('strong', label, core.label(c));
      el('a', content, 'Open playlist', {
        href: ORIGIN + '/playlist?list=' + c.playlistId,
        target: '_blank',
        rel: 'noopener noreferrer'
      });
      el(
        'small',
        content,
        c.state !== 'present'
          ? c.state === 'removed'
            ? 'Deleted'
            : c.state === 'absent'
              ? 'No longer present'
              : c.state === 'failed'
                ? 'Not removed'
                : 'Unconfirmed'
          : !c.setVideoId
            ? 'Exact copy cannot be identified'
            : !c.canRemove
              ? 'Read only — this copy cannot be deleted'
              : g.keeperKey === c.key
                ? 'Saved copy to keep'
                : ''
      );
      input.addEventListener('change', () => {
        if (input.checked && !input.disabled) {
          selected = c.key;
          keep.disabled = false;
        }
      });
      radios.push({ key: c.key, input });
    }
    keep.disabled = !selected;
    skip.disabled = false;
    keep.textContent = g.keeperKey ? 'Continue remaining deletions' : 'Keep selected copy and delete others';
    status.textContent = automatic.checked
      ? 'Automatic mode is processing duplicates.'
      : 'Select the copy to keep, then click the deletion button.';
    return new Promise((resolve) => {
      waiting = resolve;
      scheduleAuto();
    });
  }

  function decide(value) {
    if (!waiting) return;
    clearAuto();
    const resolve = waiting;
    waiting = null;
    keep.disabled = true;
    skip.disabled = true;
    for (const r of radios) r.input.disabled = true;
    resolve(value);
  }
  keep.addEventListener('click', () => {
    if (!keep.disabled && selected) decide({ kind: 'keep', key: selected });
  });
  skip.addEventListener('click', () => {
    if (!skip.disabled) decide({ kind: 'skip' });
  });
  cancel.addEventListener('click', () => {
    if (!running) return;
    stopped = true;
    clearAuto();
    for (const c of controllers) c.abort();
    decide({ kind: 'cancel' });
    cancel.disabled = true;
    status.textContent = writing
      ? 'Canceling pending deletions. Waiting for the request already sent…'
      : 'Canceling pending deletions…';
  });
  close.addEventListener('click', () => {
    if (running) return;
    closed = true;
    clearAuto();
    repo?.close();
    host.remove();
  });
  async function execute(fresh = false) {
    if (running || !core || (fresh && restart.disabled)) return;
    if (!navigator.locks?.request) {
      status.textContent =
        'This Firefox session does not provide Web Locks. Enable normal site storage and reopen the tool.';
      return;
    }
    running = true;
    stopped = false;
    start.disabled = true;
    restart.disabled = true;
    cancel.disabled = false;
    close.disabled = true;
    card.hidden = true;
    try {
      await navigator.locks.request(
        'alfredo-delete-duplicates:' + account,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            status.textContent =
              'Delete Duplicates is already running in another tab. Cancel or finish that run first.';
            return;
          }
          checkAccount();
          for (const e of await repo.memo()) appendMemo(e);
          if (fresh) {
            checkAccount();
            await core.restart();
            clearMemo();
            resumeAvailable = false;
            current = null;
            selected = null;
            radios = [];
            copyList.replaceChildren();
          }
          if ((!core.run || core.run.complete) && !core.hasScan) {
            sourceRows.clear();
            sourceList.replaceChildren();
            sourceHeading.textContent = 'Collection playlists';
            summary.textContent = '';
          }
          await core.prepare();
          statsView(core.stats());
          for (let g = core.next(); g; g = core.next()) {
            checkAccount();
            const decision = await present(g);
            checkAccount();
            if (decision.kind === 'keep') {
              status.textContent = 'Removing the other copies…';
              await core.applyChoice(g, decision.key);
            } else if (decision.kind === 'skip') await core.skip(g, 'Skipped — no further copies removed');
          }
          checkAccount();
          await core.finish();
          card.hidden = true;
          resumeAvailable = !core.run.complete;
          status.textContent = core.run.complete
            ? core.run.partial
              ? 'Completed using the entries read. ' +
                core.run.partial +
                ' playlists were partial; unread entries were untouched.'
              : core.stats().groups
                ? 'Completed. The memo lists each result.'
                : 'No duplicate tracks were found.'
            : 'Some copies could not be confirmed. Resume will check them again.';
        }
      );
    } catch (e) {
      resumeAvailable = true;
      if (stopped || e.canceled) {
        try {
          await core.pause();
        } catch (storageError) {
          status.textContent = storageError.message;
          return;
        }
        status.textContent = 'Canceled. Pending deletions stopped. Click Resume to continue.';
      } else status.textContent = (e.message || String(e)) + ' Saved progress can be resumed.';
    } finally {
      running = false;
      start.disabled = false;
      cancel.disabled = true;
      close.disabled = false;
      clearAuto();
      waiting = null;
      if (stopped) resumeAvailable = true;
      modeChanged();
    }
  }
  start.addEventListener('click', () => execute());
  restart.addEventListener('click', () => execute(true));
  try {
    repo = await openStore(account);
    if (closed) {
      repo.close();
      return;
    }
    core = makeCore({
      store: repo,
      post,
      delay,
      cancelled: () => stopped,
      newId: () => crypto.randomUUID(),
      progress: (m) => {
        status.textContent = m;
      },
      onCatalog: catalogView,
      onPlaylist: (s, v) => {
        if (!sourceRows.has(s.id)) catalogView({ playlists: core?.run?.sources || [s] });
        const field = sourceRows.get(s.id);
        if (field) field.textContent = v.state + ' · ' + v.count.toLocaleString() + ' entries';
      },
      onScan: (v) => {
        summary.textContent =
          v.playlists + ' collection playlists · ' + v.count.toLocaleString() + ' entries read';
      },
      onMemo: appendMemo,
      onStats: statsView
    });
    for (const e of await repo.memo()) appendMemo(e);
    await core.load();
    if (core.run && !core.run.complete) {
      catalogView({ playlists: core.run.sources });
      statsView(core.stats());
      status.textContent =
        'An unfinished run is saved. Resume checks its copies before continuing; Restart discards it and scans afresh.';
    } else status.textContent = 'Choose a mode, then start the collection scan.';
    start.disabled = false;
    modeChanged();
  } catch (e) {
    status.textContent = 'Saved progress is unavailable. ' + (e.message || String(e));
    start.disabled = true;
    restart.disabled = true;
  }
}

launchMusicCollectionDuplicates(makeCollectionDuplicatesCore, openDuplicatesStore);
