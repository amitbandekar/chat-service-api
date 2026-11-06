/**
 * IST (Asia/Kolkata) time helpers.
 *
 * The bot runs on Render in UTC, so `new Date().getHours()` and
 * `toLocaleTimeString('en-IN')` (en-IN only changes formatting, NOT the zone)
 * produced UTC clocks. This made the bot believe "Aatach 6:51 zalyat re" at
 * midnight IST and scold a 7:51 AM "good morning" as 2 AM.
 *
 * Every hour check and clock string shown to the LLM must go through these
 * helpers so the bot always reasons with India time.
 */
const IST_TIMEZONE = 'Asia/Kolkata';

const _hourFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    hourCycle: 'h23',
});
const _timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
});
const _dayFmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    weekday: 'long',
});
const _dayKeyFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/** Hour (0-23) in IST for a given date. */
function istHour(date = new Date()) {
    const h = parseInt(_hourFmt.format(date), 10);
    return Number.isFinite(h) ? h % 24 : 0;
}

/** "HH:MM" clock string in IST. */
function istTimeStr(date = new Date()) {
    return _timeFmt.format(date);
}

/** Long weekday name in IST ("Monday"). */
function istDayStr(date = new Date()) {
    return _dayFmt.format(date);
}

/** IST calendar-day key ("05/11/2026") used for daily budget resets. */
function istDayKey(date = new Date()) {
    return _dayKeyFmt.format(date);
}

/**
 * IST alias for the old UTC-based helper:
 * counts minutes between two dates that fall inside 07:00–23:59 IST.
 */
function getActiveDaytimeElapsedMinutesIST(fromDate, toDate) {
    if (!fromDate || Number.isNaN(new Date(fromDate).getTime()) || !toDate) return 0;
    let current = new Date(fromDate.getTime());
    let activeMinutes = 0;

    while (current < toDate) {
        if (istHour(current) >= 7) { // awake/active window: 07:00–23:59 IST
            activeMinutes += 1;
        }
        current.setMinutes(current.getMinutes() + 1);
    }
    return activeMinutes;
}

/**
 * Clamp a loaded timestamp so a long server downtime is not reported as
 * "457 inactive hours". Anything older than maxHoursBack is treated as
 * maxHoursBack old instead.
 */
function clampRecent(date, maxHoursBack = 48) {
    if (!date || Number.isNaN(new Date(date).getTime())) return new Date();
    const floor = new Date(Date.now() - maxHoursBack * 3600000);
    return date.getTime() < floor.getTime() ? floor : date;
}

module.exports = {
    IST_TIMEZONE,
    istHour,
    istTimeStr,
    istDayStr,
    istDayKey,
    getActiveDaytimeElapsedMinutesIST,
    clampRecent,
};
