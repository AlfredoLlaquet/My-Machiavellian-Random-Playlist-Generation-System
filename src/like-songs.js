/* Like songs 2.0.0 — random playlist workflow, 1.2-second pacing, and full-playlist refresh. */
function makeLikesResumePolicy(now) {
  'use strict';
  now = now || (() => Date.now());
  const STEP = 30000;
  let delay = STEP,
    resuming = false,
    recovered = false,
    first = null,
    last = null,
    events = 0,
    mark = 0;
  const position = (s) => (s.pages || 0) + (s.inspected || 0) + (s.accepted || 0);
  return {
    begin(automatic, stats) {
      resuming = automatic;
      recovered = false;
      first = last = null;
      events = 0;
      mark = position(stats);
    },
    progress(stats) {
      const next = position(stats);
      if (!resuming || recovered || next <= mark) return;
      mark = next;
      const time = now();
      // A long request or a waiting period alone is not a successful recovery.
      if (last === null || time - last > STEP) {
        first = time;
        events = 0;
      }
      last = time;
      events++;
      if (events >= 3 && time - first >= STEP) recovered = true;
    },
    wait(error) {
      if (resuming && !recovered) delay += STEP;
      if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > delay)
        delay = Math.ceil(error.retryAfterMs / STEP) * STEP;
      return delay;
    },
    get delay() {
      return delay;
    }
  };
}

function makeCollectionLikesCore(deps) {
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
  const library = { records: new Map(), seen: new Set(), next: null, targetId: null, pages: 0, complete: false };

  function catalogSnapshot() {
    const playlists = [];
    for (const record of library.records.values()) {
      const match = matchTitle(record.title);
      if (match) playlists.push({ ...record, ...match });
    }
    playlists.sort((a, b) => a.number - b.number || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return { complete: library.complete, playlists, scanned: library.records.size };
  }
  async function discover() {
    while (!library.complete && library.pages < 1000) {
      checkpoint();
      const next = library.next;
      const json = !next
        ? await deps.post('browse', { browseId: 'FEmusic_liked_playlists' })
        : next.mode === 'query'
          ? await deps.post('browse', { browseId: 'FEmusic_liked_playlists' }, { continuation: next.token })
          : await deps.post('browse', { continuation: next.token });
      checkpoint();
      checkReadResponse(json);
      let scope,
        targetId = library.targetId;
      if (!next) {
        scope = libraryScope(json);
        targetId = scope.targetId || null;
      } else {
        const legacy =
          json.continuationContents?.gridContinuation || json.continuationContents?.musicShelfContinuation;
        if (legacy) scope = legacy;
        else {
          const actions = [
            ...find(json.onResponseReceivedActions, 'appendContinuationItemsAction'),
            ...find(json.onResponseReceivedEndpoints, 'appendContinuationItemsAction'),
            ...find(json.onResponseReceivedCommands, 'appendContinuationItemsAction')
          ];
          const unique = [
            ...new Map(actions.map((a) => [JSON.stringify([a.targetId, a.continuationItems]), a])).values()
          ];
          let matches = unique.filter((a) => targetId && a.targetId === targetId);
          if (!matches.length)
            matches = unique.filter((a) => (!a.targetId || !targetId) && Array.isArray(a.continuationItems));
          if (matches.length !== 1)
            fail('The next library page could not be identified. Resume will retry that page.');
          scope = { items: matches[0].continuationItems };
          targetId = matches[0].targetId || targetId;
        }
      }
      const items = scope.items || scope.contents;
      if (!Array.isArray(items)) fail('The library page could not be read.');
      const records = items.map(libraryCard).filter(Boolean),
        following = nextPage(scope, items);
      if (following && library.seen.has(following.token)) fail('YouTube Music repeated a library page.');
      for (const r of records)
        if (library.records.has(r.id) && library.records.get(r.id).title !== r.title)
          throw Object.assign(new Error('A collection playlist title changed. Restart the scan.'), {
            retryable: false
          });
      for (const r of records) library.records.set(r.id, r);
      if (following) library.seen.add(following.token);
      Object.assign(library, { next: following, targetId, pages: library.pages + 1, complete: !following });
      const catalog = catalogSnapshot();
      deps.onCatalog?.(catalog);
      say(
        'Finding playlists: ' +
          catalog.scanned.toLocaleString() +
          ' inspected · ' +
          catalog.playlists.length.toLocaleString() +
          ' matches'
      );
    }
    if (!library.complete) fail('Playlist discovery did not finish.');
    return catalogSnapshot();
  }
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
  const validToken = (id) =>
    typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\x00-\x20\x7f]/.test(id);
  const NEUTRAL = 1,
    LIKED = 2,
    DISLIKED = 4,
    UNKNOWN = 8,
    AVAILABLE = 16;
  const ratingBits = { INDIFFERENT: NEUTRAL, LIKE: LIKED, DISLIKE: DISLIKED };

  function ratingOf(r, id) {
    const values = [];
    const top = r.menu?.menuRenderer?.topLevelButtons;
    for (const b of find(top, 'likeButtonRenderer')) {
      const targets = [b.target, ...find(b, 'likeEndpoint').map((e) => e.target)].filter(Boolean);
      if (targets.some((t) => t.playlistId || (t.videoId && t.videoId !== id)) || b.isDisabled === true) {
        values.push(UNKNOWN);
        continue;
      }
      values.push(ratingBits[b.likeStatus] || UNKNOWN);
    }
    // Some layouts use a separate pair of toggles. One inactive Like button
    // alone does not establish that the track is not disliked.
    const toggles = new Map();
    for (const b of find(top, 'toggleButtonRenderer')) {
      const endpoint = b.defaultServiceEndpoint?.likeEndpoint;
      if (
        endpoint?.target?.videoId === id &&
        ['LIKE', 'DISLIKE'].includes(endpoint.status) &&
        typeof b.isToggled === 'boolean'
      )
        toggles.set(endpoint.status, b.isToggled);
    }
    if (toggles.size === 2)
      values.push(
        toggles.get('LIKE') && toggles.get('DISLIKE')
          ? UNKNOWN
          : toggles.get('LIKE')
            ? LIKED
            : toggles.get('DISLIKE')
              ? DISLIKED
              : NEUTRAL
      );
    else if (toggles.get('DISLIKE')) values.push(DISLIKED);
    else if (toggles.get('LIKE')) values.push(LIKED);
    return values.length ? values.reduce((a, b) => a | b, 0) : UNKNOWN;
  }

  function likeCommand(r, id) {
    const top = r.menu?.menuRenderer?.topLevelButtons;
    for (const button of find(top, 'likeButtonRenderer')) {
      if (button.likesAllowed === false || button.isDisabled === true) continue;
      for (const command of button.serviceEndpoints || []) {
        const e = command.likeEndpoint;
        if (e?.status === 'LIKE' && e.target?.videoId === id && !e.target.playlistId) return command;
      }
    }
    for (const button of find(top, 'toggleButtonRenderer')) {
      const command = button.defaultServiceEndpoint,
        e = command?.likeEndpoint;
      if (e?.status === 'LIKE' && e.target?.videoId === id && !e.target.playlistId) return command;
    }
    return null;
  }

  function musicRow(r) {
    const play = r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer;
    const columns = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text);
    const edits = find(r.menu, 'playlistEditEndpoint').flatMap((e) =>
      (e.actions || [])
        .filter((a) => a.action === 'ACTION_REMOVE_VIDEO')
        .map((a) => ({ ...a, playlistId: e.playlistId }))
    );
    const original = [
      ...new Set([r.playlistItemData?.videoId, ...edits.map((a) => a.removedVideoId)].filter(validId))
    ];
    const watch = columns.flatMap((c) =>
      (c?.runs || []).map((run) => run.navigationEndpoint?.watchEndpoint?.videoId).filter(validId)
    );
    const id =
      original.length === 1
        ? original[0]
        : original.length > 1
          ? ''
          : play?.playNavigationEndpoint?.watchEndpoint?.videoId ||
            r.navigationEndpoint?.watchEndpoint?.videoId ||
            watch[0] ||
            '';
    const title = textOf(columns[0] || r.title).trim();
    const available =
      validId(id) &&
      r.isPlayable !== false &&
      r.isAvailable !== false &&
      r.musicItemRendererDisplayPolicy !== 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT' &&
      play?.playabilityStatus !== 'PLAYABILITY_STATUS_UNPLAYABLE' &&
      !/^(\[?)(private video|deleted video|unavailable video|song deleted|song unavailable)(\]?)$/i.test(title);
    const ownEdits = edits.filter((a) => a.removedVideoId === id);
    const tokens = [
      ...new Set([r.playlistItemData?.playlistSetVideoId, ...ownEdits.map((a) => a.setVideoId)].filter(validToken))
    ];
    return {
      id,
      mask: ratingOf(r, id) | (available ? AVAILABLE : 0),
      command: likeCommand(r, id),
      setVideoId: tokens.length === 1 ? tokens[0] : null,
      removableIn: ownEdits.map((a) => a.playlistId).filter(Boolean)
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
        fail('A collection entry could not be read. The remaining entries on this page were not processed.');
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
    count: 0,
    seen: new Set(),
    next: null,
    targetId: null,
    pages: 0,
    complete: false,
    owned: false,
    declared: null,
    weakEnd: false
  });
  async function readPlaylist(
    id,
    label = 'Reading source',
    onPage,
    halt,
    state = playlistReadState(),
    consume = () => {}
  ) {
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
          e.message = label + ' · ' + state.count.toLocaleString() + ' entries: ' + e.message;
          throw e;
        }
      }
      const parsed = unpack(scope);
      if (parsed.next && state.seen.has(parsed.next.token))
        fail('YouTube Music repeated a playlist page. The scan is incomplete.');
      // Commit only a fully validated page. A retry requests the failed page again.
      consume(parsed.rows, { id, next: next ? { ...next } : null, targetId });
      state.count += parsed.rows.length;
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
      if (onPage) onPage(state.count);
      else say(label + ': ' + state.count.toLocaleString() + ' entries');
    }
    if (!state.complete) fail('The playlist did not finish loading. Nothing further was changed.');
    // Pagination determines completion; the header may include omitted entries.
    return { count: state.count, weakEnd: state.weakEnd };
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

  const sources = new Map(),
    activeCommands = new Map();
  const now = deps.now || (() => Date.now()),
    random = deps.random || Math.random;
  let catalog = null,
    order = [],
    at = 0,
    current = null,
    phase = 'ready',
    busy = false,
    nextLikeAt = 0,
    passAccepted = 0;
  const counts = {
    entries: 0,
    pages: 0,
    sent: 0,
    accepted: 0,
    errors: 0,
    processed: 0,
    refreshed: 0,
    pass: 0,
    readErrors: 0
  };

  function category(mask) {
    if (mask & DISLIKED) return 'disliked';
    if (mask & LIKED) return 'liked';
    if (!(mask & AVAILABLE)) return 'unavailable';
    return (mask & 15) === NEUTRAL ? 'unrated' : 'unknown';
  }

  function eligible(row) {
    const e = row?.command?.likeEndpoint;
    return (
      !!row &&
      category(row.mask) === 'unrated' &&
      e?.status === 'LIKE' &&
      e.target?.videoId === row.id &&
      !e.target.playlistId
    );
  }

  function sourceStats(s) {
    return {
      state: s.state,
      count: s.readCount,
      summary: s.summary,
      processed: s.processed,
      total: s.total,
      errors: s.errors,
      working: current?.source === s
    };
  }

  function stats() {
    const totals = {
      unrated: 0,
      eligible: 0,
      liked: 0,
      disliked: 0,
      unknown: 0,
      unavailable: 0,
      missingCommand: 0
    };
    let read = 0;
    for (const s of sources.values())
      if (s.summary) {
        read++;
        for (const key of Object.keys(totals)) totals[key] += s.summary[key];
      }
    return {
      ...counts,
      ...totals,
      phase,
      playlists: catalog?.playlists.length || 0,
      read,
      inspected: library.records.size,
      currentTitle: current?.source.record.title || '',
      currentEntries: current?.read.count || 0,
      remaining: current?.kind === 'like' ? current.queue.length - current.cursor : 0,
      currentTotal: current?.kind === 'like' ? current.queue.length : 0,
      currentProcessed: current?.kind === 'like' ? current.cursor : 0
    };
  }

  function emit() {
    if (current) deps.onPlaylist?.(current.source.record, sourceStats(current.source));
    deps.onStats?.(stats());
  }

  function publish(s) {
    deps.onPlaylist?.(s.record, sourceStats(s));
    deps.onStats?.(stats());
  }

  function shuffled(list) {
    const result = [...list];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function beginPass(list) {
    order = shuffled(list);
    at = 0;
    counts.pass++;
    passAccepted = counts.accepted;
    phase = 'scan';
    emit();
  }

  function beginRead(source, kind) {
    current = { source, kind, read: playlistReadState(), rows: new Map(), invalid: 0, queue: [], cursor: 0 };
    source.readCount = 0;
    source.state = kind === 'refresh' ? 'Refreshing' : 'Reading';
    phase = kind;
    emit();
  }

  function absorb(rows) {
    for (const row of rows) {
      counts.entries++;
      if (!validId(row.id)) {
        current.invalid++;
        continue;
      }
      const previous = current.rows.get(row.id);
      if (previous) {
        previous.mask |= row.mask;
        if (!previous.command) previous.command = row.command;
      } else current.rows.set(row.id, { id: row.id, mask: row.mask, command: row.command });
    }
  }

  function summarize() {
    const summary = {
      entries: current.read.count,
      unique: current.rows.size,
      invalid: current.invalid,
      unrated: 0,
      eligible: 0,
      liked: 0,
      disliked: 0,
      unknown: 0,
      unavailable: 0,
      missingCommand: 0
    };
    for (const row of current.rows.values()) {
      const kind = category(row.mask);
      summary[kind]++;
      if (eligible(row)) summary.eligible++;
      else if (kind === 'unrated') summary.missingCommand++;
    }
    return summary;
  }
  async function discoverCollection() {
    phase = 'discover';
    emit();
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++)
      try {
        catalog = await discover();
        break;
      } catch (e) {
        if (!retryableRead(e) || e.httpStatus === 429 || e.offline || attempt === MAX_READ_ATTEMPTS - 1) throw e;
        say('Retrying playlist discovery from the saved page…');
        await retryPause(attempt + 1);
      }
    for (const record of catalog.playlists)
      sources.set(record.id, {
        record,
        state: 'Found',
        readCount: 0,
        summary: null,
        processed: 0,
        total: 0,
        errors: 0,
        needsRetry: false
      });
    deps.onCatalog?.(catalog);
    beginPass([...sources.values()]);
  }
  async function readCurrent() {
    const s = current.source,
      refresh = current.kind === 'refresh';
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++)
      try {
        checkpoint();
        if (attempt) await retryPause(attempt);
        s.state = attempt ? 'Retrying ' + attempt + '/2' : refresh ? 'Refreshing' : 'Reading';
        emit();
        await readPlaylist(
          s.record.id,
          s.record.title,
          () => {
            counts.pages++;
            s.readCount = current.read.count;
            emit();
            say(
              (refresh ? 'Refreshing ' : 'Reading ') +
                s.record.title +
                ' · ' +
                s.readCount.toLocaleString() +
                ' entries'
            );
          },
          null,
          current.read,
          absorb
        );
        s.summary = summarize();
        s.needsRetry = false;
        s.state = refresh ? 'Refreshed' : 'Read';
        if (refresh) {
          counts.refreshed++;
          current = null;
          publish(s);
          return;
        }
        current.queue = [...current.rows.values()].filter(eligible);
        s.total = current.queue.length;
        s.processed = 0;
        if (!current.queue.length) {
          current = null;
          publish(s);
          return;
        }
        current.kind = 'like';
        phase = 'like';
        s.state = 'Liking';
        emit();
        return;
      } catch (e) {
        if (!retryableRead(e) || e.httpStatus === 429 || e.offline) {
          s.state = 'Paused';
          emit();
          throw e;
        }
        if (attempt === MAX_READ_ATTEMPTS - 1) {
          counts.readErrors++;
          s.needsRetry = true;
          s.state = 'Read interrupted · retry later';
          deps.onIssue?.(
            s.record.title + ': the full playlist could not be read. It will be retried after the other playlists.'
          );
          current = null;
          publish(s);
          return;
        }
      }
  }

  function authorizeNative(id, command) {
    return activeCommands.get(id) === command && eligible(current?.rows.get(id));
  }
  async function likeCurrent() {
    const work = current,
      s = work.source;
    say('Liking unrated songs in ' + s.record.title + ' · about one request every 1.2 seconds');
    while (work.cursor < work.queue.length) {
      checkpoint();
      const wait = nextLikeAt - now();
      if (wait > 0) await retryPause(wait / 1000);
      checkpoint();
      const row = work.queue[work.cursor];
      nextLikeAt = now() + 1200;
      activeCommands.set(row.id, row.command);
      work.cursor++;
      counts.sent++;
      s.processed = work.cursor;
      emit();
      try {
        await deps.like(row.id, row.command);
        counts.accepted++;
      } catch (e) {
        if (e.unsent) {
          work.cursor--;
          counts.sent--;
          s.processed = work.cursor;
        }
        if (!e.canceled) {
          counts.errors++;
          s.errors++;
        }
        if (
          mustStop(e) ||
          e.unsent ||
          e.httpStatus === 429 ||
          e.httpStatus >= 500 ||
          e.offline ||
          e.timeout ||
          (!e.definite && !e.httpStatus)
        ) {
          s.state = 'Paused';
          throw e;
        }
        deps.onIssue?.(
          'Some Like requests were rejected. Processing continues; playlist counts will be refreshed afterward.'
        );
      } finally {
        activeCommands.delete(row.id);
        emit();
      }
    }
    counts.processed++;
    beginRead(s, 'refresh');
  }
  async function run() {
    if (busy) fail('Like songs is already running.');
    if (phase === 'done') return stats();
    busy = true;
    try {
      checkpoint();
      if (!catalog) await discoverCollection();
      while (true) {
        checkpoint();
        if (!current) {
          if (at >= order.length) {
            const remaining = [...sources.values()].filter(
              (s) => s.needsRetry || !s.summary || s.summary.eligible > 0
            );
            if (!remaining.length) {
              phase = 'done';
              emit();
              say('No eligible unrated songs remain in the scanned collection.');
              return stats();
            }
            const stalled = counts.accepted === passAccepted;
            beginPass(remaining);
            if (stalled)
              throw new Error(
                'Remaining playlists still need another read or contain rejected requests. Retrying after a pause.'
              );
          }
          beginRead(order[at++], 'scan');
        }
        if (current.kind === 'like') {
          phase = 'like';
          current.source.state = 'Liking';
          await likeCurrent();
        } else {
          phase = current.kind;
          await readCurrent();
        }
      }
    } finally {
      busy = false;
      activeCommands.clear();
    }
  }
  return {
    run,
    stats,
    authorizeNative,
    musicRow,
    ratingOf,
    likeCommand,
    matchTitle,
    roman,
    discover,
    readPlaylist,
    playlistReadState,
    playlistStats: () => [...sources.values()].map((s) => ({ ...s.record, ...sourceStats(s) })),
    get phase() {
      return phase;
    },
    get trackedCount() {
      return current?.rows.size || 0;
    }
  };
}

async function launchMusicCollectionLikes(makeCore, makeResumePolicy) {
  'use strict';
  const ORIGIN = 'https://music.youtube.com',
    ROOT = 'youtube-music-alfredo-like-songs-panel';
  if (location.origin !== ORIGIN) {
    alert('Open https://music.youtube.com while signed in, then click the ♥ bookmark.');
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
    alert('Sign in to YouTube Music and reload the page, then click ♥.');
    return;
  }
  const context = JSON.parse(JSON.stringify(original));
  context.client.clientName = 'WEB_REMIX';
  context.client.hl = 'en';
  let running = false,
    stopped = false,
    closed = false,
    core,
    waiting = null,
    retryTimer = null,
    activityTimer = null,
    automaticResumes = 0;
  let resumePolicy = makeResumePolicy();
  const requestWaits = new Set(),
    requests = { started: 0, finished: 0, active: 0, writes: 0 };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function checkAccount(honorCancel = true) {
    if (identity() !== account || cfg('LOGGED_IN') === false)
      throw Object.assign(new Error('The selected YouTube Music account changed. Close and reopen the tool.'), {
        fatal: true
      });
    if (honorCancel && stopped) throw Object.assign(new Error('Canceled.'), { canceled: true });
  }

  function boundedRequest(label, work, abort = () => {}) {
    checkAccount();
    return new Promise((resolve, reject) => {
      let ended = false,
        timer;
      const entry = {
        label,
        started: Date.now(),
        cancel: () => finish(Object.assign(new Error('Canceled.'), { canceled: true }))
      };

      function finish(error, value) {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        requestWaits.delete(entry);
        if (error) {
          try {
            abort();
          } catch {}
          reject(error);
        } else resolve(value);
        activityView();
      }
      const check = () => {
        if (ended) throw Object.assign(new Error('This request is no longer active.'), { canceled: true });
        checkAccount();
      };
      requestWaits.add(entry);
      timer = setTimeout(
        () =>
          finish(Object.assign(new Error('No response while ' + label + ' for 30 seconds.'), { timeout: true })),
        30000
      );
      Promise.resolve()
        .then(() => {
          check();
          return work(check);
        })
        .then(
          (value) => finish(null, value),
          (error) =>
            finish(error && typeof error === 'object' ? error : new Error(String(error || 'The request failed.')))
        );
      activityView();
    });
  }
  const cookie = (name) =>
    document.cookie
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(name + '='))
      ?.slice(name.length + 1);
  async function auth() {
    const sid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (!sid)
      throw Object.assign(new Error('The current sign-in could not be used. Sign in and reload YouTube Music.'), {
        fatal: true
      });
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
    let sent = false,
      controller;
    try {
      return await boundedRequest(
        core?.phase === 'refresh' ? 'refreshing the playlist' : 'reading playlists',
        async (check) => {
          if (endpoint !== 'browse' || options.write)
            throw Object.assign(new Error('An unsupported request was blocked.'), { fatal: true });
          checkAccount();
          if (navigator.onLine === false)
            throw Object.assign(new Error('The browser is offline.'), { offline: true, unsent: true });
          const authorization = await auth();
          check();
          const headers = {
            'Content-Type': 'application/json',
            'Authorization': authorization,
            'X-Origin': ORIGIN,
            'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
            'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 67),
            'X-Youtube-Client-Version': context.client.clientVersion
          };
          if (cfg('DELEGATED_SESSION_ID')) headers['X-Goog-PageId'] = cfg('DELEGATED_SESSION_ID');
          if (context.client.visitorData) headers['X-Goog-Visitor-Id'] = context.client.visitorData;
          const key = cfg('INNERTUBE_API_KEY'),
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
            (key ? '&key=' + encodeURIComponent(key) : '') +
            query;
          check();
          controller = new AbortController();
          sent = true;
          requests.started++;
          requests.active++;
          activityView();
          const response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'error',
            cache: 'no-store',
            headers,
            body: JSON.stringify({ context, ...payload }),
            signal: controller.signal
          });
          check();
          if (!response.ok) {
            const retryAfter = response.headers?.get?.('Retry-After'),
              seconds = Number(retryAfter);
            const retryAfterMs = retryAfter
              ? Number.isFinite(seconds)
                ? seconds * 1000
                : Math.max(0, Date.parse(retryAfter) - Date.now())
              : 0;
            throw Object.assign(new Error('YouTube Music returned HTTP ' + response.status + '.'), {
              httpStatus: response.status,
              fatal: [401, 403].includes(response.status),
              retryAfterMs
            });
          }
          const json = await response.json();
          check();
          if (json?.error)
            throw Object.assign(new Error(json.error.message || 'YouTube Music rejected the request.'), {
              httpStatus: json.error.code,
              definite: true,
              fatal: [401, 403].includes(json.error.code)
            });
          if (json?.responseContext?.mainAppWebResponseContext?.loggedOut === true)
            throw Object.assign(new Error('The account is signed out.'), { fatal: true, httpStatus: 401 });
          if (json?.responseContext?.visitorData) context.client.visitorData = json.responseContext.visitorData;
          return json;
        },
        () => controller?.abort()
      );
    } catch (e) {
      e.sent = sent;
      if (!sent) e.unsent = true;
      throw e;
    } finally {
      if (sent) {
        requests.active--;
        requests.finished++;
        activityView();
      }
    }
  }
  async function nativeLike(id, command) {
    let sent = false;
    try {
      return await boundedRequest('waiting for a Like response', async (check) => {
        check();
        if (navigator.onLine === false)
          throw Object.assign(new Error('The browser is offline.'), { offline: true });
        if (!core.authorizeNative(id, command))
          throw Object.assign(new Error('An invalid native Like command was blocked.'), { fatal: true });
        const app = document.querySelector('ytmusic-app');
        if (!app)
          throw Object.assign(new Error('The YouTube Music app is not ready. Reload Music and reopen the tool.'), {
            fatal: true
          });
        // This is the site's own Like-button service request, including the
        // original endpoint, tracking, and params. Native code supplies auth.
        const detail = {
          actionName: 'yt-service-request',
          optionalAction: false,
          args: [app, command],
          returnValue: []
        };
        sent = true;
        requests.started++;
        requests.active++;
        requests.writes++;
        activityView();
        app.dispatchEvent(
          new CustomEvent('yt-action', { bubbles: true, cancelable: false, composed: true, detail })
        );
        if (!detail.returnValue.length)
          throw Object.assign(
            new Error('YouTube Music did not handle its native Like command. Reload Music and reopen the tool.'),
            { fatal: true, unsent: true }
          );
        const promise = detail.returnValue.find((r) => r?.ajaxPromise)?.ajaxPromise;
        if (promise) {
          const reply = await Promise.resolve(promise);
          check();
          const error = reply?.data?.error || reply?.error;
          if (error)
            throw Object.assign(new Error(error.message || 'YouTube Music rejected the native Like command.'), {
              httpStatus: error.code,
              definite: true,
              fatal: [401, 403].includes(error.code)
            });
          if ((reply?.data || reply)?.responseContext?.mainAppWebResponseContext?.loggedOut === true)
            throw Object.assign(new Error('The account is signed out.'), { fatal: true, httpStatus: 401 });
        }
        // A handled command or resolved promise is never proof of a saved like.
        check();
      });
    } catch (e) {
      if (!sent) e.unsent = true;
      throw e;
    } finally {
      if (sent) {
        requests.active--;
        requests.finished++;
        requests.writes--;
        activityView();
      }
    }
  }
  const host = document.createElement('div');
  host.id = ROOT;
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:#071b20b8;display:flex;align-items:center;justify-content:center;padding:14px';
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
    :host{color-scheme:light;font:14px/1.5 system-ui,sans-serif;color:#203937}*{box-sizing:border-box}[hidden]{display:none!important}
    .panel{width:min(920px,100%);max-height:95vh;display:flex;flex-direction:column;overflow:hidden;background:#f5f5ef;border:1px solid #fff9;border-radius:17px;box-shadow:0 24px 80px #0006}
    .fixed{flex:none;padding:23px 25px 14px}.top{display:flex;align-items:center;justify-content:space-between;gap:18px}h1{font-size:28px;line-height:1.15;letter-spacing:-.04em;margin:0}.heart{color:#a13e57;margin-right:8px}.badge{font-size:11px;color:#6b7d73}p{margin:8px 0}.muted{font-size:12px;color:#5d746b}
    .actions{display:flex;flex-wrap:wrap;gap:8px;margin:15px 0 12px}button{font:650 13px system-ui;padding:9px 16px;border:1px solid #b5c8bc;border-radius:7px;background:#eaf2e7;color:#2d5949;cursor:pointer}button:hover{background:#dcebdc}button:disabled{opacity:.45;cursor:default}.primary{background:#235e4e;color:#fff;border-color:#235e4e}.primary:hover{background:#174f40}
    .stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px}.metric{background:#fff;border:1px solid #dce3d7;border-radius:9px;padding:11px 13px}.metric strong{display:block;font-size:25px;line-height:1.2;font-variant-numeric:tabular-nums;letter-spacing:-.04em}.metric span{display:block;font-size:11px;margin-top:4px;color:#5d7366}.metric.accent{background:#e4efdf;border-color:#bed1b8}.metric.accent strong{color:#275b41}
    .counts{font-size:12px;color:#536e5e;margin:9px 0;line-height:1.65;font-variant-numeric:tabular-nums}.status{font-weight:600;font-size:13px;min-height:20px}.activity{display:flex;align-items:center;gap:9px;font-size:11px;color:#66796e;min-height:22px;font-variant-numeric:tabular-nums}.pulse{width:8px;height:8px;background:#3d8965;border-radius:50%;animation:beat 1s ease-in-out infinite}@keyframes beat{50%{opacity:.2;transform:scale(.7)}}@media(prefers-reduced-motion:reduce){.pulse{animation:none}}
    progress{display:block;accent-color:#397656;width:100%;height:6px;margin:8px 0}
    .body{min-height:0;overflow:auto;overflow-anchor:none;border-top:1px solid #d8e1d4;padding:14px 25px 21px}details{margin:8px 0}summary{cursor:pointer;font-weight:650}.source{display:grid;grid-template-columns:1fr 1.5fr;gap:18px;padding:8px 6px;border-bottom:1px solid #e3e9dd;font-size:12px}.source[data-pending="true"]{background:#e8f0e1}.source span{color:#607467;white-space:normal}.source[data-pending="true"] span{color:#275b41}a{color:#276952;text-underline-offset:2px}.issue{font-size:12px;color:#835d26;background:#faf0dc;padding:9px 12px;border-radius:7px;overflow-wrap:anywhere}button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #448e75;outline-offset:3px}
    @media(max-width:600px){.fixed{padding:16px 16px 10px}.body{padding:10px 16px 16px}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.metric{padding:7px 10px}.metric strong{font-size:22px}.source{display:block}.source span{display:block}.counts{font-size:11px}h1{font-size:24px}}
  `
  );
  const panel = el('section', shadow, '', {
      class: 'panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Like songs'
    }),
    fixed = el('div', panel, '', { class: 'fixed' });
  const top = el('div', fixed, '', { class: 'top' }),
    heading = el('h1', top);
  el('span', heading, '♥', { class: 'heart' });
  heading.append(document.createTextNode('Like songs'));
  el('span', top, 'YouTube Music · 2.0.0', { class: 'badge' });
  el(
    'p',
    fixed,
    'Random playlist order · about one Like request every 1.2 seconds · a full rescan after each processed playlist.',
    { class: 'muted' }
  );
  const actions = el('div', fixed, '', { class: 'actions' }),
    start = el('button', actions, 'Start', { id: 'start', type: 'button', class: 'primary' }),
    restart = el('button', actions, 'Restart', { id: 'restart', type: 'button' }),
    cancel = el('button', actions, 'Cancel', { id: 'cancel', type: 'button' }),
    close = el('button', actions, 'Close', { id: 'close', type: 'button' });
  const grid = el('div', fixed, '', { class: 'stats' }),
    fields = {};
  for (const [key, label, accent] of [
    ['sent', 'Like requests sent', true],
    ['errors', 'Request errors'],
    ['remaining', 'Current playlist · remaining'],
    ['read', 'Playlists read'],
    ['entries', 'Entries read · includes rescans'],
    ['eligible', 'Eligible · latest scans'],
    ['unrated', 'Unrated · latest scans'],
    ['liked', 'Liked · latest scans'],
    ['disliked', 'Disliked · latest scans'],
    ['refreshed', 'Playlists refreshed']
  ]) {
    const metric = el('div', grid, '', { class: 'metric' + (accent ? ' accent' : '') });
    fields[key] = el('strong', metric, '0', { id: 'count-' + key });
    el('span', metric, label);
  }
  const currentLabel = el('div', fixed, '', { class: 'counts', id: 'current-playlist' }),
    counts = el('div', fixed, '', { class: 'counts', id: 'other-counts' });
  const progress = el('progress', fixed, '', { max: '1', value: '0', 'aria-label': 'Current playlist progress' });
  const status = el('div', fixed, 'Ready. Press Start to begin.', {
    class: 'status',
    role: 'status',
    'aria-live': 'polite'
  });
  const recovery = el('div', fixed, '', { class: 'counts', id: 'recovery-status', 'aria-live': 'off' });
  const activity = el('div', fixed, '', { class: 'activity' }),
    pulse = el('span', activity, '', { class: 'pulse', 'aria-hidden': 'true' }),
    requestsText = el('span', activity, '0 requests completed · 0 active');
  const body = el('div', panel, '', { class: 'body' }),
    issue = el('p', body, '', { class: 'issue', role: 'status' });
  issue.hidden = true;
  el(
    'p',
    body,
    'Requests sent are not confirmed likes. Liked, disliked, and unrated counts reflect the latest complete scan of each playlist. No individual like is verified.',
    { class: 'muted' }
  );
  const details = el('details', body, '', { open: '' }),
    sourceHeading = el('summary', details, 'Collection playlists (0)'),
    sourceList = el('div', details),
    sourceRows = new Map();
  el(
    'p',
    body,
    'Playlists are read in random order. When one has eligible unrated songs, its full scan finishes before liking begins. Its data is refreshed by another full scan after those requests finish, then processing continues with the next playlist.',
    { class: 'muted' }
  );
  el(
    'p',
    body,
    'Already liked, disliked, unavailable, and unreadable ratings are skipped. Repeated copies within the current playlist receive one request per pass. Playlists that still contain eligible songs are revisited in a new random order until none remain or Cancel is pressed.',
    { class: 'muted' }
  );
  el(
    'p',
    body,
    'Cancel stops pending work. Resume continues with the current playlist and position in memory. Restart clears the run and starts a new random order. Temporary interruptions retry after 30 seconds, increasing the delay when needed. Request waits end after 30 seconds.',
    { class: 'muted' }
  );

  function activityView() {
    const request = requestWaits.values().next().value;
    requestsText.textContent =
      requests.finished.toLocaleString() +
      ' / ' +
      requests.started.toLocaleString() +
      ' requests completed · ' +
      requests.active +
      ' active' +
      (request
        ? ' · ' +
          request.label +
          ' · ' +
          Math.max(0, Math.floor((Date.now() - request.started) / 1000)) +
          ' seconds'
        : '');
    pulse.hidden = !running;
  }

  function activityTick() {
    activityTimer = null;
    if (!running || closed) return;
    activityView();
    activityTimer = setTimeout(activityTick, 1000);
  }

  function statsView(s) {
    resumePolicy.progress(s);
    for (const key of Object.keys(fields))
      fields[key].textContent =
        key === 'read' ? s.read.toLocaleString() + ' / ' + s.playlists.toLocaleString() : s[key].toLocaleString();
    currentLabel.textContent = s.currentTitle
      ? (s.phase === 'refresh' ? 'Refreshing: ' : s.phase === 'like' ? 'Liking: ' : 'Reading: ') +
        s.currentTitle +
        ' · ' +
        s.currentEntries.toLocaleString() +
        ' entries'
      : 'No playlist active';
    counts.textContent =
      'Random pass ' +
      s.pass +
      ' · ' +
      s.processed.toLocaleString() +
      ' playlist liking rounds completed · ' +
      s.pages.toLocaleString() +
      ' pages read · ' +
      s.unknown.toLocaleString() +
      ' unknown ratings · ' +
      s.unavailable.toLocaleString() +
      ' unavailable · ' +
      s.missingCommand.toLocaleString() +
      ' unrated without a Like command · ' +
      s.readErrors +
      ' interrupted scans';
    if (s.phase === 'like') {
      progress.max = Math.max(1, s.currentTotal);
      progress.value = s.currentProcessed;
    } else {
      progress.max = Math.max(1, s.playlists);
      progress.value = s.read;
    }
  }

  function catalogView(c) {
    sourceHeading.textContent =
      'Collection playlists (' +
      c.playlists.length.toLocaleString() +
      ') · ' +
      c.scanned.toLocaleString() +
      ' inspected';
    for (const s of c.playlists) {
      if (sourceRows.has(s.id)) {
        sourceList.append(sourceRows.get(s.id).row);
        continue;
      }
      const row = el('div', sourceList, '', { class: 'source' });
      el('a', row, s.title, {
        href: ORIGIN + '/playlist?list=' + s.id,
        target: '_blank',
        rel: 'noopener noreferrer'
      });
      sourceRows.set(s.id, { row, label: el('span', row, 'Found') });
    }
  }

  function make() {
    core = makeCore({
      post,
      like: nativeLike,
      delay,
      cancelled: () => stopped,
      progress: (m) => {
        status.textContent = m;
      },
      onCatalog: catalogView,
      onStats: statsView,
      onPlaylist: (s, v) => {
        const field = sourceRows.get(s.id);
        if (field) {
          field.row.setAttribute('data-pending', String(v.working));
          field.label.textContent =
            v.state +
            ' · ' +
            v.count.toLocaleString() +
            ' entries' +
            (v.summary
              ? ' · ' +
                v.summary.eligible.toLocaleString() +
                ' eligible · ' +
                v.summary.unrated.toLocaleString() +
                ' unrated · ' +
                v.summary.liked.toLocaleString() +
                ' liked'
              : '') +
            (v.state === 'Liking'
              ? ' · ' + v.processed.toLocaleString() + ' / ' + v.total.toLocaleString() + ' requests processed'
              : '') +
            (v.errors ? ' · ' + v.errors + ' request errors' : '');
        }
      },
      onIssue: (m) => {
        issue.textContent = m;
        issue.hidden = false;
      }
    });
    statsView(core.stats());
  }

  function controls() {
    const done = core.phase === 'done';
    start.textContent = done ? 'Finished' : waiting ? 'Resume now' : core.phase === 'ready' ? 'Start' : 'Resume';
    start.disabled = running || done;
    restart.disabled = running || (core.phase === 'ready' && !waiting);
    cancel.disabled = !running && !waiting;
    close.disabled = running;
    activityView();
  }

  function clearRetry() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    waiting = null;
  }

  function recoveryView() {
    const seconds = waiting ? Math.max(0, Math.ceil((waiting.due - Date.now()) / 1000)) : 0;
    recovery.textContent =
      'Automatic resume delay: ' +
      resumePolicy.delay / 1000 +
      ' seconds · ' +
      automaticResumes +
      ' automatic resumes' +
      (waiting ? ' · resuming in ' + seconds + ' second' + (seconds === 1 ? '' : 's') : '');
  }

  function canResume(error) {
    return (
      !stopped &&
      !closed &&
      !error.canceled &&
      !error.fatal &&
      error.retryable !== false &&
      ![401, 403].includes(error.httpStatus) &&
      !/account changed|sign.in|signed out|log.?in|not a bot|captcha|unusual traffic|permission|forbidden|unauthori[sz]ed/i.test(
        error.message || ''
      )
    );
  }

  function scheduleRetry(error) {
    const ms = resumePolicy.wait(error);
    waiting = { due: Date.now() + ms };
    status.textContent =
      (error.message || 'The run was interrupted.') + ' Automatic resume is scheduled; progress is retained.';
    const tick = () => {
      retryTimer = null;
      if (!waiting || stopped || closed) return;
      recoveryView();
      if (Date.now() >= waiting.due) {
        waiting = null;
        controls();
        execute(false, true);
        return;
      }
      retryTimer = setTimeout(tick, Math.min(1000, Math.max(1, waiting.due - Date.now())));
    };
    controls();
    tick();
  }
  async function execute(fresh = false, automatic = false) {
    if (closed || running || (fresh && restart.disabled) || (!fresh && start.disabled)) return;
    const retrying = automatic || !!waiting;
    clearRetry();
    running = true;
    stopped = false;
    controls();
    activityTick();
    resumePolicy.begin(retrying && !fresh, core.stats());
    if (automatic) automaticResumes++;
    recoveryView();
    let retryError = null;
    try {
      checkAccount();
      if (fresh) {
        resumePolicy = makeResumePolicy();
        automaticResumes = 0;
        sourceRows.clear();
        sourceList.replaceChildren();
        sourceHeading.textContent = 'Collection playlists (0)';
        issue.textContent = '';
        issue.hidden = true;
        Object.assign(requests, { started: 0, finished: 0, active: 0, writes: 0 });
        make();
        resumePolicy.begin(false, core.stats());
        recoveryView();
      }
      const s = await core.run();
      status.textContent =
        'Finished. No eligible unrated songs remain in the scanned collection. ' +
        s.sent.toLocaleString() +
        ' Like requests sent · ' +
        s.errors.toLocaleString() +
        ' request errors.';
    } catch (e) {
      status.textContent =
        stopped || e.canceled
          ? 'Canceled. Resume continues from the current position.'
          : (e.message || String(e)) + ' Resume keeps the current playlist and position.';
      if (canResume(e)) retryError = e;
    } finally {
      running = false;
      clearTimeout(activityTimer);
      activityTimer = null;
      controls();
      if (retryError) scheduleRetry(retryError);
      else recoveryView();
    }
  }
  start.addEventListener('click', () => execute());
  restart.addEventListener('click', () => execute(true));
  cancel.addEventListener('click', () => {
    if (cancel.disabled) return;
    stopped = true;
    clearRetry();
    for (const entry of [...requestWaits]) entry.cancel();
    controls();
    cancel.disabled = true;
    recoveryView();
    status.textContent = running
      ? 'Canceling. A request already sent may still finish.'
      : 'Canceled. Resume continues from the current position.';
  });
  close.addEventListener('click', () => {
    if (!running) {
      closed = true;
      stopped = true;
      clearRetry();
      host.remove();
    }
  });
  make();
  controls();
  recoveryView();
}

launchMusicCollectionLikes(makeCollectionLikesCore, makeLikesResumePolicy);
