// TV episodes: Stremio ids look like "tt0412142:1:6" (IMDb id, season, episode).

export function parseVideoId(id) {
  const [imdbId, s, e] = String(id).split(':');
  if (!/^tt\d+$/.test(imdbId)) return null;
  if (s === undefined) return { imdbId, season: null, episode: null };
  const season = Number.parseInt(s, 10);
  const episode = Number.parseInt(e, 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  return { imdbId, season, episode };
}

export const isEpisode = (v) => v.season != null && v.episode != null;
export const videoKey = (v) => (isEpisode(v) ? `${v.imdbId}:${v.season}:${v.episode}` : v.imdbId);
export const videoLabel = (v) => (isEpisode(v) ? `${v.imdbId} S${String(v.season).padStart(2, '0')}E${String(v.episode).padStart(2, '0')}` : v.imdbId);

const ZH_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function zhNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  // 十, 十二, 二十, 二十三 (enough for episode numbers)
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? ZH_NUM[m[1]] : 1) * 10 + (m[2] ? ZH_NUM[m[2]] : 0);
  return ZH_NUM[s] ?? NaN;
}

// What episode(s) a subtitle file name refers to:
//   { season, episodes: [from, to] } or null when the name carries no marker.
export function episodeOf(name) {
  const n = String(name || '').replace(/\.(srt|ass|ssa|vtt|zip|rar|7z)$/i, '');
  let m = n.match(/s(\d{1,2})[ ._-]*e(\d{1,3})(?:[ ._-]*(?:-|e|~)[ ._-]*e?(\d{1,3}))?/i);
  if (m) return { season: +m[1], episodes: [+m[2], m[3] ? +m[3] : +m[2]] };
  m = n.match(/(?:^|[^\d])(\d{1,2})x(\d{1,3})(?:[^\d]|$)/i);
  if (m) return { season: +m[1], episodes: [+m[2], +m[2]] };
  m = n.match(/第\s*([\d一二三四五六七八九十]+)\s*季.*?第\s*([\d一二三四五六七八九十]+)\s*集/);
  if (m) return { season: zhNumber(m[1]), episodes: [zhNumber(m[2]), zhNumber(m[2])] };
  m = n.match(/第\s*([\d一二三四五六七八九十]+)\s*集/);
  if (m) return { season: null, episodes: [zhNumber(m[1]), zhNumber(m[1])] };
  m = n.match(/(?:^|[^a-z])(?:ep?|episode)[ ._-]*(\d{1,3})(?:[^\d]|$)/i);
  if (m) return { season: null, episodes: [+m[1], +m[1]] };
  // Anime fansub style: "[Group] Title - 02 (1080p)", "Title - 26v2 [ABCD]".
  m = n.match(/\s-\s*(\d{1,3})(?:v\d+)?(?=\s|$|[[(])/);
  if (m) return { season: null, episodes: [+m[1], +m[1]] };
  return null;
}

// true / false when the name says which episode it is; null when it doesn't.
export function nameMatchesEpisode(name, season, episode) {
  const ep = episodeOf(name);
  if (!ep) return null;
  if (ep.season != null && ep.season !== season) return false;
  return episode >= ep.episodes[0] && episode <= ep.episodes[1];
}

// Episode number counted from the start of the show: season 2 episode 2 of a
// show with a 24-episode first season is 26. null when it can't be worked out.
export function runningTotal(seasonEpisodeCounts, season, episode) {
  if (season == null || season < 2) return null;
  let before = 0;
  for (let s = 1; s < season; s++) {
    if (!seasonEpisodeCounts?.[s]) return null; // incomplete season list
    before += seasonEpisodeCounts[s];
  }
  return before + episode;
}

// From a pack's files, the ones for this episode. `absolute` is the episode's
// running-total number (see above), used by packs that number a whole show
// 01, 02 … 48 without seasons. A lone file with no episode marker is kept.
export function pickEpisodeFiles(files, season, episode, absolute = null) {
  const info = files.map((f) => episodeOf(f.name));
  const inRange = (ep, n) => n >= ep.episodes[0] && n <= ep.episodes[1];
  const matches = files.filter((f) => nameMatchesEpisode(f.name, season, episode) === true);
  if (absolute != null) {
    const byAbsolute = files.filter((_, i) => info[i] && info[i].season == null && inRange(info[i], absolute));
    if (byAbsolute.length) {
      // In such a pack a bare "02" is season 1's episode 2, not this one.
      const withSeason = files.filter((_, i) => info[i]?.season === season && inRange(info[i], episode));
      return [...new Set([...withSeason, ...byAbsolute])];
    }
  }
  if (matches.length) return matches;
  return files.length === 1 && info[0] === null ? files : [];
}
