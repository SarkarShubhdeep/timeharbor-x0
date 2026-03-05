import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import axios from 'axios';
import { buildJerryContext } from '../utils/jerryContext.js';
import { handleJerryAction } from '../utils/jerryActions.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma3:4b';

const ACTION_SCHEMA_TEXT = `
Jerry can optionally perform actions for the user. When the user explicitly asks you to create a ticket, clock in, clock out, start a ticket, update a ticket, or stop a ticket, you MUST respond with ONLY a JSON object (no extra text, NO backticks or code fences) using this schema.

This is CRITICAL:
- If the user says things like "start", "stop", "end", "pause", "resume", "clock in", "clock out", or "change/update a ticket", you MUST use an action JSON response.
- NEVER say things like "I started/stopped/updated the ticket" in natural language unless you actually responded with a JSON action object as described below.
- For general questions (e.g., "Which ticket am I working on?", "What did I work on last?"), answer in normal natural language and DO NOT output JSON.

Action schema:

{
  "action": "create_ticket" | "clock_in" | "clock_out" | "start_ticket" | "update_ticket" | "stop_ticket" | "assign_ticket" | "none",
  "parameters": {
    // for create_ticket:
    //   "teamName" or "teamCode": string
    //   "title": string
    //   "description"?: string
    //   "github": string        // REQUIRED: GitHub issue or PR link
    //
    // for clock_in:
    //   "teamName" or "teamCode": string
    //
    // for clock_out:
    //   "teamName" or "teamCode" (optional)
    //   "youtubeShortLink"?: string
    //
    // for start_ticket:
    //   // Start timing work on a specific ticket (and auto-clock-in to that team if needed)
    //   // Preferred:
    //   //   "ticketTitle": string           // title of the ticket to start
    //   //   "teamName" or "teamCode" (optional to disambiguate)
    //   // If the user clearly says "start my last worked ticket", you may omit ticketTitle and use:
    //   //   "lastWorked": true
    //   // You MAY also use "current": true here to mean "most relevant/last worked" when no title is given.
    //
    // for stop_ticket:
    //   // stop a single running ticket WITHOUT clocking out of the work session
    //   // Preferred:
    //   //   "current": true           // stop whichever ticket is currently running
    //   // Or:
    //   //   "ticketTitle": string     // title of the ticket to stop
    //   //   "teamName" or "teamCode" (optional to disambiguate)
    //
    // for update_ticket:
    //   // Prefer this more explicit form when renaming:
    //   //   "currentTitle": string   // current ticket title from context
    //   //   "newTitle"?: string      // new title to set
    //   // OR keep backward-compatible:
    //   //   "ticketTitle": string    // current ticket title
    //   // In both cases you may also provide:
    //   "teamName" or "teamCode" (optional to disambiguate)
    //   "fields": {
    //     // Use these for arbitrary property changes:
    //     "title"?: string,          // new title
    //     "description"?: string,
    //     "github"?: string
    //   }
    //
    // for assign_ticket:
    //   // Change or clear the assignee of a ticket.
    //   // You MUST first identify the ticket:
    //   //   "ticketTitle": string           // title of the ticket to change
    //   //   "teamName" or "teamCode" (optional but recommended to disambiguate)
    //   //
    //   // Then specify WHO to assign it to:
    //   //   "assigneeId"?: string          // preferred when you can see an internal user id in context
    //   //   "assigneeEmail"?: string       // or use an email address
    //   //   "assigneeName"?: string        // or a display name contained in the context (for example, "Shubh 0x").
    //   //   // When the user says "assign me" or "assign this to me",
    //   //   // use the CURRENT USER from the "Current user" section of the context.
    //   //
    //   // To UNASSIGN the ticket (no owner):
    //   //   "unassign": true               // and omit all assignee* fields
  }
}

If the user is ONLY asking a question and not requesting an action, reply in normal natural language and DO NOT output JSON.
`;

const JERRY_SYSTEM_PREFIX = `You are Jerry AI, the TimeHarbor assistant.

You have access to structured context about the CURRENT USER'S teams, tickets, and work sessions only. Never make up data that is not present in the context.

You can either:
- Answer questions in natural language, OR
- Propose a single action using the JSON schema below when the user explicitly wants you to create a ticket, clock in, clock out, START a ticket timer, update a ticket, or stop a ticket.

Important:
- Use \"start_ticket\" to start timing work on a ticket whose timer is not currently running. This will automatically clock the user in to that team if needed.
- Use \"stop_ticket\" ONLY to stop a single ticket's timer without ending the overall work session.
- Use \"clock_out\" ONLY when the user clearly wants to end their current work session.

${ACTION_SCHEMA_TEXT}

Here is the user's TimeHarbor context:

`;

export const ollamaMethods = {
  async 'ollama/chat'({ model, messages }) {
    check(messages, Array);
    if (model !== undefined) check(model, String);
    if (!this.userId) throw new Meteor.Error('not-authorized', 'You must be logged in to use the chat.');

    const contextString = await buildJerryContext(this.userId);
    const systemContent = JERRY_SYSTEM_PREFIX + contextString;
    const messagesWithContext = [
      { role: 'system', content: systemContent },
      ...messages,
    ];

    const baseUrl = (Meteor.settings.private?.ollama?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const resolvedModel = model || Meteor.settings.private?.ollama?.defaultModel || Meteor.settings.public?.ollama?.defaultModel || DEFAULT_MODEL;

    const url = `${baseUrl}/v1/chat/completions`;
    const body = { model: resolvedModel, messages: messagesWithContext };

    try {
      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ollama',
        },
        timeout: 120000,
        validateStatus: () => true,
      });

      if (response.status !== 200) {
        const errMsg = response.data?.error?.message || response.statusText || `Ollama returned ${response.status}`;
        throw new Meteor.Error('ollama-error', errMsg);
      }

      const data = response.data;
      const content = data?.choices?.[0]?.message?.content;
      if (content === undefined) {
        throw new Meteor.Error('ollama-error', 'Invalid response from Ollama');
      }

      let parsed = null;
      if (typeof content === 'string') {
        let raw = content.trim();

        // Handle common pattern where the model wraps JSON in ``` or ```json fences
        if (raw.startsWith('```')) {
          const firstNewline = raw.indexOf('\n');
          if (firstNewline !== -1) {
            raw = raw.slice(firstNewline + 1);
          }
          if (raw.endsWith('```')) {
            raw = raw.slice(0, -3);
          }
          raw = raw.trim();
        }

        if (raw.startsWith('{')) {
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            parsed = null;
          }
        }
      }

      if (parsed) {
        const actionResult = await handleJerryAction(parsed, this.userId);
        if (actionResult && typeof actionResult === 'object') {
          if (actionResult.ok) {
            return { content: actionResult.summary || 'I performed the requested action.' };
          }
          if (actionResult.message) {
            return { content: actionResult.message };
          }
        }
      }

      return { content };
    } catch (err) {
      if (err.response) {
        const msg = err.response.data?.error?.message || err.message;
        throw new Meteor.Error('ollama-error', msg);
      }
      if (err.code === 'ECONNREFUSED') {
        throw new Meteor.Error('ollama-unavailable', 'Ollama is not running. Start Ollama and try again.');
      }
      if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
        throw new Meteor.Error('ollama-error', 'Request to Ollama timed out.');
      }
      throw new Meteor.Error('ollama-error', err.message || 'Failed to get response from Ollama');
    }
  },
};

