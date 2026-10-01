import { randomInt } from "node:crypto";

export interface AnimeEntry {
  title: string;
  englishTitle: string | null;
  nativeTitle: string | null;
  synonyms: string[];
  imageUrl: string;
}

type Fetcher = typeof fetch;

const ANILIST_QUERY = `
  query ($page: Int!, $perPage: Int!) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        title { romaji english native }
        synonyms
        coverImage { extraLarge large }
      }
    }
  }
`;

export async function fetchAnimePool(fetcher: Fetcher = fetch): Promise<AnimeEntry[]> {
  let anilistError: unknown;
  try {
    return await fetchAniList(fetcher);
  } catch (error) {
    anilistError = error;
  }

  try {
    return await fetchJikanWithRetry(fetcher);
  } catch (jikanError) {
    throw new AggregateError([anilistError, jikanError], "All anime providers are unavailable");
  }
}

async function fetchAniList(fetcher: Fetcher): Promise<AnimeEntry[]> {
  const response = await fetcher("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "assure/1.0",
    },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { page: randomInt(1, 5), perPage: 30 } }),
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`AniList returned ${response.status}`);

  const body = await response.json() as {
    data?: { Page?: { media?: Array<{
      title?: { romaji?: string | null; english?: string | null; native?: string | null };
      synonyms?: string[] | null;
      coverImage?: { extraLarge?: string | null; large?: string | null };
    }> } };
  };
  const pool = (body.data?.Page?.media ?? []).flatMap((anime): AnimeEntry[] => {
    const title = anime.title?.romaji?.trim();
    const imageUrl = anime.coverImage?.extraLarge ?? anime.coverImage?.large;
    if (!title || !imageUrl) return [];
    return [{
      title,
      englishTitle: anime.title?.english?.trim() || null,
      nativeTitle: anime.title?.native?.trim() || null,
      synonyms: (anime.synonyms ?? []).filter((synonym) => Boolean(synonym?.trim())),
      imageUrl,
    }];
  });
  if (pool.length === 0) throw new Error("AniList returned no usable anime");
  return pool;
}

async function fetchJikanWithRetry(fetcher: Fetcher): Promise<AnimeEntry[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchJikan(fetcher);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await delay(400);
    }
  }
  throw lastError;
}

async function fetchJikan(fetcher: Fetcher): Promise<AnimeEntry[]> {
  const page = randomInt(1, 5);
  const response = await fetcher(`https://api.jikan.moe/v4/top/anime?type=tv&filter=bypopularity&sfw=true&limit=25&page=${page}`, {
    headers: { accept: "application/json", "user-agent": "assure/1.0" },
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`Jikan returned ${response.status}`);

  const body = await response.json() as { data?: Array<{
    title?: string;
    title_english?: string | null;
    title_japanese?: string | null;
    title_synonyms?: string[];
    images?: { jpg?: { large_image_url?: string; image_url?: string } };
  }> };
  const pool = (body.data ?? []).flatMap((anime): AnimeEntry[] => {
    const title = anime.title?.trim();
    const imageUrl = anime.images?.jpg?.large_image_url ?? anime.images?.jpg?.image_url;
    if (!title || !imageUrl) return [];
    return [{
      title,
      englishTitle: anime.title_english?.trim() || null,
      nativeTitle: anime.title_japanese?.trim() || null,
      synonyms: (anime.title_synonyms ?? []).filter((synonym) => Boolean(synonym?.trim())),
      imageUrl,
    }];
  });
  if (pool.length === 0) throw new Error("Jikan returned no usable anime");
  return pool;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
