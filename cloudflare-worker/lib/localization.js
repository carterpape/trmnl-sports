// Server-side localization of the strings the templates render verbatim:
// the "no game" / outage messages, the date and time labels, and the staleness
// marker. Pure — the only inputs are the locale, IANA tz, and timestamps. The
// time-dependent helpers take an optional `nowMs` (defaulting to the real
// clock) so production calls are unchanged but tests can pin "now".

// Localized "no game found" copy keyed by language code (the part of an IETF
// locale tag before the first hyphen). Falls back to English. Templates render
// the localized string directly via {{ not_found_message }}.
const NOT_FOUND_MESSAGES = {
    en: "No game found",
    es: "Sin partido",
    de: "Kein Spiel",
    fr: "Aucun match",
    it: "Nessuna partita",
    pt: "Sem jogo",
    nl: "Geen wedstrijd",
    sv: "Ingen match",
    da: "Ingen kamp",
    no: "Ingen kamp",
    fi: "Ei ottelua",
    pl: "Brak meczu",
    ru: "Нет матчей",
    ja: "試合なし",
    ko: "경기 없음",
    zh: "无比赛",
};

// Localized "can't reach the data source" copy, keyed like NOT_FOUND_MESSAGES.
// Shown only when upstream is down AND there's no usable last-known-good to fall
// back on — distinct from the genuine "no game found" so an outage doesn't read
// as a finished season. Good-faith translations; review with a native speaker.
const OUTAGE_MESSAGES = {
    en: "Schedule unavailable",
    es: "Calendario no disponible",
    de: "Spielplan nicht verfügbar",
    fr: "Calendrier indisponible",
    it: "Calendario non disponibile",
    pt: "Calendário indisponível",
    nl: "Schema niet beschikbaar",
    sv: "Schema ej tillgängligt",
    da: "Plan utilgængelig",
    no: "Plan utilgjengelig",
    fi: "Aikataulu ei käytettävissä",
    pl: "Harmonogram niedostępny",
    ru: "Расписание недоступно",
    ja: "日程を取得できません",
    ko: "일정을 불러올 수 없음",
    zh: "无法获取赛程",
};

// "as of <time>" affixes for the staleness marker, keyed like NOT_FOUND_MESSAGES.
// `pre`/`post` place the marker around the localized timestamp — most languages
// prefix it; Japanese/Korean suffix it (e.g. "19:00現在", "오후 7시 기준").
// Good-faith translations; review with a native speaker.
const AS_OF_AFFIXES = {
    en: { pre: "as of " },
    es: { pre: "a las " },
    de: { pre: "Stand " },
    fr: { pre: "à " },
    it: { pre: "alle " },
    pt: { pre: "às " },
    nl: { pre: "vanaf " },
    sv: { pre: "kl. " },
    da: { pre: "kl. " },
    no: { pre: "kl. " },
    fi: { pre: "klo " },
    pl: { pre: "stan na " },
    ru: { pre: "на " },
    ja: { post: "現在" },
    ko: { post: " 기준" },
    zh: { pre: "截至 " },
};

// Validate a locale tag, falling back when missing or unparseable. Catches
// local-preview placeholders like the literal string "{{ trmnl.user.locale }}"
// that arrive verbatim when trmnlp doesn't interpolate trmnl.* into URLs.
export function parseLocale(raw) {
    if (!raw || raw.includes("{{")) return "en-US";
    try {
        new Intl.Locale(raw);
        return raw;
    } catch {
        return "en-US";
    }
}

// Validate an IANA time-zone string, falling back to UTC when missing or
// unparseable. Same {{...}} guard as parseLocale.
export function parseTimeZone(raw) {
    if (!raw || raw.includes("{{")) return "UTC";
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: raw });
        return raw;
    } catch {
        return "UTC";
    }
}

export function notFoundMessage(locale) {
    const lang = locale.split("-")[0].toLowerCase();
    return NOT_FOUND_MESSAGES[lang] || NOT_FOUND_MESSAGES.en;
}

export function outageMessage(locale) {
    const lang = locale.split("-")[0].toLowerCase();
    return OUTAGE_MESSAGES[lang] || OUTAGE_MESSAGES.en;
}

// Capitalize the first character with locale-aware case mapping. Used to make
// Intl.RelativeTimeFormat output ("today", "heute", "今日") render as a leading
// capital where the locale supports it; locales with no case (Japanese, etc.)
// pass through unchanged.
export function capitalizeFirst(s, locale) {
    if (!s) return s;
    return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
}

// Returns the calendar date in the given IANA time zone, formatted YYYY-MM-DD.
// Used to compare game day vs. today/tomorrow without DST or offset math.
export function ymdInZone(date, tz) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

export function localizeDateLabel(gameMs, locale, tz, nowMs = Date.now()) {
    const now = new Date(nowMs);
    const todayYmd = ymdInZone(now, tz);
    const tomorrowYmd = ymdInZone(new Date(now.getTime() + 86400000), tz);
    const gameYmd = ymdInZone(new Date(gameMs), tz);

    if (gameYmd === todayYmd || gameYmd === tomorrowYmd) {
        const offset = gameYmd === todayYmd ? 0 : 1;
        try {
            const rtf = new Intl.RelativeTimeFormat(locale, {
                numeric: "auto",
            });
            return capitalizeFirst(rtf.format(offset, "day"), locale);
        } catch {
            return offset === 0 ? "Today" : "Tomorrow";
        }
    }

    return new Intl.DateTimeFormat(locale, {
        timeZone: tz,
        weekday: "long",
        month: "short",
        day: "numeric",
    }).format(new Date(gameMs));
}

export function localizeTimeLabel(gameMs, locale, tz) {
    let timeStr = new Intl.DateTimeFormat(locale, {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(gameMs));

    // AP-style lowercase periods for English locales; other locales' native
    // formats (typically 24h) pass through untouched.
    if (locale.toLowerCase().startsWith("en")) {
        timeStr = timeStr.replace(/\bAM\b/g, "a.m.").replace(/\bPM\b/g, "p.m.");
    }
    return timeStr;
}

// "as of <time>" staleness marker for a last-known-good screen served during an
// outage. Reuses localizeTimeLabel so the time format matches the live labels.
// When the cached data was fetched on an earlier calendar day (in the user's
// zone), prepend a compact date so a multi-day-old fetch doesn't read as today.
export function asOfLabel(fetchedAtMs, locale, tz, nowMs = Date.now()) {
    const lang = locale.split("-")[0].toLowerCase();
    const affix = AS_OF_AFFIXES[lang] || AS_OF_AFFIXES.en;
    let stamp = localizeTimeLabel(fetchedAtMs, locale, tz);
    const fetched = new Date(fetchedAtMs);
    if (ymdInZone(fetched, tz) !== ymdInZone(new Date(nowMs), tz)) {
        const date = new Intl.DateTimeFormat(locale, {
            timeZone: tz,
            month: "short",
            day: "numeric",
        }).format(fetched);
        stamp = `${date} ${stamp}`;
    }
    return `${affix.pre || ""}${stamp}${affix.post || ""}`;
}
