// Questions with options, the way an agent asks them in the chat.
//
// An agent that needs a decision ends its message with a block
//
//   ```questions
//   [{ "question": "Which package?", "options": [
//        { "label": "DIP-16", "description": "the common one", "recommended": true },
//        { "label": "DIP-8" } ] }]
//   ```
//
// and the page shows each question with its options as buttons (the
// recommended one first and marked), plus a field for an answer in the
// user's own words. Pure (no DOM): chat.js draws it, the tests cover it.

const BLOCK = /```questions\s*\n([\s\S]*?)```/;

/**
 * Split an agent's message into its text and the questions it asks.
 * Returns { text, questions } — questions is [] when there is no block or
 * it cannot be read (the block then stays in the text, shown as written).
 * Each question: { question, multi, options: [{ label, description, recommended }] },
 * with the recommended option first.
 */
export function splitQuestions(message) {
  const m = BLOCK.exec(message);
  if (!m) return { text: message, questions: [] };
  let raw;
  try { raw = JSON.parse(m[1]); } catch { return { text: message, questions: [] }; }
  const questions = (Array.isArray(raw) ? raw : [raw]).map(q => {
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map(o => (typeof o === 'string' ? { label: o } : o))
      .filter(o => o && typeof o.label === 'string' && o.label.trim())
      .map(o => ({ label: o.label.trim(), description: typeof o.description === 'string' ? o.description.trim() : '', recommended: o.recommended === true }));
    options.sort((a, b) => Number(b.recommended) - Number(a.recommended));     // stable: recommended first
    return { question: typeof q?.question === 'string' ? q.question.trim() : '', multi: q?.multi === true, options };
  }).filter(q => q.question && q.options.length >= 2).slice(0, 6);
  if (!questions.length) return { text: message, questions: [] };
  return { text: (message.slice(0, m.index) + message.slice(m.index + m[0].length)).trim(), questions };
}

/**
 * The message that answers the questions. `picks[i]` is what was chosen for
 * question i: { labels: [...], other: 'typed text' }. A question with
 * neither is left out. Returns '' when nothing was answered.
 */
export function answerText(questions, picks) {
  const lines = [];
  questions.forEach((q, i) => {
    const p = picks[i] ?? {};
    const parts = [...(p.labels ?? []), ...(p.other?.trim() ? [p.other.trim()] : [])];
    if (parts.length) lines.push(`${q.question}\n→ ${parts.join('; ')}`);
  });
  return lines.join('\n\n');
}

/** Is every question answered (an option picked, or something typed)? */
export function allAnswered(questions, picks) {
  return questions.every((q, i) => (picks[i]?.labels?.length ?? 0) > 0 || !!picks[i]?.other?.trim());
}
