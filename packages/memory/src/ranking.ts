import type { TopicEpisode } from '@trinity-harness/contracts';

/** RRF keeps incomparable lexical/vector scores out of a shared numeric scale. */
export function fuseEpisodes(
  lexical: readonly TopicEpisode[],
  vector: readonly TopicEpisode[],
  now: Date,
  limit: number,
  halfLifeDays = 90,
): { episode: TopicEpisode; source: 'lexical' | 'vector' | 'both'; score: number }[] {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0)
    throw new Error('Invalid memory ranking clock or half-life');
  const rows = new Map<string, { episode: TopicEpisode; lexical: number; vector: number }>();
  for (const [channel, episodes] of [
    ['lexical', lexical],
    ['vector', vector],
  ] as const) {
    const seen = new Set<string>();
    episodes.forEach((episode, index) => {
      if (seen.has(episode.episodeId)) return;
      seen.add(episode.episodeId);
      const row = rows.get(episode.episodeId) ?? { episode, lexical: 0, vector: 0 };
      row[channel] = 1 / (60 + index + 1);
      rows.set(episode.episodeId, row);
    });
  }
  return [...rows.values()]
    .map(({ episode, lexical, vector }) => ({
      episode,
      source:
        lexical && vector
          ? ('both' as const)
          : lexical
            ? ('lexical' as const)
            : ('vector' as const),
      score:
        (lexical + vector) *
        2 ** (-Math.max(0, now.getTime() - Date.parse(episode.at)) / (halfLifeDays * 86_400_000)),
    }))
    .sort((a, b) => b.score - a.score || a.episode.episodeId.localeCompare(b.episode.episodeId))
    .slice(0, limit);
}
