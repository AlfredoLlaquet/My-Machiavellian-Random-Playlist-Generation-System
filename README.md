# My Machiavellian Random-Playlist-Generation System

Alfredo Llaquet-Alsina built his YouTube Music collection across a series of numbered playlists. He wanted to enter an artist's name, add the recordings he was missing, then draw a fresh listening playlist from the entire collection. **Add Songs** and **Random Songs** do those two jobs. Five companion bookmarklets count artists, remove duplicate entries, like unrated songs, sample a regular YouTube playlist, and copy videos between playlists.

Each tool has its own self-contained Firefox installer. Install the ones you use. A click on the bookmark opens its controls on the corresponding YouTube site, using the account already selected in that tab.

## Choose an installer

| Site | Tool and bookmark name | Version | What it does | Installer |
| --- | --- | --- | --- | --- |
| YouTube Music | **Add Songs** `+` | 2.2.0 | Finds artists by name or YouTube channel ID and adds their missing tracks to the collection. | [YouTube-Music-Alfredo-Import.html](installers/YouTube-Music-Alfredo-Import.html) |
| YouTube Music | **Random Songs** `⤨` | 2.1.1 | Builds a new private listening playlist from distinct eligible songs across the collection. | [YouTube-Music-Alfredo-Collection.html](installers/YouTube-Music-Alfredo-Collection.html) |
| YouTube Music | **List Artists** `≡` | 2.2.0 | Lists artists and distinct track counts, then subscribes you to the artists who meet the threshold. | [YouTube-Music-Alfredo-Artists.html](installers/YouTube-Music-Alfredo-Artists.html) |
| YouTube Music | **Delete Duplicates** `⌫` | 1.0.3 | Finds repeated video IDs and removes the extra playlist entries you select, or keeps the first automatically. | [YouTube-Music-Alfredo-Delete-Duplicates.html](installers/YouTube-Music-Alfredo-Delete-Duplicates.html) |
| YouTube Music | **Like Songs** `♥` | 2.0.0 | Works through the collection's playlists in random order, liking eligible unrated tracks. | [YouTube-Music-Alfredo-Like-Songs.html](installers/YouTube-Music-Alfredo-Like-Songs.html) |
| YouTube | **Random Sample** `⤨` | 1.0.1 | Takes a random sample from one video playlist and saves it as a new private playlist. | [YouTube-Random-Sample.html](installers/YouTube-Random-Sample.html) |
| YouTube | **Copy Videos** `+` | 1.3.0 | Appends videos from the open playlist to a destination you choose and the bookmarklet remembers. | [YouTube-Playlist-Copier.html](installers/YouTube-Playlist-Copier.html) |

The two `+` bookmarks and the two `⤨` bookmarks are deliberately named alike. Keep a **YouTube Music** folder and a **YouTube** folder on the Bookmarks Toolbar to tell them apart.

## Install or update in Firefox

1. Open the installer link in the table, download the raw HTML file from GitHub, and open the downloaded file in Firefox. Each installer contains the bookmarklet itself. You only need that one file.
2. Show Firefox's Bookmarks Toolbar if it is hidden. Drag the installer's bookmark link onto the toolbar or into the appropriate toolbar folder.
3. Open the correct site in a tab and select the account that should own the changes. Music tools run at `https://music.youtube.com`. Video tools run at `https://www.youtube.com`. Click the saved bookmark.

Two other installation methods are available on each installer page. For **HTML import**, click **Download bookmark file**, then use **Import and Backup → Import Bookmarks from HTML** in Firefox's bookmarks manager. For **manual installation**, click **Copy bookmark URL**, create a bookmark with the name in the table, and paste the full URL, including `javascript:`, into its URL field. **Download JavaScript** saves the readable source for inspection.

To update a tool, finish or pause its current work, close its panel, and replace the saved bookmark with the one from the newer installer. An old bookmark keeps running the code it contains. Renaming it changes only its toolbar label.

## Use the numbered music collection

The five Music tools recognize playlists visible in your selected account's Music library with names such as `Alfredo's__I__`, `Alfredo's __II__`, and `_ Alfredo's __III__`. The name can begin with spaces or underscores. Use a straight apostrophe in `Alfredo's`, optional spaces after it, and an uppercase Roman numeral between two pairs of underscores. The final two underscores end the name. The tools use the numeral wherever playlist order matters.

Any account can use this naming convention. For a new collection, start with **Add Songs**. When it has tracks to add and finds no matching playlist, it creates the private playlist `Alfredo's __I__` for you.

**Bring in music.** Open Add Songs and enter artist names, YouTube channel IDs, or both. Separate entries with commas or line breaks, then click **Add missing songs**.

```text
Count Basie, UCPzoHRR53Gi5pT8kHU9FptQ, "Earth, Wind & Fire"
```

Use double quotes around a name that contains a comma. To include a quotation mark inside a quoted name, double it. For a channel ID, copy the part after `/channel/` in an artist's URL. Paste the ID without quotes and keep its capitalization. Add Songs recognizes uppercase `UC` followed by exactly 22 letters (A–Z or a–z), digits, underscores, or hyphens. If an artist's literal name has that exact shape, put it in double quotes to search for the name.

A name search can find several artists with the same name. Inspect the linked profiles and choose which to include. A channel ID selects the verified YouTube Music artist directly, even if you previously excluded that profile in a name search. The selection applies to this run and preserves the saved name choice. The results show the artist's name beside the submitted ID. **Requested inputs** counts the distinct names and IDs you entered. **Matched artists** counts an artist once even if you entered both their name and their ID. When an ID cannot be resolved to a Music artist, the panel reports it and continues with the other entries. A verified artist can also have zero eligible tracks.

The importer follows albums, singles, and EPs. If two profiles in your results share a name, a linked artist credit can identify which one owns a recording. A credit that gives only their shared name is skipped. The importer checks for video IDs already present anywhere in the collection and fills eligible editable playlists. A destination must start with at least 500 free slots and can then fill to 5,000 entries. When another destination is needed, the importer creates the next numbered private playlist. Artist choices and interrupted additions are remembered for this account in this browser.

**Make a listening playlist.** Open Random Songs, choose a title and count, and click **Create playlist**. For a 2,000-song sample with a 1% artist limit, the initial allowance is 20 songs per artist. Collaborations count against each credited artist's allowance. If there are enough eligible tracks but the quotas prevent a full sample, the tool can relax the quotas to fill it. A dislike found on any source copy excludes that video ID. The default request is 200 songs with a 1% artist limit. Playback checks are off by default for this collection-wide scan.

**See who is represented.** Opening List Artists starts scanning. The default minimum is 15 distinct tracks. Album ownership determines the artist credit, with the main track artist used for a Various Artists release. The output is sorted by decreasing count, then by name. **Copy list** produces lines such as `"Count Basie",152`. This is also a subscription tool. It subscribes the active account to artists who qualify and have an identifiable channel. Raising the threshold leaves existing subscriptions in place.

**Remove extra entries.** Delete Duplicates treats two occurrences of the same YouTube video ID as duplicates. Two uploads of the same performance with different IDs remain distinct. Manual mode lets you choose a keeper or skip the track. Automatic mode keeps the first occurrence in Roman playlist order, then in the order of entries within that playlist. The memo records the keeper, removals and unresolved outcomes. Download it before choosing **Restart**, which clears the memo and starts a new scan. Completed removals remain in effect.

**Like the unrated tracks.** Open Like Songs and choose **Start**. It reads a playlist completely, sends native Like requests for eligible unrated tracks about 1.2 seconds apart, then reads the playlist again. Existing likes and dislikes, unavailable tracks, and unreadable ratings are skipped. The request counter measures dispatches. The refreshed playlist counts report the ratings that YouTube Music returns. **Cancel** and **Resume** operate on the current panel's in-memory run.

## Work with regular YouTube playlists

**Random Sample** works from a single saved playlist you can read. Open that playlist, set a count from 1 through 5,000 and give the result a title. For example, take 30 videos from a concert archive to make a private viewing playlist. Distinct video IDs enter the draw once. Playback checks are on by default and unavailable selections are replaced when possible.

**Copy Videos** works from the playlist open in the tab. On first use, enter the URL or ID of a playlist you can edit and click **Save destination**. The tool remembers it for the signed-in account in this browser. If storage or a stable account identity is unavailable, the choice lasts for the current panel. Use **Change destination** to choose another.

Check the displayed source and destination, then click **Add videos**. The two playlist IDs must differ. The copier works in source order and skips unavailable entries and videos already found in the destination. If the destination can only be read partially, it continues on a best-effort basis and some duplicates can remain. **Download source URLs** produces a text backup of the readable video IDs.

## Interrupted runs and site changes

| Situation | How to continue |
| --- | --- |
| A sampler created a playlist, then stopped | Keep the tab open. Reopen the bookmark in that tab and use **Finish saved playlist**. It checks the existing entries against the saved selection before adding the missing suffix. Manual edits to the result can prevent recovery. |
| Playlist creation timed out before it returned an ID | Look for the chosen title in your account's playlists. The create request may already have succeeded. Clearing the saved attempt clears local recovery data. |
| An Add Songs run stopped | Start it again in the same account and browser. It checks pending creation or additions before proceeding. Reopen the panel for a fresh scan after making collection changes elsewhere. |
| A duplicate-removal session stopped | Open the bookmark in the same account and Firefox profile and use **Resume**. A completed scan and its memo survive closing the tab. Keep other editors away from those playlists during this run. |
| A panel no longer recognizes playlists or entries | Check the active site, account, playlist visibility and Music playlist spelling. The tools use the website's own interfaces. Changes in YouTube's page structure or responses can require a tool update. |

Both samplers read their sources and add only to their own newly created private playlist. They verify the resulting ID sequence. A partially created playlist remains in the account after cancellation. The tools use the signed-in site's own session and send requests to that site's origin. A bookmarklet requires neither an extension nor a separate API key.

## Build and verify

The seven readable JavaScript files in [src](src/) are the runtime sources. Each file keeps a tool's playlist operations alongside the browser code that opens its panel and talks to the signed-in site. The operation code accepts dependencies such as playlist requests and storage. Tests can therefore supply a collection, simulate a lost response and inspect exactly which playlist would receive the next write.

[tools.json](tools.json) records the tool identities and packaging metadata. The build uses the version of Terser pinned in the package lock to compact the bookmark URLs, then produces the checked-in [installers](installers/) from a [shared HTML template](scripts/installer.html). Each HTML file contains everything the bookmark needs at runtime, including on another computer.

Use Node.js 20 or newer and npm from the repository root.

```sh
npm ci
npm run build
npm run check
```

`npm run build` also regenerates the installers after an edit. `npm run check` checks those files against a fresh build and runs the tests. Use `npm test` to run the tests alone. The offline tests use controlled playlist responses to exercise write destinations and recovery behavior. The packaging tests cover the installed bookmark URLs. Testing against real YouTube accounts is separate from the automated suite.

GitHub Actions runs the same check on pushes and pull requests with Node.js 20 and 24.

For a change, start with the corresponding file in `src/`, update the affected test and documentation, regenerate the installers, and run the checks above. The project uses the [Unlicense](LICENSE). Build conventions, storage compatibility and release checks are recorded in [mmrpgs.txt](mmrpgs.txt).
