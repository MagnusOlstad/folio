// Fictional demo notes for marketing screenshots. `path` becomes a "path:" steering line.
export const notes = [
  { key: 'kickoff', path: '/projects/lumen', content: `Meeting notes: Lumen onboarding redesign kickoff

**Attendees:** Maya (design lead), Jonas (PM), Priya (engineering), Tomas (research)

## Goals
- Raise week-one activation from 34% to 50%
- Make the first session feel useful before any setup is finished

## Decisions
- Cut the signup flow from 6 steps to 3
- Replace the empty dashboard with a guided checklist
- Ship the new empty state in the October release

## Action items
- [ ] Maya: prototype the checklist pattern by Friday
- [ ] Priya: estimate analytics changes for step tracking
- [ ] Tomas: recruit five new users for a moderated test` },
  { key: 'usability', path: '/projects/lumen', content: `Lumen usability test findings, round 1

Five moderated sessions with first-time users on the checklist prototype.

## What worked
- 4 of 5 completed the three-step signup without help
- The progress ring made people want to finish the checklist

## Problems
- Two people missed the "Invite a teammate" step because it sat below the fold
- The word "workspace" confused everyone; "team space" tested better
- Nobody noticed the skip link, which is fine, but it should stay quiet

## Quote
"I like that it tells me what to do first instead of showing me a blank page."

## Next steps
Move the invite step higher, rename workspace to team space, rerun with three users.` },
  { key: 'review', path: '/projects/lumen', content: `Design review: checklist component states

Reviewed the checklist component with Priya and Jonas.

## Decisions by state
- **Default:** show three steps with a progress ring
- **Completed step:** strike through, muted text, keep visible for 24h
- **All done:** celebrate once, then collapse into the sidebar
- **Error:** inline message, never a toast

Open question: should dismissing the checklist be reversible from settings? Jonas says yes, Priya wants to confirm the cost.` },
  { key: 'norman', path: '/reading', content: `Reading notes: The Design of Everyday Things (Don Norman)

## Key ideas
- **Affordances** suggest what can be done; **signifiers** tell you where to do it.
- Good mapping makes controls match the layout of the thing they control.
- Feedback must be immediate and informative, or people assume nothing happened.
- Errors are usually design failures, not user failures.

## Why it matters for my work
The onboarding checklist needs clear signifiers. The invite step failed in testing because nothing signalled it was actionable.

## Favourite line
Design is really an act of communication, which means having a deep understanding of the person with whom the designer is communicating.` },
  { key: 'refui', path: '/reading', content: `Reading notes: Refactoring UI

Practical rules I keep coming back to:

1. Start with a feature, not a layout
2. Limit choices: pick a spacing scale and stick to it
3. Hierarchy comes from size, weight and colour, not just size
4. De-emphasise secondary content instead of emphasising everything
5. Use shadows to suggest elevation, borders only when needed

> Don't use grey text on a coloured background; pick a hand-tuned shade instead.

Applied this week to the Lumen dashboard cards, which finally look calm.` },
  { key: 'inclusive', path: '/reading', content: `Reading notes: Inclusive Design Principles

- Provide comparable experience: the same task should be possible by any route
- Consider situation: bright sunlight, one hand, noisy room
- Be consistent: use familiar patterns
- Give control: let people choose how they interact
- Offer choice, prioritise content, add value

Takeaway: design for permanent, temporary and situational limits. A person carrying a toddler has the same one-handed constraint as someone with a broken arm.` },
  { key: 'pasta', path: '/life/recipes', content: `Recipe: Miso butter pasta

Serves 2, 20 minutes.

## Ingredients
- 200 g spaghetti
- 2 tbsp white miso
- 3 tbsp butter
- 2 garlic cloves, thinly sliced
- Black pepper, chives, grated parmesan

## Method
1. Boil pasta in salted water, reserve a cup of the cooking water.
2. Melt butter, soften garlic, whisk in miso with a splash of pasta water.
3. Toss pasta in the sauce until glossy, loosening with more water.
4. Finish with pepper, chives and parmesan.

Tip: do not boil the miso, it loses its depth.` },
  { key: 'bread', path: '/life/recipes', content: `Recipe: Weekend sourdough, 75% hydration

- 400 g bread flour
- 300 g water
- 80 g active starter
- 9 g salt

Mix, rest 30 minutes, fold every 30 minutes four times, bulk ferment about 5 hours at 24 C. Shape, proof overnight in the fridge, bake at 245 C in a Dutch oven for 20 minutes covered and 20 uncovered.

Notes: the crumb was tighter last time because the starter was not at peak. Feed it 6 hours before mixing.` },
  { key: 'lisbon', path: '/life/travel', content: `Trip plan: Lisbon in November

**Dates:** Nov 14 to Nov 19, flying from Oslo

## Stay
Alfama apartment, booked through the 17th, extend if possible.

## Ideas
- Morning walk up to Miradouro da Senhora do Monte
- Day trip to Sintra, go early to beat the crowds
- Pastéis de nata at a place that is not the famous one
- Visit the design museum (MAAT) and the tile museum

## Packing
Light rain jacket, comfortable shoes, power adapter, sketchbook.` },
  { key: 'tokens', path: '/reference', content: `Reference: Design token naming convention

We name tokens by role, not by value.

\`\`\`
color.text.primary
color.text.muted
color.surface.raised
space.2  space.4  space.8
radius.control  radius.card
\`\`\`

## Rules
- Never put a hex value in a component
- Alias semantic tokens to a small base palette
- Dark mode swaps the alias, never the component
- Spacing scale: 4, 8, 12, 16, 24, 32, 48` },
  { key: 'contrast', path: '/reference', content: `Reference: Accessibility contrast checklist

## Minimum contrast ratios
- **Body text:** 4.5 : 1
- **Large text (18pt and up):** 3 : 1
- **UI components and icons:** 3 : 1
- **Focus indicators:** 3 : 1 against neighbours

## Quick checks
- Do not rely on colour alone to convey state
- Test in both light and dark themes
- Every interactive element has a visible focus ring
- Minimum touch target 44 by 44 px` },
  { key: 'type', path: '/reference', content: `Reference: Type scale for product UI

Base 16 px, ratio 1.2 (minor third).

- Caption 12 px
- Body 16 px
- Subheading 19 px
- Heading 23 px
- Display 33 px

Line height 1.5 for body, 1.2 for headings. Keep line length between 60 and 75 characters. Use two weights only: regular and semibold.` },
  { key: 'todo', content: `todo: Send Lumen test summary to Jonas and Priya\nBook the Lisbon flights before prices go up\nRename "workspace" to "team space" in the prototype` },
  { key: 'daily', content: `daily: Ran the second Lumen usability session this morning. The new invite step placement worked. Spent the afternoon refining checklist states and sketching the Lisbon itinerary.` },
]
