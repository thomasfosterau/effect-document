---
"@thomasfosterau/effect-ooxml": patch
---

PPTX: a list item's later paragraphs now stay in the item, and adjacent ordered lists stay separate. The writer puts an item's bulleted paragraph at its level's margin (`marL`, with a hanging `indent`) and the item's later paragraphs at the same margin without a bullet, as PowerPoint does; the reader attaches an unbulleted paragraph at an open list's margin to that list's last item. Each ordered list's first item carries `startAt`, so the reader begins a new list there, and an ordered list's `start` round-trips. An item that starts with a nested list reads back without the empty bulleted paragraph the writer has to put before it.
