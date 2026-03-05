import { Meteor } from "meteor/meteor";
import { Teams, Tickets, ClockEvents } from "../../collections.js";
import { formatDurationText } from "./ClockEventHelpers.js";
import { getUserDisplayName, getUserDisplayEmail } from "./userHelpers.js";

const MAX_TICKETS = 50;
const MAX_CLOCK_EVENTS = 30;

function formatDate(ms) {
    if (typeof ms !== "number" || Number.isNaN(ms)) return "?";
    const d = new Date(ms);
    return d.toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
    });
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

    const allTickets = await Tickets.find({
        teamId: { $in: teamIds },
    }).fetchAsync();
    const tickets = allTickets.slice(0, MAX_TICKETS);
    const allTicketMap = new Map(allTickets.map((t) => [t._id, t]));

    const clockEvents = await ClockEvents.find(
        { userId },
        { sort: { startTimestamp: -1 }, limit: MAX_CLOCK_EVENTS },
    ).fetchAsync();

    const now = Date.now();

    // Current user profile (for "me" / identity questions)
    const currentUser = await Meteor.users.findOneAsync(userId);
    const currentDisplayName = getUserDisplayName(currentUser, "Unknown User");
    const currentEmail = getUserDisplayEmail(currentUser, "No email");
    const currentUsername = currentUser?.username || "";

    // Team members (for assignment / "who is X" questions)
    const memberIdSet = new Set();
    for (const team of teams) {
        for (const id of team.members || []) memberIdSet.add(id);
        for (const id of team.admins || []) memberIdSet.add(id);
    }
    memberIdSet.delete(userId);
    const memberIds = Array.from(memberIdSet);
    const members = memberIds.length
        ? await Meteor.users
              .find(
                  { _id: { $in: memberIds } },
                  { fields: { profile: 1, username: 1, emails: 1 } },
              )
              .fetchAsync()
        : [];
    const memberMap = new Map(members.map((u) => [u._id, u]));

    // Derive running tickets (active timers)
    const runningTickets = allTickets.filter(
        (t) => typeof t.startTimestamp === "number",
    );

    // Derive \"last worked\" timestamp per ticket from clock event sessions
    const lastWorkedMap = new Map(); // ticketId -> ms
    for (const e of clockEvents) {
        const entries = Array.isArray(e.tickets) ? e.tickets : [];
        for (const entry of entries) {
            const ticketId = entry.ticketId;
            if (!ticketId) continue;
            const sessions = Array.isArray(entry.sessions)
                ? entry.sessions
                : [];
            let candidateTimes = [];
            for (const s of sessions) {
                const start =
                    typeof s.startTimestamp === "number"
                        ? s.startTimestamp
                        : null;
                const end =
                    typeof s.endTimestamp === "number" ? s.endTimestamp : null;
                if (start != null || end != null) {
                    const effectiveEnd = end != null ? end : now;
                    candidateTimes.push(effectiveEnd);
                }
            }
            // Fallback: if no sessions but a startTimestamp exists, treat that as last worked
            if (
                candidateTimes.length === 0 &&
                typeof entry.startTimestamp === "number"
            ) {
                candidateTimes.push(now);
            }
            if (candidateTimes.length > 0) {
                const latest = Math.max(...candidateTimes);
                const prev = lastWorkedMap.get(ticketId) || 0;
                if (latest > prev) {
                    lastWorkedMap.set(ticketId, latest);
                }
            }
        }
    }

    // Strengthen last-worked signals using ticket-level hints
    for (const t of allTickets) {
        let hint = null;
        if (typeof t.startTimestamp === "number") {
            // Currently running ticket – treat as "worked right now"
            hint = now;
        } else if (t.updatedAt instanceof Date) {
            hint = t.updatedAt.getTime();
        }
        if (hint != null) {
            const prev = lastWorkedMap.get(t._id) || 0;
            if (hint > prev) {
                lastWorkedMap.set(t._id, hint);
            }
        }
    }

    // Determine most recently worked ticket (by lastWorkedMap)
    let mostRecentTicketId = null;
    let mostRecentWorkedAt = 0;
    for (const [ticketId, ts] of lastWorkedMap.entries()) {
        if (ts > mostRecentWorkedAt) {
            mostRecentWorkedAt = ts;
            mostRecentTicketId = ticketId;
        }
    }

    // Determine most recently started running ticket
    const sortedRunning = [...runningTickets].sort((a, b) => {
        const aStart =
            typeof a.startTimestamp === "number" ? a.startTimestamp : 0;
        const bStart =
            typeof b.startTimestamp === "number" ? b.startTimestamp : 0;
        return bStart - aStart;
    });
    const currentRunning = sortedRunning[0] || null;

    const lines = [];

    // Current user
    lines.push("## Current user");
    lines.push(`- id: ${userId}`);
    lines.push(`- name: ${currentDisplayName}`);
    if (currentUsername) lines.push(`- username: ${currentUsername}`);
    lines.push(`- email: ${currentEmail}`);

    // Teams
    lines.push("## Teams");
    for (const t of teams) {
        lines.push(`- ${t.name || "Unnamed"} (code: ${t.code || "—"})`);
    }

    // Team members grouped by team
    lines.push("\n## Team members (by team)");
    for (const t of teams) {
        const ids = [...(t.members || []), ...(t.admins || [])].filter(
            (id) => id && id !== userId,
        );
        if (ids.length === 0) continue;
        lines.push(`- Team: ${t.name || "Unnamed"} (code: ${t.code || "—"})`);
        let count = 0;
        for (const id of ids) {
            const u = memberMap.get(id);
            if (!u) continue;
            const name = getUserDisplayName(u, "Unknown User");
            const email = getUserDisplayEmail(u, "No email");
            const uname = u.username ? `, username: ${u.username}` : "";
            lines.push(`  - ${name} (email: ${email}${uname}, id: ${id})`);
            count += 1;
            if (count >= 15) break; // avoid huge prompts
        }
    }

    // Active tickets (current timers)
    lines.push("\n## Active tickets (currently running)");
    if (runningTickets.length === 0) {
        lines.push("- None");
    } else {
        for (const t of sortedRunning) {
            const team = teamMap.get(t.teamId);
            const teamName = team?.name || "?";
            const baseSec = t.accumulatedTime || 0;
            const startMs =
                typeof t.startTimestamp === "number" ? t.startTimestamp : null;
            const extraSec = startMs ? Math.floor((now - startMs) / 1000) : 0;
            const totalRunningSec = baseSec + extraSec;
            const duration = formatDurationText(totalRunningSec);
            const title = (t.title || "Untitled").replace(/\n/g, " ");
            const marker =
                currentRunning && currentRunning._id === t._id
                    ? " (most recently started)"
                    : "";
            lines.push(
                `- "${title}" | Running for ${duration} | Team: ${teamName}${marker}`,
            );
        }
    }

    if (mostRecentTicketId && allTicketMap.has(mostRecentTicketId)) {
        const t = allTicketMap.get(mostRecentTicketId);
        const team = teamMap.get(t.teamId);
        const teamName = team?.name || "?";
        lines.push(
            `\nMost recently worked ticket: "${t.title || "Untitled"}" in team ${teamName} at ${formatDate(mostRecentWorkedAt)}.`,
        );
    }

    // All tickets (summary with last-worked time where available)
    lines.push("\n## Tickets");
    if (tickets.length === 0) {
        lines.push("- None");
    } else {
        for (const t of tickets) {
            const team = teamMap.get(t.teamId);
            const teamName = team?.name || "?";
            const sec = t.accumulatedTime || 0;
            const duration = formatDurationText(sec);
            const createdByMe =
                t.createdBy === userId ? " (created by me)" : "";
            const title = (t.title || "Untitled").replace(/\n/g, " ");
            const desc = t.description
                ? ` | ${String(t.description).slice(0, 80).replace(/\n/g, " ")}`
                : "";
            const lastWorkedMs = lastWorkedMap.get(t._id);
            const lastWorkedStr = lastWorkedMs
                ? formatDate(lastWorkedMs)
                : "never";
            lines.push(
                `- "${title}"${desc} | Total: ${duration} | Last worked: ${lastWorkedStr} | Team: ${teamName}${createdByMe}`,
            );
        }
    }

    // Recent work sessions
    lines.push("\n## Recent work sessions");
    if (clockEvents.length === 0) {
        lines.push("- None");
    } else {
        for (const e of clockEvents) {
            const team = teamMap.get(e.teamId);
            const teamName = team?.name || "?";
            const startStr = formatDate(e.startTimestamp);
            const isActive = e.endTime == null;
            let durationSec = e.accumulatedTime || 0;
            if (isActive && e.startTimestamp) {
                durationSec = Math.floor((now - e.startTimestamp) / 1000);
            } else if (e.endTime && e.startTimestamp) {
                const endMs =
                    e.endTime instanceof Date ? e.endTime.getTime() : e.endTime;
                durationSec = Math.floor((endMs - e.startTimestamp) / 1000);
            }
            const durationStr = formatDurationText(durationSec);
            const status = isActive ? " (in progress)" : "";
            const ticketTitles = (e.tickets || [])
                .map((ent) => allTicketMap.get(ent.ticketId)?.title || "?")
                .filter(Boolean);
            const ticketsStr =
                ticketTitles.length > 0
                    ? ` | Tickets: ${ticketTitles.join(", ")}`
                    : "";
            lines.push(
                `- ${startStr} – ${teamName} | ${durationStr}${status}${ticketsStr}`,
            );
        }
    }

    return lines.join("\n");
}
