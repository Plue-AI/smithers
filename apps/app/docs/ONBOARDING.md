# First run

Get started for free opens the app immediately and keeps the landing URL. A signed-out cloud visitor meets the signup in the transcript first (`state/Signup.ts`: hero, GitHub sign-in, account name with Full name prefilled from GitHub, the repository question (one button per GitHub repository, plus Skip), ready; each step shows only itself); its stage persists on `session.signup` and Start Automating closes it. Signed-out visitors use the practice repository behind it; signed-in visitors retain their existing selection.

The first app screen is one card, the setup checklist (`cards/SetupChecklist.tsx`): Talk to Smithers → Connect GitHub → Add a repository → Set up a job. The cloud web app omits Connect GitHub because the signup was the GitHub sign-in. Each step checks off from live state; Talk to Smithers is `chat.open` with a ⌘K key chip and checks off once the conversation holds a message from the person. The last step is the repository's job tiles. Every button dispatches its flow. Dismissal persists `firstRunDismissed`; no card row is stored.

First-sight hints use `HelpBubble` and persist IDs in `hintsSeen`. Only the first unseen visible control in DOM order shows a hint. Dismissal or using its control retires it. Touch copy omits shortcuts. Hints never take focus.

There is no lesson sequence or replay flow. Legacy session `guide` fields are stripped on parse. Practice repositories, general cards, and live practice execution remain available.
