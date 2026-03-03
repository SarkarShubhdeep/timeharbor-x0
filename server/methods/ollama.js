import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import axios from 'axios';
import { buildJerryContext } from '../utils/jerryContext.js';
import { handleJerryAction } from '../utils/jerryActions.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma3:4b';

const ACTION_SCHEMA_TEXT = `
Jerry can optionally perform actions for the user. When the user explicitly asks you to create a ticket, clock in, clock out, or update a ticket, you MUST respond with ONLY a JSON object (no extra text, NO backticks or code fences) using this schema:

{
  "action": "create_ticket" | "clock_in" | "clock_out" | "update_ticket" | "none",
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
    // for update_ticket:
    //   "ticketTitle": string
    //   "teamName" or "teamCode" (optional to disambiguate)
    //   "fields": {
    //     "title"?: string,
    //     "description"?: string,
    //     "github"?: string
    //   }
  }
}

If the user is ONLY asking a question and not requesting an action, reply in normal natural language and DO NOT output JSON.
`;

const JERRY_SYSTEM_PREFIX = `You are Jerry AI, the TimeHarbor assistant.

You have access to structured context about the CURRENT USER'S teams, tickets, and work sessions only. Never make up data that is not present in the context.

You can either:
- Answer questions in natural language, OR
- Propose a single action using the JSON schema below when the user explicitly wants you to create a ticket, clock in, clock out, or update a ticket.

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

