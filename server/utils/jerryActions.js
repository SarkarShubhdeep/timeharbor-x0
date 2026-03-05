import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Teams, Tickets, ClockEvents } from '../../collections.js';
import { ticketMethods } from '../methods/tickets.js';
import { clockEventMethods } from '../methods/clockEvents.js';
import { getUserDisplayName } from './userHelpers.js';

function normalizeTeamIdentifier({ teamName, teamCode }) {
  if (typeof teamCode === 'string' && teamCode.trim()) {
    return { by: 'code', value: teamCode.trim() };
  }
  if (typeof teamName === 'string' && teamName.trim()) {
    return { by: 'name', value: teamName.trim() };
  }
  return null;
}

async function resolveUserTeamId({ teamName, teamCode, userId }) {
  const ident = normalizeTeamIdentifier({ teamName, teamCode });
  if (!ident) {
    return { ok: false, message: 'You need to specify a team name or team code.' };
  }

  const query = {
    $and: [
      ident.by === 'code' ? { code: ident.value } : { name: ident.value },
      {
        $or: [
          { members: userId },
          { admins: userId },
        ],
      },
    ],
  };

  const teams = await Teams.find(query).fetchAsync();
  if (teams.length === 0) {
    return { ok: false, message: `I could not find a team ${ident.by === 'code' ? 'with code' : 'named'} "${ident.value}" that you belong to.` };
  }
  if (teams.length > 1) {
    return { ok: false, message: `There are multiple teams matching "${ident.value}". Please be more specific.` };
  }
  return { ok: true, team: teams[0] };
}

async function performCreateTicket(params, userId) {
  const { teamName, teamCode, title, description = '', github } = params || {};
  if (!title || typeof title !== 'string') {
    return { ok: false, message: 'I need a ticket title to create a ticket.' };
  }

  if (!github || typeof github !== 'string' || !github.trim()) {
    return { ok: false, message: 'I need a GitHub issue or PR link to create a ticket.' };
  }

  const teamResult = await resolveUserTeamId({ teamName, teamCode, userId });
  if (!teamResult.ok) return teamResult;
  const team = teamResult.team;

  const context = { userId };
  const args = {
    teamId: team._id,
    title: title.trim(),
    github: github.trim(),
    accumulatedTime: 0,
  };

  try {
    const ticketId = await ticketMethods.createTicket.call(context, args);
    if (description && typeof description === 'string' && description.trim()) {
      await Tickets.updateAsync(ticketId, { $set: { description: description.trim() } });
    }
    return {
      ok: true,
      summary: `I created a new ticket "${args.title}" in team "${team.name || team.code || team._id}".`,
      details: { ticketId, teamId: team._id },
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.reason || error?.message || 'I could not create that ticket.',
    };
  }
}

async function performClockIn(params, userId) {
  const { teamName, teamCode } = params || {};
  const teamResult = await resolveUserTeamId({ teamName, teamCode, userId });
  if (!teamResult.ok) return teamResult;
  const team = teamResult.team;

  try {
    const context = { userId };
    const clockEventId = await clockEventMethods.clockEventStart.call(context, team._id);
    return {
      ok: true,
      summary: `You are now clocked in to team "${team.name || team.code || team._id}".`,
      details: { clockEventId, teamId: team._id },
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.reason || error?.message || 'I could not clock you in.',
    };
  }
}

async function performClockOut(params, userId) {
  const { teamName, teamCode, youtubeShortLink } = params || {};

  let teamIdToUse = null;
  let teamLabel = '';

  if (teamName || teamCode) {
    const teamResult = await resolveUserTeamId({ teamName, teamCode, userId });
    if (!teamResult.ok) return teamResult;
    teamIdToUse = teamResult.team._id;
    teamLabel = teamResult.team.name || teamResult.team.code || teamResult.team._id;
  } else {
    const openEvents = await ClockEvents.find({
      userId,
      endTime: null,
    }).fetchAsync();
    if (openEvents.length === 0) {
      return { ok: false, message: 'You are not currently clocked in to any team.' };
    }
    if (openEvents.length > 1) {
      return { ok: false, message: 'You are clocked in to multiple teams. Please specify which team to clock out of.' };
    }
    const event = openEvents[0];
    teamIdToUse = event.teamId;
    const team = await Teams.findOneAsync(teamIdToUse);
    teamLabel = team?.name || team?.code || teamIdToUse;
  }

  try {
    const context = { userId };
    await clockEventMethods.clockEventStop.call(context, teamIdToUse, typeof youtubeShortLink === 'string' ? youtubeShortLink.trim() : undefined);
    return {
      ok: true,
      summary: `I clocked you out of team "${teamLabel}".`,
      details: { teamId: teamIdToUse },
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.reason || error?.message || 'I could not clock you out.',
    };
  }
}

async function performStartTicket(params, userId) {
  const { ticketTitle, teamName, teamCode, current, lastWorked } = params || {};
  const now = Date.now();

  // Resolve team if explicitly provided (helps disambiguate)
  let resolvedTeam = null;
  if (teamName || teamCode) {
    const teamResult = await resolveUserTeamId({ teamName, teamCode, userId });
    if (!teamResult.ok) return teamResult;
    resolvedTeam = teamResult.team;
  }

  // Locate the ticket to start
  let ticket = null;

  if (ticketTitle && typeof ticketTitle === 'string' && ticketTitle.trim()) {
    const query = {
      createdBy: userId,
      title: ticketTitle.trim(),
    };
    if (resolvedTeam) {
      query.teamId = resolvedTeam._id;
    }
    const tickets = await Tickets.find(query).fetchAsync();
    if (tickets.length === 0) {
      return {
        ok: false,
        message: `I could not find a ticket titled "${ticketTitle.trim()}" that you created. Please double-check the title and, if needed, specify the team.`,
      };
    }
    if (tickets.length > 1 && !resolvedTeam) {
      return {
        ok: false,
        message: `There are multiple tickets titled "${ticketTitle.trim()}". Please specify the team name or code so I know which one to start.`,
      };
    }
    ticket = tickets[0];
  } else if (lastWorked || current) {
    // Fallback when the user says "start my last worked/current ticket" without a title.
    const query = {
      createdBy: userId,
    };
    if (resolvedTeam) {
      query.teamId = resolvedTeam._id;
    }
    const candidates = await Tickets.find(query, {
      sort: {
        startTimestamp: -1,
        updatedAt: -1,
        createdAt: -1,
      },
      limit: 1,
    }).fetchAsync();

    if (!candidates || candidates.length === 0) {
      return {
        ok: false,
        message: 'I could not find any ticket you have worked on recently. Please specify the ticket title.',
      };
    }
    ticket = candidates[0];
  } else {
    return {
      ok: false,
      message: 'I need either a ticket title, or permission to use your most recently worked ticket, in order to start it.',
    };
  }

  // Fetch / infer team for messaging
  const team = resolvedTeam || (ticket.teamId ? await Teams.findOneAsync(ticket.teamId) : null);
  const teamLabel = team?.name || team?.code || ticket.teamId || 'your team';

  // If ticket is already running, just report that fact
  if (typeof ticket.startTimestamp === 'number') {
    return {
      ok: true,
      summary: `Ticket "${ticket.title}" in team "${teamLabel}" is already running.`,
      details: { ticketId: ticket._id, teamId: ticket.teamId },
    };
  }

  try {
    // Ensure there is an active clock event for this team; create one if needed
    let clockEvent = await ClockEvents.findOneAsync({
      userId,
      teamId: ticket.teamId,
      endTime: null,
    });

    if (!clockEvent) {
      const clockContext = { userId };
      const clockEventId = await clockEventMethods.clockEventStart.call(clockContext, ticket.teamId);
      clockEvent = await ClockEvents.findOneAsync(clockEventId);
    }

    const context = { userId };
    await ticketMethods.updateTicketStart.call(context, ticket._id, now);
    if (clockEvent?._id) {
      await clockEventMethods.clockEventAddTicket.call(context, clockEvent._id, ticket._id, now);
    }

    return {
      ok: true,
      summary: `I started ticket "${ticket.title}" in team "${teamLabel}".`,
      details: { ticketId: ticket._id, teamId: ticket.teamId, clockEventId: clockEvent?._id || null },
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.reason || error?.message || 'I could not start that ticket.',
    };
  }
}

async function performStopTicket(params, userId) {
  const { ticketTitle, current, teamName, teamCode } = params || {};
  const now = Date.now();

  // Resolve team if provided (helps disambiguate when multiple sessions are active)
  let team = null;
  if (teamName || teamCode) {
    const teamResult = await resolveUserTeamId({ teamName, teamCode, userId });
    if (!teamResult.ok) return teamResult;
    team = teamResult.team;
  }

  // Find active clock event(s) for this user (optionally narrowed by team)
  const clockEventQuery = {
    userId,
    endTime: null,
  };
  if (team) {
    clockEventQuery.teamId = team._id;
  }

  const activeEvents = await ClockEvents.find(clockEventQuery).fetchAsync();
  if (activeEvents.length === 0) {
    return { ok: false, message: 'You are not currently clocked in to any team, so there is no running ticket to stop.' };
  }
  if (activeEvents.length > 1 && !team) {
    return { ok: false, message: 'You have active work sessions in multiple teams. Please specify the team name or code for the ticket you want to stop.' };
  }

  const clockEvent = activeEvents[0];
  const teamLabel = team?.name || team?.code || clockEvent.teamId;

  // Find the running ticket(s) for this clock event/team
  let runningTickets;
  const trimmedTitle = typeof ticketTitle === 'string' ? ticketTitle.trim() : '';
  if (trimmedTitle) {
    // Target by title, but only tickets that are currently running
    runningTickets = await Tickets.find({
      teamId: clockEvent.teamId,
      createdBy: userId,
      title: trimmedTitle,
      startTimestamp: { $exists: true },
    }).fetchAsync();
  } else {
    // Use "current" ticket: any ticket with a running timer for this team
    runningTickets = await Tickets.find({
      teamId: clockEvent.teamId,
      createdBy: userId,
      startTimestamp: { $exists: true },
    }).fetchAsync();
  }

  if (!runningTickets || runningTickets.length === 0) {
    return { ok: false, message: 'I could not find any running ticket to stop. Make sure the ticket timer is active.' };
  }

  // When multiple tickets are running, pick the most recently started one.
  // This matches the idea of "current" or "the ticket I am working on now".
  runningTickets.sort((a, b) => {
    const aStart = typeof a.startTimestamp === 'number' ? a.startTimestamp : 0;
    const bStart = typeof b.startTimestamp === 'number' ? b.startTimestamp : 0;
    return bStart - aStart;
  });

  const ticket = runningTickets[0];

  try {
    const context = { userId };
    // Stop ticket timer on Tickets collection
    await ticketMethods.updateTicketStop.call(context, ticket._id, now);

    // Also stop it inside the active clock event so sessions data stays consistent
    await clockEventMethods.clockEventStopTicket.call(context, clockEvent._id, ticket._id, now);

    return {
      ok: true,
      summary: `I stopped ticket "${ticket.title}" in team "${teamLabel}" without ending your work session.`,
      details: { ticketId: ticket._id, teamId: clockEvent.teamId, clockEventId: clockEvent._id },
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.reason || error?.message || 'I could not stop that ticket.',
    };
  }
}

async function performUpdateTicket(params, userId) {
  const { ticketTitle, currentTitle, newTitle, teamName, teamCode, fields } = params || {};

  const lookupTitle = (currentTitle || ticketTitle || '').trim();
  if (!lookupTitle) {
    return { ok: false, message: 'I need the current ticket title to update a ticket.' };
  }

  const ticketQuery = {
    createdBy: userId,
    title: lookupTitle,
  };

  if (teamName || teamCode) {
    const teamResult = await resolveUserTeamId({ teamName, teamCode, userId });
    if (!teamResult.ok) return teamResult;
    ticketQuery.teamId = teamResult.team._id;
  }

  const tickets = await Tickets.find(ticketQuery).fetchAsync();
  if (tickets.length === 0) {
    return {
      ok: false,
      message: `I could not find a ticket titled "${lookupTitle}" that you created. Please double-check the current title and, if necessary, specify the team name.`,
    };
  }
  if (tickets.length > 1) {
    return {
      ok: false,
      message: `There are multiple tickets titled "${lookupTitle}". Please specify the team name so I know which one to update.`,
    };
  }

  const ticket = tickets[0];
  const allowedFields = {};
  if (fields && typeof fields === 'object') {
    const { title, description, github } = fields;
    if (typeof title === 'string' && title.trim()) allowedFields.title = title.trim();
    if (typeof description === 'string') allowedFields.description = description.trim();
    if (typeof github === 'string') allowedFields.github = github.trim();
  }

  // If the model provided a separate newTitle, prefer that when title is not already set
  if (!allowedFields.title && typeof newTitle === 'string' && newTitle.trim()) {
    allowedFields.title = newTitle.trim();
  }

  if (Object.keys(allowedFields).length === 0) {
    return { ok: false, message: 'No valid fields to update were provided (e.g., new title, description, or GitHub link).' };
  }

  try {
    const context = { userId };
    await ticketMethods.updateTicket.call(context, ticket._id, allowedFields);
    const team = await Teams.findOneAsync(ticket.teamId);
    const teamLabel = team?.name || team?.code || ticket.teamId;
    return {
      ok: true,
      summary: `I updated ticket "${ticket.title}" in team "${teamLabel}".`,
      details: { ticketId: ticket._id, teamId: ticket.teamId, updatedFields: Object.keys(allowedFields) },
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.reason || error?.message || 'I could not update that ticket.',
    };
  }
}

async function performAssignTicket(params, userId) {
  const {
    ticketTitle,
    teamName,
    teamCode,
    assigneeName,
    assigneeEmail,
    assigneeId,
    unassign,
  } = params || {};

  const lookupTitle = (ticketTitle || '').trim();
  if (!lookupTitle) {
    return { ok: false, message: 'I need the ticket title to change its assignment.' };
  }

  // Resolve team first so we only look inside one team
  let teamResult = null;
  if (teamName || teamCode) {
    teamResult = await resolveUserTeamId({ teamName, teamCode, userId });
    if (!teamResult.ok) return teamResult;
  }

  const ticketQuery = {
    title: lookupTitle,
  };
  if (teamResult?.team?._id) {
    ticketQuery.teamId = teamResult.team._id;
  }

  const tickets = await Tickets.find(ticketQuery).fetchAsync();
  if (tickets.length === 0) {
    return {
      ok: false,
      message: `I could not find a ticket titled "${lookupTitle}". Please double-check the title and, if needed, specify the team.`,
    };
  }
  if (tickets.length > 1 && !ticketQuery.teamId) {
    return {
      ok: false,
      message: `There are multiple tickets titled "${lookupTitle}". Please specify the team name or code so I know which one to update.`,
    };
  }

  const ticket = tickets[0];
  const team = teamResult?.team || (ticket.teamId ? await Teams.findOneAsync(ticket.teamId) : null);
  const teamLabel = team?.name || team?.code || ticket.teamId;

  // Resolve assignee
  let targetUserId = null;
  let targetName = null;

  const currentUser = await Meteor.users.findOneAsync(userId);
  const selfDisplayName = getUserDisplayName(currentUser, '').toLowerCase();
  const selfUsername = (currentUser?.username || '').toLowerCase();
  const selfEmail = (currentUser?.emails?.[0]?.address || '').toLowerCase();

  if (unassign === true) {
    targetUserId = null;
  } else if (assigneeId && typeof assigneeId === 'string') {
    const user = await Meteor.users.findOneAsync(assigneeId);
    if (!user) {
      return { ok: false, message: 'I could not find that user to assign the ticket.' };
    }
    targetUserId = assigneeId;
    targetName = getUserDisplayName(user, 'the user');
  } else if (assigneeEmail || assigneeName) {
    if (!team) {
      return { ok: false, message: 'To assign by name or email, I need to know which team this ticket belongs to. Please repeat your request and include the team name or code.' };
    }
    const memberIds = [
      ...(team.members || []),
      ...(team.admins || []),
    ];
    const candidates = await Meteor.users
      .find({ _id: { $in: memberIds } })
      .fetchAsync();

    const emailLower = assigneeEmail ? String(assigneeEmail).toLowerCase() : null;
    const nameLower = assigneeName ? String(assigneeName).toLowerCase() : null;

    // Special-case "me" / self references
    if (nameLower && ['me', 'myself', 'current user', 'the current user'].includes(nameLower)) {
      targetUserId = userId;
      targetName = getUserDisplayName(currentUser, 'you');
    } else if (
      nameLower &&
      (nameLower === selfDisplayName || (selfDisplayName && selfDisplayName.includes(nameLower)) || nameLower === selfUsername)
    ) {
      targetUserId = userId;
      targetName = getUserDisplayName(currentUser, 'you');
    } else if (emailLower && emailLower === selfEmail) {
      targetUserId = userId;
      targetName = getUserDisplayName(currentUser, 'you');
    }

    if (targetUserId) {
      // We already resolved to the current user; skip searching other members.
    } else {

      const matches = candidates.filter((user) => {
        const displayName = getUserDisplayName(user, '').toLowerCase();
        const userEmail = (user.emails?.[0]?.address || '').toLowerCase();
        if (emailLower && userEmail === emailLower) return true;
        if (nameLower && displayName && displayName.includes(nameLower)) return true;
        return false;
      });

      if (matches.length === 0) {
        return {
          ok: false,
          message: `I could not find a team member matching "${assigneeName || assigneeEmail}". Please use the exact name or email of a member of team "${teamLabel}".`,
        };
      }
      if (matches.length > 1) {
        const names = matches.map((u) => getUserDisplayName(u, 'Unknown')).join(', ');
        return {
          ok: false,
          message: `There are multiple team members matching "${assigneeName || assigneeEmail}": ${names}. Please be more specific (for example, specify their email).`,
        };
      }

      const user = matches[0];
      targetUserId = user._id;
      targetName = getUserDisplayName(user, 'the user');
    }
  } else {
    return {
      ok: false,
      message: 'To change assignment, please tell me who to assign it to (by name or email), or say you want it unassigned.',
    };
  }

  try {
    const context = { userId };
    await ticketMethods.assignTicket.call(context, ticket._id, targetUserId || null);

    if (targetUserId) {
      return {
        ok: true,
        summary: `I assigned ticket "${ticket.title}" in team "${teamLabel}" to ${targetName}.`,
        details: { ticketId: ticket._id, teamId: ticket.teamId, assignedTo: targetUserId },
      };
    }

    return {
      ok: true,
      summary: `I unassigned ticket "${ticket.title}" in team "${teamLabel}".`,
      details: { ticketId: ticket._id, teamId: ticket.teamId, assignedTo: null },
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.reason || error?.message || 'I could not change the assignment for that ticket.',
    };
  }
}

export async function handleJerryAction(actionObject, userId) {
  if (!actionObject || typeof actionObject !== 'object') {
    return null;
  }

  const { action, parameters } = actionObject;
  if (!action || typeof action !== 'string') return null;

  const normalized = action.trim().toLowerCase();
  if (normalized === 'none') return null;

  check(userId, String);

  switch (normalized) {
    case 'create_ticket':
      return await performCreateTicket(parameters, userId);
    case 'clock_in':
      return await performClockIn(parameters, userId);
    case 'clock_out':
      return await performClockOut(parameters, userId);
    case 'start_ticket':
      return await performStartTicket(parameters, userId);
    case 'update_ticket':
      return await performUpdateTicket(parameters, userId);
    case 'stop_ticket':
      return await performStopTicket(parameters, userId);
    case 'assign_ticket':
      return await performAssignTicket(parameters, userId);
    default:
      return null;
  }
}

