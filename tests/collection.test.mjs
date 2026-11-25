import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

// Run the real bookmarklet's wrong-origin guard, then exercise its real core
// through the same dependency boundary used by the browser launcher.
function factory(file, name) {
  const path = new URL('../src/' + file + '.js', import.meta.url);
  return runInNewContext(readFileSync(path, 'utf8') + '\n;' + name, {
    URL, location: {origin: 'https://example.invalid'}, alert() {},
  }, {filename: path.pathname});
}

const importer = factory('add-songs', 'makeCollectionImporterCore');
const artists = factory('list-artists', 'makeCollectionArtistsCore');
const duplicates = factory('delete-duplicates', 'makeCollectionDuplicatesCore');
const likes = factory('like-songs', 'makeCollectionLikesCore');
const video = n => 'v' + String(n).padStart(10, '0');
const channel = char => 'UC' + char.repeat(22);
const artist = {name: 'The "Quartet"', id: channel('A')};
const artistInput = '"The ""Quartet"""';
const albumId = 'MPRE_quartet';

function library(playlists) {
  return {contents: {gridRenderer: {items: playlists.map(({id, title}) => ({
    gridPlaylistRenderer: {playlistId: id, title: {simpleText: title}},
  }))}}};
}

function track(id, setVideoId) {
  return {musicResponsiveListItemRenderer: {playlistItemData: {videoId: id, playlistSetVideoId: setVideoId}}};
}

function playlistPage({id, rows, owned = true, count = rows.length}) {
  return {
    header: {
      musicResponsiveHeaderRenderer: {secondSubtitle: {simpleText: count + ' songs'}},
      ...(owned && {musicEditablePlaylistDetailHeaderRenderer: {playlistId: id}}),
    },
    contents: {musicPlaylistShelfRenderer: {playlistId: id, contents: rows}},
  };
}

function browseLink(id) {
  return {navigationEndpoint: {browseEndpoint: {browseId: id}}};
}

function typedBrowseLink(id, pageType = 'MUSIC_PAGE_TYPE_ARTIST') {
  return {navigationEndpoint: {browseEndpoint: {browseId: id,
    browseEndpointContextSupportedConfigs: {browseEndpointContextMusicConfig: {pageType}},
  }}};
}

function creditedTrack(n, name, id) {
  const row = track(video(n));
  const credit = id ? {text: name, ...typedBrowseLink(id)} : {text: name};
  row.musicResponsiveListItemRenderer.flexColumns = [[{text: 'Track ' + n}], [credit]].map(runs => ({
    musicResponsiveListItemFlexColumnRenderer: {text: {runs}},
  }));
  return row;
}

function albumPage(owner, rows = []) {
  return {
    header: {musicResponsiveHeaderRenderer: {
      straplineTextOne: {runs: [{text: owner.name, ...(owner.id ? browseLink(owner.id) : {})}]},
    }},
    contents: {musicShelfRenderer: {contents: rows}},
  };
}

function artistProfilePage({id, name, subscriptionId = id, tracks}, releaseId) {
  const header = {musicImmersiveHeaderRenderer: {
    title: {runs: [{text: name}]},
    subscriptionButton: {subscribeButtonRenderer: {channelId: subscriptionId}},
  }};
  const contents = tracks?.length ? [{musicCarouselShelfRenderer: {
    header: {musicCarouselShelfBasicHeaderRenderer: {title: {simpleText: 'Albums'}}},
    contents: [{musicTwoRowItemRenderer: {title: {simpleText: 'Album'}, ...browseLink(releaseId)}}],
  }}] : [];
  return {header, contents: {sectionListRenderer: {contents}}};
}

function importerFixture(editableCount, {
  profiles = [{...artist, tracks: [1, 2, 2]}],
  responses = new Map(),
  savedChoices = [],
  loseAddReply = false,
  interruptFirstAdd = false,
} = {}) {
  const playlists = [
    {id: 'PLone', title: "Alfredo's__I__", owned: false, rows: [track(video(1))]},
    {id: 'PLtwo', title: "Alfredo's__II__", count: 4501, rows: []},
    {id: 'PLthree', title: "Alfredo's__III__", count: editableCount, rows: []},
  ];
  const writes = [], reads = [], searches = [], artistEvents = [];
  const pages = new Map();
  for (const profile of profiles) {
    const releaseId = 'MPRE_' + profile.id;
    pages.set(profile.id, artistProfilePage(profile, releaseId));
    pages.set(releaseId, albumPage(profile, (profile.tracks || []).map(n => track(video(n)))));
  }
  for (const [id, response] of responses) pages.set(id, response);
  let pending = null;
  const open = () => importer({
    savePending(value) { pending = structuredClone(value); },
    loadPending() { return structuredClone(pending); },
    saveChoices(value) { savedChoices = structuredClone(value); },
    loadChoices() { return structuredClone(savedChoices); },
    onArtist(input, value, kind = 'name') { artistEvents.push({input, ...structuredClone(value), kind}); },
    async post(endpoint, body, options = {}) {
      if (options.write) {
        assert.equal(options.permit.id, pending.id);
        assert.equal(options.permit.title, pending.title);
        writes.push([endpoint, structuredClone(body)]);
        if (endpoint === 'playlist/create') {
          playlists.push({id: 'PLnew', title: body.title, rows: [], count: 0});
          return {playlistId: 'PLnew'};
        }
        assert.equal(endpoint, 'browse/edit_playlist');
        const destination = playlists.find(p => p.id === body.playlistId);
        for (const action of body.actions) {
          assert.equal(action.action, 'ACTION_ADD_VIDEO');
          destination.rows.push(track(action.addedVideoId));
          destination.count++;
          if (interruptFirstAdd) {
            interruptFirstAdd = false;
            throw Object.assign(new Error('Session ended during the first addition.'), {fatal: true});
          }
        }
        if (loseAddReply) {
          loseAddReply = false;
          throw new Error('The server committed the addition before the connection closed.');
        }
        return {status: 'STATUS_SUCCEEDED'};
      }
      if (endpoint === 'search') {
        searches.push(body.query);
        const matches = profiles.filter(p => p.searchable !== false && p.name.toLowerCase() === body.query.toLowerCase());
        const cards = matches.map(p => ({title: {simpleText: p.name}, ...browseLink(p.id)}));
        if (cards.length === 1) return {contents: {musicCardShelfRenderer: cards[0]}};
        return {contents: {musicShelfRenderer: {contents: cards.map(card => ({musicTwoRowItemRenderer: card}))}}};
      }
      assert.equal(endpoint, 'browse');
      reads.push(body.browseId);
      if (body.browseId === 'FEmusic_liked_playlists') return library(playlists);
      if (pages.has(body.browseId)) {
        const response = pages.get(body.browseId);
        if (response instanceof Error) throw response;
        return response;
      }
      const list = playlists.find(p => body.browseId === 'VL' + p.id);
      assert.ok(list, 'Unexpected browse request: ' + body.browseId);
      return playlistPage(list);
    },
  });
  return {core: open(), reopen: open, playlists, writes, reads, searches, artistEvents,
    get choices() { return savedChoices; }, get pending() { return pending; }};
}

test('Add Songs counts duplicates across read-only sources and fills a destination with exactly 500 free slots', async () => {
  const {core, playlists, writes} = importerFixture(4500);
  const result = await core.run(artistInput);
  assert.equal(result.found, 2);
  assert.equal(result.existing, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(writes, [['browse/edit_playlist', {
    playlistId: 'PLthree', actions: [{action: 'ACTION_ADD_VIDEO', addedVideoId: video(2)}],
  }]]);
  assert.equal(playlists[2].count, 4501);
  const repeated = await core.run(artistInput);
  assert.equal(repeated.existing, 2);
  assert.equal(repeated.added, 0);
  assert.equal(writes.length, 1);
});

test('Add Songs creates the next private numbered playlist when all eligible destinations lack room', async () => {
  const {core, writes} = importerFixture(4501);
  const result = await core.run(artistInput);
  assert.equal(result.created, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(writes.map(([endpoint]) => endpoint), ['playlist/create', 'browse/edit_playlist']);
  assert.equal(writes[0][1].title, "Alfredo's __IV__");
  assert.equal(writes[0][1].privacyStatus, 'PRIVATE');
  assert.equal(writes[1][1].playlistId, 'PLnew');
});

test('Add Songs reconciles a committed addition after a lost reply without appending it twice', async () => {
  const {core, playlists, writes} = importerFixture(4500, {loseAddReply: true});
  const result = await core.run(artistInput);
  assert.equal(result.added, 1);
  assert.equal(playlists[2].rows.length, 1);
  assert.equal(writes.length, 1);
});

test('Add Songs browses exact case-sensitive IDs once and keeps same-name artists distinct', async () => {
  const upper = 'UC' + 'Aa0_-'.repeat(4) + 'ZQ', lower = upper.replace('Aa', 'aa');
  const profiles = [upper, lower].map((id, i) => ({id, name: 'The Mirrors', tracks: [i + 10]}));
  const f = importerFixture(100, {profiles});
  const result = await f.core.run('  ' + upper + ' ,\r\n' + lower + '\n' + upper);
  assert.equal(result.requested, 2);
  assert.equal(result.matched, 2);
  assert.equal(result.pendingChoices, 0);
  assert.equal(result.added, 2);
  assert.deepEqual(f.searches, []);
  for (const {id, name} of profiles) {
    assert.equal(f.reads.filter(read => read === id).length, 1);
    assert.ok(f.artistEvents.some(e => e.input === id && e.kind === 'channelId' && e.artist?.name === name));
  }
});

test('Add Songs keeps names literal through CSV quoting, case folding and ID-shaped exceptions', async () => {
  const id = channel('C');
  const names = ['Café, "Live"', 'UC Jazz', id.slice(0, -1), channel('L').toLowerCase(), id];
  const profiles = names.map((name, i) => ({id: channel(String(i)), name}));
  profiles.push({id, name: 'Numbered Profile'});
  const f = importerFixture(100, {profiles});
  const result = await f.core.run([
    '"Café, ""Live"""', '"cafe\u0301, ""live"""', names[1], names[2],
    names[3], '"' + id + '"', id,
  ].join(',\r\n'));
  assert.deepEqual(f.searches, names);
  assert.equal(result.requested, 6);
  assert.equal(result.matched, 6);
  assert.equal(result.pendingChoices, 0);
  assert.deepEqual(new Set(f.artistEvents.filter(e => e.input === id).map(e => e.kind)),
    new Set(['name', 'channelId']));
});

test('Add Songs catches an unclosed quoted entry before any search, scan or write', async () => {
  const f = importerFixture(100);
  await assert.rejects(f.core.run(channel('A') + ', "Unfinished'), /quot/i);
  assert.deepEqual([f.reads, f.searches, f.writes], [[], [], []]);
});

test('Add Songs combines the release routes of an artist named by both name and ID in either order', async () => {
  const name = 'Shared Artist', direct = channel('D');
  const profiles = [
    {name, id: channel('R'), subscriptionId: direct, tracks: [20, 21]},
    {name, id: direct, searchable: false, tracks: [21, 22]},
  ];
  for (const entries of [[name, direct], [direct, name]]) {
    const f = importerFixture(100, {profiles});
    const result = await f.core.run(entries.join('\n'));
    assert.deepEqual(f.searches, [name]);
    assert.equal(result.requested, 2);
    assert.equal(result.matched, 1);
    assert.equal(result.found, 3);
    assert.equal(result.added, 3);
    assert.deepEqual(f.writes.flatMap(([, body]) => body.actions.map(a => a.addedVideoId)).sort(),
      [video(20), video(21), video(22)]);
  }
});

test('A later channel ID can join two earlier profile groups through verified subscription IDs', async () => {
  const profiles = [
    {id: channel('A'), subscriptionId: channel('D'), name: 'First route', tracks: [15]},
    {id: channel('B'), subscriptionId: channel('E'), name: 'Second route', tracks: [16]},
    {id: channel('D'), subscriptionId: channel('B'), name: 'Connecting route', tracks: [17]},
  ];
  const f = importerFixture(100, {profiles});
  const result = await f.core.run(profiles.map(p => p.id).join(','));
  assert.deepEqual(f.searches, []);
  assert.equal(result.requested, 3);
  assert.equal(result.matched, 1);
  assert.equal(result.added, 3);
});

test('Search and direct ID accept the same plain album credit when the artist header has a newer name', async () => {
  const old = {id: channel('N'), name: 'Earlier Name', tracks: [9]}, current = 'Current Name';
  const releaseId = 'MPRE_' + old.id;
  const responses = new Map([
    [old.id, artistProfilePage({...old, name: current}, releaseId)],
    [releaseId, albumPage({name: current}, [track(video(9))])],
  ]);
  for (const input of [old.name, old.id]) {
    const f = importerFixture(100, {profiles: [old], responses});
    const result = await f.core.run(input);
    assert.equal(result.matched, 1);
    assert.equal(result.added, 1);
  }
});

test('Various Artists ownership distinguishes linked credits from ambiguous or ID-shaped plain names', async () => {
  const name = 'Namesakes', a = channel('A'), b = channel('B'), c = channel('C');
  const solo = {id: channel('S'), name: 'Unique Soloist'};
  const profiles = [{id: a, name, tracks: [31]}, {id: b, name}, {id: c, name: a}, solo];
  const compilation = albumPage({name: 'Various Artists', id: channel('V')}, [
    creditedTrack(31, name, a), creditedTrack(32, name, b), creditedTrack(33, name),
    creditedTrack(34, solo.name), creditedTrack(35, a),
  ]);
  const savedChoices = [
    {input: name, decisions: [{id: a, use: false}, {id: b, use: false}]},
    {input: a, decisions: [{id: c, use: false}]},
  ];
  const f = importerFixture(100, {profiles, savedChoices, responses: new Map([['MPRE_' + a, compilation]])});
  const result = await f.core.run([name, a, '"' + a + '"', solo.id].join(','));
  assert.equal(result.matched, 2);
  assert.equal(result.pendingChoices, 0);
  assert.deepEqual(f.writes.flatMap(([, body]) => body.actions.map(action => action.addedVideoId)).sort(),
    [video(31), video(34)]);
});

test('An explicit ID applies for one run alongside a saved name exclusion and a pending choice', async () => {
  const name = 'Namesakes', a = channel('A'), b = channel('B');
  const profiles = [{id: a, name, tracks: [10]}, {id: b, name, tracks: [20]}];
  const excluded = [{input: name, decisions: [{id: a, use: false}]}];
  const f = importerFixture(100, {profiles, savedChoices: excluded});
  const result = await f.core.run(name + ', ' + a);
  assert.equal(result.matched, 1);
  assert.equal(result.pendingChoices, 1);
  assert.deepEqual(f.choices, excluded);
  assert.deepEqual(f.writes[0][1].actions.map(action => action.addedVideoId), [video(10)]);
  f.core.chooseArtist(name, b, true);
  const resumed = await f.core.resumeChoices();
  assert.equal(resumed.matched, 2);
  assert.equal(resumed.pendingChoices, 0);
  assert.deepEqual(f.writes[1][1].actions.map(action => action.addedVideoId), [video(20)]);
  const nextRun = await f.reopen().run(name);
  assert.equal(nextRun.matched, 1);
  assert.equal(nextRun.existing, 1);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.choices[0].decisions, [{id: a, use: false}, {id: b, use: true}]);
});

test('An ambiguous name supplies an additional catalog route and a later choice does not double-count it', async () => {
  const name = 'Catalog Twins', direct = channel('D'), route = channel('R'), other = channel('X');
  const f = importerFixture(100, {profiles: [
    {name, id: direct, searchable: false, tracks: [10, 11]},
    {name, id: route, subscriptionId: direct, tracks: [11, 12]},
    {name, id: other, tracks: [20]},
  ]});
  const result = await f.core.run(direct + ', ' + name);
  assert.equal(result.pendingChoices, 1);
  assert.equal(result.matched, 1);
  f.core.chooseArtist(name, route, true);
  f.core.chooseArtist(name, other, false);
  const resumed = await f.core.resumeChoices();
  assert.equal(resumed.matched, 1);
  assert.equal(resumed.found, 3);
  assert.equal(resumed.added, 3);
  assert.deepEqual(f.writes.flatMap(([, body]) => body.actions.map(action => action.addedVideoId)).sort(),
    [video(10), video(11), video(12)]);
});

test('Shared headers require evidence for their own artist and respect an explicit user-channel type', async () => {
  const id = channel('V'), unrelated = channel('U'), name = 'Visual Artist';
  const header = {musicVisualHeaderRenderer: {title: {runs: [{text: name, ...typedBrowseLink(id)}]}}};
  const catalogId = channel('R'), userId = channel('L');
  const catalogPage = (id, selfLink) => ({
    header: {musicVisualHeaderRenderer: {title: {runs: [{text: name, ...selfLink}]}}},
    contents: {sectionListRenderer: {contents: [{musicCarouselShelfRenderer: {
      header: {musicCarouselShelfBasicHeaderRenderer: {title: {runs: [{text: 'Albums', ...browseLink('MPAD' + id)}]}}},
      contents: [],
    }}]}},
  });
  const responses = new Map([[id, {header}], [unrelated, {header}], [catalogId, catalogPage(catalogId)],
    [userId, catalogPage(userId, typedBrowseLink(userId, 'MUSIC_PAGE_TYPE_USER_CHANNEL'))]]);
  const f = importerFixture(100, {responses});
  const result = await f.core.run([id, unrelated, catalogId, userId].join(','));
  assert.equal(result.matched, 2);
  assert.deepEqual(f.searches, []);
  assert.ok(f.artistEvents.some(e => e.input === id && e.artist?.name === name));
  assert.equal(result.warnings.length, 2);
  for (const rejected of [unrelated, userId]) assert.ok(result.warnings.some(w => w.includes(rejected)));
});

test('A failed ID, an ordinary Music user, a temporary error and an empty artist produce separate outcomes', async () => {
  const missing = channel('M'), user = channel('U'), temporary = channel('T');
  const empty = {name: 'Empty Artist', id: channel('E')}, good = {name: 'Good Artist', id: channel('G'), tracks: [8]};
  const userPage = {
    header: {musicVisualHeaderRenderer: {title: {simpleText: 'Listener'},
      subscriptionButton: {subscribeButtonRenderer: {channelId: user}}}},
    contents: {musicCarouselShelfRenderer: {contents: [{musicTwoRowItemRenderer: {
      title: {simpleText: good.name}, ...typedBrowseLink(good.id),
    }}]}},
  };
  const responses = new Map([
    [missing, Object.assign(new Error('HTTP 404'), {httpStatus: 404})],
    [temporary, Object.assign(new Error('HTTP 503'), {httpStatus: 503})],
    [user, userPage],
  ]);
  const f = importerFixture(100, {profiles: [empty, good], responses});
  const result = await f.core.run([missing, user, temporary, empty.id, good.id].join('\n'));
  assert.equal(result.matched, 2);
  assert.equal(result.added, 1);
  assert.deepEqual(f.searches, []);
  const warning = id => result.warnings.find(text => text.includes(id)) || '';
  assert.equal(result.warnings.length, 3);
  assert.match(warning(missing), /not found|unresolv|could not be (?:found|resolved)|404|does not exist/i);
  assert.match(warning(user), /artist (?:profile|page)|(?:not|identify) an artist/i);
  assert.match(warning(temporary), /temporar|try again|retry/i);
  assert.ok(f.artistEvents.some(e => e.input === empty.id && e.count === 0));
});

test('Cancellation and account changes during a direct lookup stop the batch before any write', async () => {
  const stop = channel('S'), good = {id: channel('G'), name: 'Available', tracks: [8]};
  for (const error of [Object.assign(new Error('Canceled.'), {canceled: true}),
    Object.assign(new Error('Account changed.'), {fatal: true})]) {
    const f = importerFixture(100, {profiles: [good], responses: new Map([[stop, error]])});
    await assert.rejects(f.core.run(stop + ', ' + good.id), e => e === error);
    assert.ok(!f.reads.includes(good.id));
    assert.deepEqual(f.writes, []);
  }
});

test('A reopened importer reconciles a partially committed mixed batch against the same destination', async () => {
  const first = {name: 'First', id: channel('F'), tracks: [10]}, second = {name: 'Second', id: channel('S'), tracks: [20]};
  const f = importerFixture(100, {profiles: [first, second], interruptFirstAdd: true});
  await assert.rejects(f.core.run(first.name + ', ' + second.id), /Session ended/);
  const pending = f.pending;
  assert.equal(pending.id, 'PLthree');
  assert.equal(pending.ids.length, 2);
  assert.equal(f.playlists[2].rows.length, 1);
  await f.reopen().run(second.id + ', ' + first.name);
  assert.equal(f.pending, null);
  assert.deepEqual(f.writes.map(([, body]) => body.playlistId), ['PLthree', 'PLthree']);
  assert.deepEqual(f.writes[1][1].actions.map(action => action.addedVideoId), pending.ids.slice(1));
  assert.deepEqual(f.playlists[2].rows.map(row => row.musicResponsiveListItemRenderer.playlistItemData.videoId).sort(),
    [video(10), video(20)]);
});

test('List Artists keeps same-name profiles distinct and subscribes only qualifying album owners', async () => {
  const other = {name: artist.name, id: channel('B')};
  const actualChannel = channel('C');
  const writes = [];
  const core = artists({
    async post(endpoint, body) {
      if (endpoint === 'subscription/subscribe') {
        writes.push(...body.channelIds);
        return {status: 'STATUS_SUCCEEDED'};
      }
      assert.equal(endpoint, 'browse');
      if (body.browseId === albumId) return albumPage(artist);
      if (body.browseId === 'MPRE_other') return albumPage(other);
      assert.equal(body.browseId, artist.id, 'Artist below the minimum was looked up for subscription');
      return {
        header: {subscribeButtonRenderer: {channelId: actualChannel, subscribed: false}},
        contents: {subscribeButtonRenderer: {channelId: other.id, subscribed: false}},
      };
    },
  });
  const albumTrack = (id, album) => ({id, album: {id: album}, artists: [other], available: true});
  const result = await core.countArtists([
    albumTrack(video(1), albumId), albumTrack(video(1), albumId),
    albumTrack(video(2), albumId), albumTrack(video(3), 'MPRE_other'),
  ], 2);
  assert.deepEqual(Array.from(result.counts, x => [x.id, x.count]).sort(), [[artist.id, 2], [other.id, 1]]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.text, '"The ""Quartet""",2');
  const summary = await core.subscribeListed(result);
  assert.equal(summary.subscribed, 1);
  assert.deepEqual(writes, [actualChannel]);
  await core.subscribeListed(result);
  assert.deepEqual(writes, [actualChannel], 'A repeated pass must reuse the known subscription');
});

test('Delete Duplicates journals exact removals and preserves the selected occurrence', async () => {
  const id = video(1);
  const lists = [
    {id: 'PLone', title: "Alfredo's__I__", rows: [
      track(id, 'copy-1'), track(id, 'keeper'), track(id, 'copy-1'), track(video(2), 'other-track'),
    ]},
    {id: 'PLtwo', title: "Alfredo's__II__", rows: [track(id, 'copy-2'), track(id)]},
  ];
  let saved;
  const writes = [];
  const core = duplicates({
    newId: () => 'fixture-run',
    store: {
      async load() { return null; }, async create() {}, async append() { return []; },
      async saveGroup(_run, group) { saved = structuredClone(group); return []; },
    },
    async post(endpoint, body, options) {
      if (endpoint === 'browse') {
        if (body.browseId === 'FEmusic_liked_playlists') return library([...lists].reverse());
        return playlistPage(lists.find(p => body.browseId === 'VL' + p.id));
      }
      assert.equal(endpoint, 'browse/edit_playlist');
      assert.equal(options.write, true);
      assert.equal(core.authorize(body), true);
      const forbidden = {action: 'ACTION_REMOVE_VIDEO', removedVideoId: id, setVideoId: 'keeper'};
      assert.equal(core.authorize({playlistId: 'PLone', actions: [forbidden]}), false);
      for (const action of body.actions) {
        assert.equal(action.removedVideoId, id);
        assert.ok(saved.copies.some(c =>
          c.playlistId === body.playlistId && c.setVideoId === action.setVideoId && c.state === 'pending'
        ), 'The occurrence must be saved as pending before dispatch');
        writes.push([body.playlistId, action.setVideoId]);
      }
      return {status: 'STATUS_SUCCEEDED'};
    },
  });
  const run = await core.prepare();
  assert.equal(run.overlaps, 1);
  const group = core.next();
  const keeper = group.copies.find(c => c.setVideoId === 'keeper');
  assert.ok(keeper);
  await core.applyChoice(group, keeper.key);
  assert.equal(keeper.state, 'present');
  assert.equal(group.copies.find(c => !c.setVideoId).state, 'failed');
  assert.deepEqual(writes, [['PLone', 'copy-1'], ['PLtwo', 'copy-2']]);
  assert.equal(core.stats().removed, 2);
});

function ratingRow(id, rating, {playable = true, withCommand = true} = {}) {
  const {musicResponsiveListItemRenderer: row} = track(id);
  row.isPlayable = playable;
  const command = {likeEndpoint: {status: 'LIKE', target: {videoId: id}}};
  row.menu = {menuRenderer: {topLevelButtons: [{likeButtonRenderer: {
    likeStatus: rating, target: {videoId: id}, serviceEndpoints: withCommand ? [command] : [],
  }}]}};
  return {musicResponsiveListItemRenderer: row};
}

test('Like Songs dispatches only usable neutral IDs once and refreshes the rating counters', async () => {
  const source = {id: 'PLone', title: "Alfredo's__I__"};
  const calls = [];
  let received = false;
  const core = likes({
    async post(endpoint, body) {
      assert.equal(endpoint, 'browse');
      if (body.browseId === 'FEmusic_liked_playlists') return library([source]);
      assert.equal(body.browseId, 'VL' + source.id);
      const rate = received ? 'LIKE' : 'INDIFFERENT';
      return playlistPage({...source, rows: [
        ratingRow(video(1), rate), ratingRow(video(1), rate),
        ratingRow(video(2), 'LIKE'), ratingRow(video(3), 'DISLIKE'),
        ratingRow(video(4), 'INDIFFERENT', {playable: false}),
        ratingRow(video(5), 'INDIFFERENT', {withCommand: false}), ratingRow(video(6), 'UNRECOGNIZED'),
        ratingRow(video(7), 'INDIFFERENT'), ratingRow(video(7), 'DISLIKE'),
      ]});
    },
    async like(id, command) {
      assert.equal(core.authorizeNative(id, command), true);
      assert.equal(core.authorizeNative(video(8), command), false);
      calls.push(id);
      received = true;
    },
  });
  const stats = await core.run();
  assert.deepEqual(calls, [video(1)]);
  assert.equal(stats.phase, 'done');
  assert.equal(stats.entries, 18);
  assert.equal(stats.sent, 1);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.refreshed, 1);
  assert.equal(stats.liked, 2);
  assert.equal(stats.disliked, 2);
  assert.equal(stats.unrated, 1);
  assert.equal(stats.missingCommand, 1);
  assert.equal(stats.unavailable, 1);
  assert.equal(stats.unknown, 1);
  assert.equal(stats.eligible, 0);
});

test('Like Songs reports a rejected request separately from observed ratings', async () => {
  const source = {id: 'PLone', title: "Alfredo's__I__"};
  let requests = 0;
  const core = likes({
    async post(endpoint, body) {
      assert.equal(endpoint, 'browse');
      if (body.browseId === 'FEmusic_liked_playlists') return library([source]);
      assert.equal(body.browseId, 'VL' + source.id);
      return playlistPage({...source, rows: [ratingRow(video(1), 'INDIFFERENT')]});
    },
    async like(id) {
      assert.equal(id, video(1));
      requests++;
      throw Object.assign(new Error('Rejected'), {httpStatus: 400, definite: true});
    },
  });
  await assert.rejects(core.run(), /rejected requests/);
  const stats = core.stats();
  assert.equal(requests, 1);
  assert.equal(stats.sent, 1);
  assert.equal(stats.errors, 1);
  assert.equal(stats.accepted, 0);
  assert.equal(stats.liked, 0);
  assert.equal(stats.unrated, 1);
  assert.equal(stats.eligible, 1);
});
