import { Teams, Tickets, ClockEvents } from '../../collections.js';
import { formatDurationText } from './ClockEventHelpers.js';

const MAX_TICKETS = 50;
const MAX_CLOCK_EVENTS = 30;

function formatDate(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '?';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Build a plain-text context string of the user's teams, tickets, and recent work sessions
 * for injection into the Jerry AI (Ollama) system prompt.
 * @param {string} userId - Current user ID
 * @returns {Promise<string>} Formatted context string
 */
export async function buildJerryContext(userId) {
  if (!userId) return "The user is not logged in.";

  const teams = await Teams.find({
    $or: [{ members: userId }, { admins: userId }],
  }).fetchAsync();

  const teamIds = teams.map((t) => t._id);
  const teamMap = new Map(teams.map((t) => [t._id, t]));

  if (teamIds.length === 0) {
    return "The user has no teams, tickets, or work sessions yet.";
  }

  const tickets = await Tickets.find({ teamId: { $in: teamIds } })
    .fetchAsync()
    .then((list) => list.slice(0, MAX_TICKETS));
  const ticketMap = new Map(tickets.map((t) => [t._id, t]));

  const clockEvents = await ClockEvents.find(
    { userId },
    { sort: { startTimestamp: -1 }, limit: MAX_CLOCK_EVENTS }
  ).fetchAsync();

  const now = Date.now();
  const lines = [];

  lines.push("## Teams");
  for (const t of teams) {
    lines.push(`- ${t.name || 'Unnamed'} (code: ${t.code || '—'})`);
  }

  lines.push("\n## Tickets");
  if (tickets.length === 0) {
    lines.push("- None");
  } else {
    for (const t of tickets) {
      const team = teamMap.get(t.teamId);
      const teamName = team?.name || '?';
      const sec = t.accumulatedTime || 0;
      const duration = formatDurationText(sec);
      const createdByMe = t.createdBy === userId ? " (created by me)" : "";
      const title = (t.title || 'Untitled').replace(/\n/g, ' ');
      const desc = t.description ? ` | ${String(t.description).slice(0, 80).replace(/\n/g, ' ')}` : '';
      lines.push(`- "${title}"${desc} | ${duration} | Team: ${teamName}${createdByMe}`);
    }
  }

  lines.push("\n## Recent work sessions");
  if (clockEvents.length === 0) {
    lines.push("- None");
  } else {
    for (const e of clockEvents) {
      const team = teamMap.get(e.teamId);
      const teamName = team?.name || '?';
      const startStr = formatDate(e.startTimestamp);
      const isActive = e.endTime == null;
      let durationSec = e.accumulatedTime || 0;
      if (isActive && e.startTimestamp) {
        durationSec = Math.floor((now - e.startTimestamp) / 1000);
      } else if (e.endTime && e.startTimestamp) {
        const endMs = e.endTime instanceof Date ? e.endTime.getTime() : e.endTime;
        durationSec = Math.floor((endMs - e.startTimestamp) / 1000);
      }
      const durationStr = formatDurationText(durationSec);
      const status = isActive ? " (in progress)" : "";
      const ticketTitles = (e.tickets || [])
        .map((ent) => ticketMap.get(ent.ticketId)?.title || '?')
        .filter(Boolean);
      const ticketsStr = ticketTitles.length > 0 ? ` | Tickets: ${ticketTitles.join(', ')}` : '';
      lines.push(`- ${startStr} – ${teamName} | ${durationStr}${status}${ticketsStr}`);
    }
  }

  return lines.join("\n");
}
