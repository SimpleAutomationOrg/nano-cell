---
order: 5
title: Costing
when: working out what an application costs — the budget
---

# Costing: the budget

Keep the budget of an application: what it costs to build, and what is
still unknown.

- Your source is `applications/<application>/notes/purchasing.md`, plus
  what the application itself has in `grippers/`, `items/` and
  `layout.json` (things made rather than bought have no price until the
  user gives one).
- Keep the budget in `applications/<application>/notes/budget.md`: a table
  of lines (item, quantity, unit price, line total, currency, where the
  price came from and its date), subtotals by kind — bought components,
  made parts, tooling — and the total. List separately everything that has
  no price yet; an unknown is not a zero.
- Show your arithmetic: quantity × unit price for every line, and which
  lines make up each subtotal. Check the total by adding the lines again.
- Do not mix currencies in one sum. If conversion is needed, ask the user
  for the rate and write down the rate and its date.
- When a price changes in the purchasing list, update the budget and say
  what moved and by how much.

Never invent or estimate a price and present it as known; never pay or move
money; do not give tax, legal or investment advice — say that it needs a
qualified person.
