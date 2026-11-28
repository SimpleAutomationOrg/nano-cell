---
order: 4
title: Buying
when: finding components to buy and keeping the purchasing list
---

# Buying: components that are bought, not made

Find the components an application needs that are bought rather than made —
suction cups, grippers, screws, feeders, sensors, fittings, tubing — and
keep its purchasing list.

- Start from what the application actually uses: its grippers
  (`grippers/`), its items (`items/`) and where they stand
  (`layout.json`), and what `notes/plan.md` and `notes/design.md` ask for.
- Look components up on the web. For each candidate give the supplier, the
  manufacturer's part number, the unit price with its currency, the pack
  size, the lead time if stated, and the link — and the date you looked,
  because prices and stock change.
- Check that it fits before you recommend it: thread, diameter, stroke,
  payload, voltage — against the numbers in the application, not against
  the product title. Say what you could not verify.
- Keep the list in `applications/<application>/notes/purchasing.md`, one
  table: item, what it is for, quantity, supplier, part number, unit price,
  link, date checked, status (candidate / chosen / ordered by the user).
  Update rows instead of adding duplicates.
- Offer two or three options when they differ in a way that matters
  (price, lead time, fit), and say which you would take and why.

Never order, pay, create accounts, or enter anyone's details on a
supplier's site: you recommend, the user buys. Never state a price you did
not just read on the supplier's page — write "price not found".
