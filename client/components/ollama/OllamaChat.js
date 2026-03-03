import { Template } from 'meteor/templating';
import { ReactiveVar } from 'meteor/reactive-var';
import { Tracker } from 'meteor/tracker';

const panelOpen = new ReactiveVar(false);
const messages = new ReactiveVar([]);
const isLoading = new ReactiveVar(false);
const errorMessage = new ReactiveVar('');
const panelMode = new ReactiveVar(false); // false = floating, true = full-height side panel

const PANEL_MODE_KEY = 'jerry-chat-mode';

function getDefaultModel() {
  return Meteor.settings.public?.ollama?.defaultModel || 'gemma3:4b';
}

if (Template.ollamaChat) {
  Template.ollamaChat.onCreated(function () {
    messages.set([]);
    errorMessage.set('');

    // Restore preferred layout mode
    try {
      const saved = (typeof localStorage !== 'undefined') ? localStorage.getItem(PANEL_MODE_KEY) : null;
      panelMode.set(saved === 'panel');
    } catch (e) {
      panelMode.set(false);
    }
  });

  Template.ollamaChat.helpers({
    panelOpen() {
      return panelOpen.get();
    },
    panelMode() {
      return panelMode.get();
    },
    messages() {
      return messages.get().map((m) => ({
        ...m,
        isUser: m.role === 'user',
      }));
    },
    hasNoMessages() {
      return messages.get().length === 0 && !isLoading.get();
    },
    isLoading() {
      return isLoading.get();
    },
    errorMessage() {
      return errorMessage.get();
    },
    disabledWhileLoading() {
      return isLoading.get() ? { disabled: true } : {};
    },
  });

  Template.ollamaChat.onRendered(function () {
    const self = this;
    self.autorun(() => {
      messages.get();
      Tracker.afterFlush(() => {
        const el = self.find('.ollama-chat-messages');
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  });

  Template.ollamaChat.events({
    'click .ollama-chat-toggle'() {
      panelOpen.set(!panelOpen.get());
      errorMessage.set('');
    },
    'click .ollama-chat-expand'() {
      panelMode.set(true);
      panelOpen.set(true);
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(PANEL_MODE_KEY, 'panel');
        }
      } catch (e) {
        // ignore storage errors
      }
    },
    'click .ollama-chat-collapse'() {
      panelMode.set(false);
      panelOpen.set(true);
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(PANEL_MODE_KEY, 'floating');
        }
      } catch (e) {
        // ignore storage errors
      }
    },
    'click .ollama-chat-close'() {
      panelOpen.set(false);
    },
    'submit .ollama-chat-form'(event) {
      event.preventDefault();
      const input = event.target.querySelector('.ollama-chat-input');
      const text = (input && input.value || '').trim();
      if (!text || isLoading.get()) return;

      const list = messages.get();
      list.push({ role: 'user', content: text });
      messages.set(list);
      if (input) input.value = '';
      errorMessage.set('');
      isLoading.set(true);

      const model = getDefaultModel();
      Meteor.call('ollama/chat', { model, messages: list }, (err, result) => {
        isLoading.set(false);
        if (err) {
          errorMessage.set(err.reason || err.message || 'Request failed');
          return;
        }
        const next = messages.get();
        next.push({ role: 'assistant', content: result?.content || '' });
        messages.set(next);
      });
    },
  });
}
