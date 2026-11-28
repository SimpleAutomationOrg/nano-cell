// An agent's questions with options (viewer/ask.js): how a message is split
// into its text and its questions, and what the answer message says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitQuestions, answerText, allAnswered } from '../viewer/ask.js';

const block = q => 'Two things to settle.\n\n```questions\n' + JSON.stringify(q) + '\n```';

test('a questions block becomes questions; the rest stays text; the recommended option comes first', () => {
  const { text, questions } = splitQuestions(block([
    { question: 'Which package?', options: [{ label: 'DIP-8' }, { label: 'DIP-16', description: '16 pins', recommended: true }] },
    { question: 'Which pots?', multi: true, options: ['Flux', 'Solder', 'Cleaner'] },
  ]));
  assert.equal(text, 'Two things to settle.');
  assert.deepEqual(questions.map(q => q.options.map(o => o.label)), [['DIP-16', 'DIP-8'], ['Flux', 'Solder', 'Cleaner']]);
  assert.deepEqual(questions[0].options[0], { label: 'DIP-16', description: '16 pins', recommended: true });
  assert.deepEqual([questions[0].multi, questions[1].multi], [false, true]);
});

test('a message without a block, or with one that cannot be read, is shown as written', () => {
  assert.deepEqual(splitQuestions('Just an answer.'), { text: 'Just an answer.', questions: [] });
  const broken = 'Hmm.\n```questions\n[{"question": "x", options}]\n```';
  assert.deepEqual(splitQuestions(broken), { text: broken, questions: [] });
  // a question needs something to choose between
  const one = block([{ question: 'Sure?', options: [{ label: 'Yes' }] }]);
  assert.deepEqual(splitQuestions(one), { text: one, questions: [] });
  assert.equal(splitQuestions(block([{ question: 'A?', options: ['x', 'y'] }, { options: ['x', 'y'] }, { question: 'B?', options: [] }])).questions.length, 1);
});

test('the answer names each question and what was chosen or typed; unanswered ones are left out', () => {
  const { questions } = splitQuestions(block([
    { question: 'Which package?', options: ['DIP-16', 'DIP-8'] },
    { question: 'Which pots?', multi: true, options: ['Flux', 'Solder'] },
    { question: 'Where do they go?', options: ['Plate', 'Nests'] },
  ]));
  const picks = [{ labels: ['DIP-16'], other: '' }, { labels: ['Flux', 'Solder'], other: ' and a cleaner ' }, { labels: [], other: '' }];
  assert.equal(answerText(questions, picks), 'Which package?\n→ DIP-16\n\nWhich pots?\n→ Flux; Solder; and a cleaner');
  assert.equal(allAnswered(questions, picks), false);
  assert.equal(allAnswered(questions, [...picks.slice(0, 2), { labels: [], other: 'a tube' }]), true);
  assert.equal(answerText(questions, []), '', 'nothing chosen: nothing to send');
});
