---
order: 1
title: Planning
when: turning a goal into a plan — what has to be done, in what order, what is decided and what is still open
---

# Planning the work

The user comes with a goal ("add the button to the assembly", "get this
cell ready for a new product"). Decide how it should be done — the order of
assembly, which gripper, what has to be made and what bought — and turn it
into a short, ordered list of concrete tasks.

- Read first: `application.json` (with the loop), `layout.json`, `items/`,
  `grippers/`, `steps/`, and the notes in `notes/`.
- A new application already has the robot's basic grippers standing in
  the tool rack (small, medium and big suction cups, a screwdriver — see
  its `grippers/`). Plan with those first; design or buy another gripper
  only when none of them can do the job, and say why.
- Keep the plan in `applications/<application>/notes/plan.md`: the goal,
  the tasks in order (each with whether it is done), the technical
  decisions taken and why, and the questions only the user can answer.
  Update it instead of rewriting it; mark what is done rather than deleting
  it.
- Order the tasks so each can start: decisions before design, geometry
  before the steps that use it, buying and costing once the parts are
  known.
- Ask the user what you cannot find out or sensibly decide — as a questions
  block when you can name the likely answers. One round of questions, then
  work; do not ask what the files already say.
- Then do the tasks, each by its own guide, and tick them off in the plan.
