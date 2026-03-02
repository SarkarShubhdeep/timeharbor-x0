import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import axios from 'axios';
import { buildJerryContext } from '../utils/jerryContext.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma3:4b';

const JERRY_SYSTEM_PREFIX = `You are Jerry AI, the TimeHarbor assistant. Use only the following data about the user's tickets and work sessions to answer. If the question cannot be answered from this data, say so. Do not make up data.

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
