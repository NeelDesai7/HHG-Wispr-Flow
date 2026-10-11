// The Ask tab: ask questions about your own tasks; Gemma answers on-device from the task list.
import { $, el, api } from './dom.js';

const EXAMPLES = [
  'What did I promise people this week?',
  'What’s overdue?',
  'What do I have to do tomorrow?',
  'Which tasks involve money?',
  'What have I finished today?',
];

async function ask(question) {
  const answer = $('#ask-answer');
  const qa = el('div', { className: 'qa' },
    el('div', { className: 'q', textContent: question }),
    el('div', { className: 'a think', textContent: 'Thinking on-device…' }));
  answer.append(qa);
  answer.scrollTop = answer.scrollHeight;
  try {
    const r = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question }) });
    qa.querySelector('.a').className = 'a';
    qa.querySelector('.a').textContent = r.answer || '(no answer)';
    qa.append(el('div', { className: 'meta', textContent: `Gemma · on-device · ${(r.ms / 1000).toFixed(1)}s · from ${r.taskCount} tasks` }));
  } catch (err) {
    const a = qa.querySelector('.a');
    a.className = 'a';
    a.textContent = err.message.includes('not ready') || err.message.includes('model')
      ? 'The on-device model isn’t ready yet. Make sure Ollama is running (see Settings).'
      : `Couldn’t answer: ${err.message}`;
  }
  answer.scrollTop = answer.scrollHeight;
}

export function initAsk() {
  const form = $('#ask-form');
  const input = $('#ask-input');
  $('#ask-examples').replaceChildren(...EXAMPLES.map((q) => {
    const b = el('button', { type: 'button', className: 'ex', textContent: q });
    b.addEventListener('click', () => { input.value = q; form.requestSubmit(); });
    return b;
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    $('#ask-send').disabled = true;
    await ask(q);
    $('#ask-send').disabled = false;
    input.focus();
  });
}
