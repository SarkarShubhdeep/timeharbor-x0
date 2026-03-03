import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Teams, Tickets } from '../../collections.js';
import { ticketMethods } from '../methods/tickets.js';
import { clockEventMethods } from '../methods/clockEvents.js';

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

async function performUpdateTicket(params, userId) {
  const { ticketTitle, teamName, teamCode, fields } = params || {};
  if (!ticketTitle || typeof ticketTitle !== 'string') {
    return { ok: false, message: 'I need the ticket title to update a ticket.' };
  }

  const ticketQuery = {
    createdBy: userId,
    title: ticketTitle.trim(),
  };

  if (teamName || teamCode) {
    const teamResult = await resolveUserTeamId({ teamName, teamCode, userId });
    if (!teamResult.ok) return teamResult;
    ticketQuery.teamId = teamResult.team._id;
  }

  const tickets = await Tickets.find(ticketQuery).fetchAsync();
  if (tickets.length === 0) {
    return { ok: false, message: `I could not find a ticket titled "${ticketTitle}" that you created.` };
  }
  if (tickets.length > 1) {
    return { ok: false, message: `There are multiple tickets titled "${ticketTitle}". Please specify the team name.` };
  }

  const ticket = tickets[0];
  const allowedFields = {};
  if (fields && typeof fields === 'object') {
    const { title, description, github } = fields;
    if (typeof title === 'string' && title.trim()) allowedFields.title = title.trim();
    if (typeof description === 'string') allowedFields.description = description.trim();
    if (typeof github === 'string') allowedFields.github = github.trim();
  }

  if (Object.keys(allowedFields).length === 0) {
    return { ok: false, message: 'No valid fields to update were provided.' };
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
    case 'update_ticket':
      return await performUpdateTicket(parameters, userId);
    default:
      return null;
  }
}

